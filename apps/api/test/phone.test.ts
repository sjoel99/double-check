/**
 * Continuar no celular: o QR abre o nosso app no celular (não a carteira
 * direto). O celular entra com a carteira, confere a transação, confirma com a
 * biometria e só então a carteira assina. O computador acompanha pelo token.
 */
import { describe, expect, it } from "vitest";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { DevMemorySigner, passkeyBindingMessage, possessionMessage, type SoftCredential, softCreate, softGet, transactionChallenge } from "@duplachave/crypto";
import { DefaultPolicyEngine } from "@duplachave/policy-engine";
import { credentialTag, CustodyService, DevServerKeyProvider, LogNotificationService, MemoryStore, reviewPrepared, signAsWallet, verifyAuthorized } from "@duplachave/custody";
import { readMultisig } from "@duplachave/squads";
import { LiteSvmChain } from "../../../tests/support/litesvm-chain";
import { buildServer } from "../src/server";

const ORIGIN = "https://dupla.example";
const RP_ID = "dupla.example";
const SOL = BigInt(LAMPORTS_PER_SOL);
const signText = async (w: DevMemorySigner, text: string) => bs58.encode(await w.sign(new TextEncoder().encode(text)));

async function setup() {
  const chain = new LiteSvmChain();
  const service = { executor: DevMemorySigner.generate("E"), proposer: DevMemorySigner.generate("P") };
  const now = () => Math.floor(Date.now() / 1000);
  chain.warp(now() - (await chain.now()));
  const store = new MemoryStore();
  const custody = new CustodyService({ cluster: "localnet", chain, store, policy: new DefaultPolicyEngine(), serverKeys: new DevServerKeyProvider("localnet"), service, notifications: new LogNotificationService(), squadsTreasury: chain.treasury, passkeys: { origins: [ORIGIN] } });
  const app = await buildServer({ custody, store, chain, cluster: "localnet", sessionSecret: "s".repeat(64), adminToken: null, airdrop: async (a, l) => chain.airdrop(a, BigInt(l)), publicUrl: ORIGIN });
  const call = async (method: "GET" | "POST", url: string, body?: unknown, token?: string) => {
    const r = await app.inject({ method, url, payload: body as object, headers: { origin: ORIGIN, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    return { status: r.statusCode, json: r.json() as any };
  };
  return { chain, app, call, store, now };
}
type T = Awaited<ReturnType<typeof setup>>;

/** O app no celular: cadastra a carteira (paga por ela) e vincula a biometria do aparelho. */
async function phoneEnroll(t: T, wallet: DevMemorySigner) {
  const publicKey = (await wallet.publicKey()).toBase58();
  t.chain.airdrop(await wallet.publicKey(), SOL);
  const p = await t.call("POST", "/v1/enrollment/prepare", { publicKey, walletName: "Phantom (celular)" });
  const r = await t.call("POST", "/v1/enrollment/submit", { enrollmentId: p.json.enrollmentId, transaction: await signAsWallet(VersionedTransaction.deserialize(Buffer.from(p.json.transaction, "base64")), wallet) });
  const o = await t.call("POST", `/v1/accounts/${r.json.account.id}/passkeys/options`, { deviceName: "Android" }, r.json.token);
  const { credential, response } = await softCreate({ challenge: o.json.options.challenge, rpId: RP_ID, origin: ORIGIN });
  const text = passkeyBindingMessage({ publicKey, account: r.json.account.multisig, cluster: "localnet", credential: credentialTag(credential.id), device: "Android", challenge: o.json.options.challenge });
  expect((await t.call("POST", `/v1/accounts/${r.json.account.id}/passkeys`, { challengeId: o.json.challengeId, response, walletSignature: await signText(wallet, text) }, r.json.token)).json.status).toBe("ACTIVE");
  return { token: r.json.token as string, account: r.json.account, passkey: credential };
}

/** O app no celular assina uma intenção: confere, biometria, serviço assina, carteira assina. */
async function phoneSign(t: T, token: string, intentId: string, wallet: DevMemorySigner, passkey: SoftCredential) {
  const prepared = await t.call("POST", `/v1/intents/${intentId}/prepare`, {}, token);
  const review = await reviewPrepared(t.chain, prepared.json, await wallet.publicKey(), t.now());
  const assertion = await softGet(passkey, { challenge: await transactionChallenge(review.message), rpId: RP_ID, origin: ORIGIN });
  const auth = await t.call("POST", `/v1/intents/${intentId}/authorize`, { message: Buffer.from(review.message).toString("base64"), assertion }, token);
  return t.call("POST", `/v1/intents/${intentId}/submit`, { transaction: await signAsWallet(verifyAuthorized(review, auth.json.transaction), wallet) }, token);
}

const tokenOf = (url: string) => url.split("/#/m/")[1]!;

describe("continuar no celular", () => {
  it("o QR abre o nosso app (HTTPS), não a carteira; entrar pelo celular entrega a sessão ao computador", async () => {
    const t = await setup();
    const qr = await t.call("POST", "/v1/pay/connect");
    expect(qr.json.url).toMatch(/^https:\/\/dupla\.example\/#\/m\/[0-9a-f]{48}$/);
    const token = tokenOf(qr.json.url);
    expect((await t.call("GET", `/v1/handoff/${token}`)).json.kind).toBe("CONNECT");
    const wallet = DevMemorySigner.generate("PHANTOM_MOBILE");
    const phone = await phoneEnroll(t, wallet);
    expect((await t.call("POST", `/v1/handoff/${token}/claim`, { accountId: phone.account.id }, phone.token)).status).toBe(200);
    const st = await t.call("GET", `/v1/pay/${token}`);
    expect(st.json.status).toBe("DONE");
    expect((await t.call("GET", `/v1/accounts/${phone.account.id}/security`, undefined, st.json.result.sessionToken)).status).toBe(200);
    expect((await t.call("POST", `/v1/handoff/${token}/claim`, { accountId: phone.account.id }, phone.token)).json.error).toBe("PAY_USED");
  });

  it("assinatura pelo celular: o computador vê EXECUTED; sem a biometria o serviço não assina", async () => {
    const t = await setup();
    const wallet = DevMemorySigner.generate("PHANTOM_MOBILE");
    const phone = await phoneEnroll(t, wallet);
    t.chain.airdrop(new PublicKey(phone.account.vault), 5n * SOL);
    const to = Keypair.generate().publicKey.toBase58();
    const intent = await t.call("POST", `/v1/accounts/${phone.account.id}/intents`, { type: "TRANSFER_SOL", destination: to, amountSol: "2" }, phone.token);
    const qr = await t.call("POST", `/v1/intents/${intent.json.intent.id}/pay`, {}, phone.token);
    const token = tokenOf(qr.json.url);
    const info = await t.call("GET", `/v1/handoff/${token}`);
    expect(info.json).toMatchObject({ kind: "SIGN_INTENT", intentId: intent.json.intent.id });
    expect(info.json.label).toBe(`Enviar 2 SOL para ${to.slice(0, 4)}…${to.slice(-4)}`);

    // Sem biometria válida (desafio de outra mensagem): o serviço não assina.
    const prepared = await t.call("POST", `/v1/intents/${intent.json.intent.id}/prepare`, {}, phone.token);
    const bogus = await softGet(phone.passkey, { challenge: await transactionChallenge(new Uint8Array([9])), rpId: RP_ID, origin: ORIGIN });
    const review = await reviewPrepared(t.chain, prepared.json, await wallet.publicKey(), t.now());
    expect((await t.call("POST", `/v1/intents/${intent.json.intent.id}/authorize`, { message: Buffer.from(review.message).toString("base64"), assertion: bogus }, phone.token)).json.error).toBe("PASSKEY_INVALID");

    expect((await t.call("GET", `/v1/pay/${token}`)).json.status).toBe("WAITING");
    expect((await phoneSign(t, phone.token, intent.json.intent.id, wallet, phone.passkey)).json.status).toBe("EXECUTED");
    expect((await t.call("GET", `/v1/pay/${token}`)).json).toMatchObject({ status: "DONE", result: { status: "EXECUTED" } });
    expect(await t.chain.getBalance(new PublicKey(to))).toBe(2n * SOL);
  });

  it("troca de carteira pelo celular: a nova prova posse assinando texto (sem custo); a atual assina a troca", async () => {
    const t = await setup();
    const wallet = DevMemorySigner.generate("PHANTOM_MOBILE");
    const phone = await phoneEnroll(t, wallet);
    const rot = await t.call("POST", `/v1/accounts/${phone.account.id}/rotations/client`, {}, phone.token);
    const qr = await t.call("POST", `/v1/rotations/${rot.json.rotationId}/pay-proof`, {}, phone.token);
    const token = tokenOf(qr.json.url);
    const info = await t.call("GET", `/v1/handoff/${token}`);
    const next = DevMemorySigner.generate("NOVA"); // sem SOL nenhum
    const fields = { ...info.json.fields, publicKey: (await next.publicKey()).toBase58() };
    expect((await t.call("POST", `/v1/handoff/${token}/proof`, { proof: { ...fields, signature: await signText(next, possessionMessage(fields)) } })).status).toBe(200);
    const done = await t.call("GET", `/v1/pay/${token}`);
    expect(done.json.status).toBe("DONE");

    expect((await phoneSign(t, phone.token, done.json.result.intentId, wallet, phone.passkey)).json.status).toBe("EXECUTED");
    const state = await readMultisig(t.chain, new PublicKey(phone.account.multisig));
    expect(state.members.some((m) => m.key === fields.publicKey)).toBe(true);
    expect((await t.call("GET", `/v1/accounts/${phone.account.id}/security`, undefined, phone.token)).status).toBe(401); // sessão antiga morreu
  });

  it("QR sem pedido não existe; biometria de uma origem não permitida é recusada", async () => {
    const t = await setup();
    expect((await t.call("GET", "/v1/handoff/naoexiste")).json.error).toBe("PAY_NOT_FOUND");
    const wallet = DevMemorySigner.generate("W");
    const phone = await phoneEnroll(t, wallet);
    const r = await t.app.inject({ method: "POST", url: `/v1/accounts/${phone.account.id}/passkeys/options`, payload: { deviceName: "x" }, headers: { origin: "https://phishing.test", authorization: `Bearer ${phone.token}` } });
    expect(r.json().error).toBe("ORIGIN_NOT_ALLOWED");
  });
});
