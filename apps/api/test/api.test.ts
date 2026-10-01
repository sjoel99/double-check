import { describe, expect, it } from "vitest";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { DevMemorySigner, passkeyBindingMessage, possessionMessage, type SoftCredential, softCreate, softGet, transactionChallenge } from "@duplachave/crypto";
import { DefaultPolicyEngine } from "@duplachave/policy-engine";
import { credentialTag, CustodyService, DevServerKeyProvider, LogNotificationService, MemoryStore, reviewPrepared, signAsWallet, verifyAuthorized } from "@duplachave/custody";
import { LiteSvmChain } from "../../../tests/support/litesvm-chain";
import { buildServer, solToLamports } from "../src/server";

const ORIGIN = "https://app.test";
const RP_ID = "app.test";
const passkeys = new Map<string, SoftCredential>();

async function setup() {
  const chain = new LiteSvmChain();
  const service = { executor: DevMemorySigner.generate("E"), proposer: DevMemorySigner.generate("P") };
  const now = () => Math.floor(Date.now() / 1000);
  chain.warp(now() - (await chain.now()));
  const store = new MemoryStore();
  const custody = new CustodyService({ cluster: "localnet", chain, store, policy: new DefaultPolicyEngine(), serverKeys: new DevServerKeyProvider("localnet"), service, notifications: new LogNotificationService(), squadsTreasury: chain.treasury, passkeys: { origins: [ORIGIN] } });
  const app = await buildServer({
    custody, store, chain, cluster: "localnet", sessionSecret: "s".repeat(64), adminToken: "admin-token-123456",
    airdrop: async (a, l) => chain.airdrop(a, BigInt(l)),
  });
  const call = async (method: "GET" | "POST", url: string, body?: unknown, token?: string, headers: Record<string, string> = {}) => {
    const r = await app.inject({ method, url, payload: body as object, headers: { origin: ORIGIN, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
    return { status: r.statusCode, json: r.json() as any };
  };
  return { chain, app, call, now, store, service };
}

const signText = async (w: DevMemorySigner, text: string) => bs58.encode(await w.sign(new TextEncoder().encode(text)));

const fromB64 = (b64: string) => VersionedTransaction.deserialize(Buffer.from(b64, "base64"));

/** "Conectar carteira" + assinar a criação da conta (paga pela carteira), como a Phantom faria. */
async function enroll(t: Awaited<ReturnType<typeof setup>>, wallet = DevMemorySigner.generate("PHANTOM")) {
  const publicKey = (await wallet.publicKey()).toBase58();
  t.chain.airdrop(await wallet.publicKey(), BigInt(LAMPORTS_PER_SOL));
  const p = await t.call("POST", "/v1/enrollment/prepare", { publicKey, walletName: "Phantom" });
  expect(p.status).toBe(200);
  expect(p.json.memo).toContain("criar sua conta 2 de 2");
  const r = await t.call("POST", "/v1/enrollment/submit", { enrollmentId: p.json.enrollmentId, transaction: await signAsWallet(fromB64(p.json.transaction), wallet) });
  expect(r.status).toBe(200);
  await addPasskey(t, r.json.token, r.json.account, wallet);
  return { wallet, token: r.json.token as string, account: r.json.account };
}

/** Biometria de teste: cria a passkey, a carteira assina o vínculo. */
async function addPasskey(t: Awaited<ReturnType<typeof setup>>, token: string, account: { id: string; multisig: string; roles: { client: string } }, wallet: DevMemorySigner) {
  const o = await t.call("POST", `/v1/accounts/${account.id}/passkeys/options`, { deviceName: "Celular" }, token);
  expect(o.status).toBe(200);
  const { credential, response } = await softCreate({ challenge: o.json.options.challenge, rpId: RP_ID, origin: ORIGIN });
  const text = passkeyBindingMessage({ publicKey: account.roles.client, account: account.multisig, cluster: "localnet", credential: credentialTag(credential.id), device: "Celular", challenge: o.json.options.challenge });
  const r = await t.call("POST", `/v1/accounts/${account.id}/passkeys`, { challengeId: o.json.challengeId, response, walletSignature: await signText(wallet, text) }, token);
  expect(r.json.status).toBe("ACTIVE");
  passkeys.set(account.id, credential);
}

async function signIntent(t: Awaited<ReturnType<typeof setup>>, token: string, intentId: string, wallet: DevMemorySigner) {
  const prepared = await t.call("POST", `/v1/intents/${intentId}/prepare`, {}, token);
  const review = await reviewPrepared(t.chain, prepared.json, await wallet.publicKey(), t.now());
  const assertion = await softGet(passkeys.get(prepared.json.intent.multisig ? (await t.store.getIntent(intentId))!.accountId : "")!, { challenge: await transactionChallenge(review.message), rpId: RP_ID, origin: ORIGIN });
  const auth = await t.call("POST", `/v1/intents/${intentId}/authorize`, { message: Buffer.from(review.message).toString("base64"), assertion }, token);
  expect(auth.status).toBe(200);
  return t.call("POST", `/v1/intents/${intentId}/submit`, { transaction: await signAsWallet(verifyAuthorized(review, auth.json.transaction), wallet) }, token);
}

describe("API", () => {
  it("solToLamports não usa float e recusa milhar", () => {
    expect(solToLamports("1,5")).toBe("1500000000");
    expect(solToLamports("0.000000001")).toBe("1");
    expect(() => solToLamports("1.000,00")).toThrow();
  });

  it("cadastro com a carteira → envio → carteira assina uma vez → executado", async () => {
    const t = await setup();
    const { wallet, token, account } = await enroll(t);
    await t.call("POST", "/v1/dev/airdrop", { address: account.vault, sol: 5 });
    const to = Keypair.generate().publicKey.toBase58();
    const created = await t.call("POST", `/v1/accounts/${account.id}/intents`, { type: "TRANSFER_SOL", destination: to, amountSol: "1,25" }, token);
    expect(created.status).toBe(200);
    expect(created.json.display.rows[0].value).toBe("1,25 SOL");
    const done = await signIntent(t, token, created.json.intent.id, wallet);
    expect(done.json.status).toBe("EXECUTED");
    expect(await t.chain.getBalance(new PublicKey(to))).toBe(1_250_000_000n);
  });

  it("sessão não substitui assinatura: transação assinada por outra chave é recusada", async () => {
    const t = await setup();
    const { token, account } = await enroll(t);
    await t.call("POST", "/v1/dev/airdrop", { address: account.vault, sol: 5 });
    const created = await t.call("POST", `/v1/accounts/${account.id}/intents`, { type: "TRANSFER_SOL", destination: Keypair.generate().publicKey.toBase58(), amountSol: "1" }, token);
    const intruder = DevMemorySigner.generate("X");
    const prepared = await t.call("POST", `/v1/intents/${created.json.intent.id}/prepare`, {}, token);
    await expect(reviewPrepared(t.chain, prepared.json, await intruder.publicKey(), t.now())).rejects.toThrow(/NOT_A_VOTER/);
    // Assinando mesmo assim (no lugar da carteira): o backend recusa.
    const forged = fromB64(prepared.json.transaction);
    forged.signatures[0] = await intruder.sign(forged.message.serialize());
    const r = await t.call("POST", `/v1/intents/${created.json.intent.id}/submit`, { transaction: Buffer.from(forged.serialize()).toString("base64") }, token);
    expect(r.json.error).toBe("WALLET_BAD_SIGNATURE");
  });

  it("o serviço não paga nada: sem pagador na configuração e sem rota de depósito pago", async () => {
    const t = await setup();
    expect((await t.call("GET", "/v1/config")).json.feePayer).toBeUndefined();
    const { token, account } = await enroll(t);
    expect((await t.call("POST", `/v1/accounts/${account.id}/deposit`, { transaction: "x".repeat(200) }, token)).status).toBe(404);
    for (const key of [t.service.executor, t.service.proposer]) expect(await t.chain.getBalance(await key.publicKey())).toBe(0n);
  });

  it("/v1/config não indica RPC ao app; lista de rotações não expõe o desafio", async () => {
    const t = await setup();
    expect((await t.call("GET", "/v1/config")).json.rpcUrl).toBeUndefined();
    const { token, account } = await enroll(t);
    await t.call("POST", `/v1/accounts/${account.id}/rotations/client`, {}, token);
    const list = await t.call("GET", `/v1/accounts/${account.id}/rotations`, undefined, token);
    expect(list.json.rotations[0].challenge).toBeUndefined();
  });

  it("sem sessão: 401; conta de outro: 403", async () => {
    const t = await setup();
    const a = await enroll(t);
    const b = await enroll(t);
    expect((await t.call("GET", `/v1/accounts/${a.account.id}/security`)).status).toBe(401);
    expect((await t.call("GET", `/v1/accounts/${a.account.id}/security`, undefined, b.token)).status).toBe(403);
    expect((await t.call("GET", `/v1/accounts/${a.account.id}/security`, undefined, a.token)).json.invariantOk).toBe(true);
  });

  it("troca de carteira pela API: a nova prova posse, a atual aprova; sessão antiga morre e a nova entra", async () => {
    const t = await setup();
    const { wallet, token, account } = await enroll(t);
    const rot = await t.call("POST", `/v1/accounts/${account.id}/rotations/client`, { newWalletName: "Backpack" }, token);
    const next = DevMemorySigner.generate("BACKPACK");
    const nextPk = (await next.publicKey()).toBase58();
    const fields = { ...rot.json.fields, publicKey: nextPk };
    const proof = await t.call("POST", `/v1/rotations/${rot.json.rotationId}/proof`, { proof: { ...fields, signature: await signText(next, possessionMessage(fields)) } }, token);
    expect(proof.status).toBe(200);
    expect((await signIntent(t, token, proof.json.intent.id, wallet)).json.status).toBe("EXECUTED");

    expect((await t.call("GET", `/v1/accounts/${account.id}/security`, undefined, token)).status).toBe(401);
    const ch = await t.call("POST", "/v1/auth/challenge", { publicKey: nextPk });
    const login = await t.call("POST", "/v1/auth/verify", { challengeId: ch.json.challengeId, publicKey: nextPk, signature: await signText(next, ch.json.message) });
    expect(login.status).toBe(200);
    expect((await t.call("GET", `/v1/accounts/${account.id}/security`, undefined, login.json.token)).json.account.roles.client).toBe(nextPk);

    const old = await t.call("POST", "/v1/auth/challenge", { publicKey: (await wallet.publicKey()).toBase58() });
    const denied = await t.call("POST", "/v1/auth/verify", { challengeId: old.json.challengeId, publicKey: (await wallet.publicKey()).toBase58(), signature: await signText(wallet, old.json.message) });
    expect(denied.json.error).toBe("KEY_REVOKED");
  });

  it("rotação do servidor só com token de admin, e ainda depende da carteira", async () => {
    const t = await setup();
    const { token, account } = await enroll(t);
    expect((await t.call("POST", `/v1/admin/accounts/${account.id}/rotations/server`, { reason: "x" })).status).toBe(401);
    const r = await t.call("POST", `/v1/admin/accounts/${account.id}/rotations/server`, { reason: "trimestral" }, undefined, { "x-admin-token": "admin-token-123456" });
    expect(r.json.rotation.status).toBe("AWAITING_CLIENT_APPROVAL");
    const intents = await t.call("GET", `/v1/accounts/${account.id}/intents`, undefined, token);
    expect(intents.json.intents[0].intent.type).toBe("ROTATE_MEMBER");
  });
});
