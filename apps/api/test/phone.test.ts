/**
 * Assinatura pelo celular (Solana Pay transaction request), com um "celular"
 * que faz o que a Phantom faz: GET (rótulo/ícone), POST { account }, assina a
 * transação recebida (paga por ela) e a envia ele mesmo. O serviço não tem SOL.
 */
import { describe, expect, it } from "vitest";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { DevMemorySigner } from "@duplachave/crypto";
import { DefaultPolicyEngine } from "@duplachave/policy-engine";
import { reviewPrepared, CustodyService, DevServerKeyProvider, LogNotificationService, MemoryStore } from "@duplachave/custody";
import { readMultisig } from "@duplachave/squads";
import { LiteSvmChain } from "../../../tests/support/litesvm-chain";
import { buildServer } from "../src/server";

async function setup() {
  const chain = new LiteSvmChain();
  const service = { executor: DevMemorySigner.generate("E"), proposer: DevMemorySigner.generate("P") };
  const now = () => Math.floor(Date.now() / 1000);
  chain.warp(now() - (await chain.now()));
  const store = new MemoryStore();
  const custody = new CustodyService({ cluster: "localnet", chain, store, policy: new DefaultPolicyEngine(), serverKeys: new DevServerKeyProvider("localnet"), service, notifications: new LogNotificationService(), squadsTreasury: chain.treasury });
  const app = await buildServer({
    custody, store, chain, cluster: "localnet", sessionSecret: "s".repeat(64), adminToken: null,
    airdrop: async (a, l) => chain.airdrop(a, BigInt(l)), publicUrl: "https://dupla.example",
  });
  const call = async (method: "GET" | "POST", url: string, body?: unknown, token?: string) => {
    const r = await app.inject({ method, url, payload: body as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, json: r.json() as any };
  };

  /** O celular: lê o link do QR, busca a transação, assina e envia. */
  const phone = async (link: string, wallet: DevMemorySigner) => {
    expect(link.startsWith("solana:")).toBe(true);
    const url = new URL(decodeURIComponent(link.slice("solana:".length)));
    expect(url.protocol).toBe("https:");
    const meta = await call("GET", url.pathname);
    expect(meta.json.label).toMatch(/^Dupla Chave · /);
    const r = await call("POST", url.pathname, { account: (await wallet.publicKey()).toBase58() });
    if (r.status !== 200) return { error: r.json.error as string, message: "" };
    const tx = VersionedTransaction.deserialize(Buffer.from(r.json.transaction, "base64"));
    tx.addSignature(await wallet.publicKey(), await wallet.sign(tx.message.serialize()));
    await chain.sendTransaction(tx);
    await app.pay.tick();
    return { error: null, message: r.json.message as string };
  };

  return { chain, app, call, phone, store, now };
}

async function connect(t: Awaited<ReturnType<typeof setup>>, wallet = DevMemorySigner.generate("PHANTOM_MOBILE")) {
  if ((await t.chain.getBalance(await wallet.publicKey())) === 0n) t.chain.airdrop(await wallet.publicKey(), BigInt(LAMPORTS_PER_SOL));
  const qr = await t.call("POST", "/v1/pay/connect");
  const out = await t.phone(qr.json.link, wallet);
  expect(out.error).toBeNull();
  const st = await t.call("GET", `/v1/pay/${qr.json.token}`);
  expect(st.json.status).toBe("DONE");
  return { wallet, token: st.json.result.sessionToken as string, accountId: st.json.result.accountId as string, created: st.json.result.created as boolean, message: out.message };
}

describe("celular (Solana Pay)", () => {
  it("cadastro pelo QR: memo de vínculo + criação da multisig numa transação assinada pela carteira", async () => {
    const t = await setup();
    const c = await connect(t);
    expect(c.created).toBe(true);
    expect(c.message).toContain("Criar sua conta");
    const sec = await t.call("GET", `/v1/accounts/${c.accountId}/security`, undefined, c.token);
    const state = await readMultisig(t.chain, new PublicKey(sec.json.account.multisig));
    expect(state.members.find((m) => m.key === (c.wallet as any).toJSON().publicKey)?.mask).toBe(6);
  });

  it("mesma carteira de novo: entra (memo de entrada), não cria outra conta", async () => {
    const t = await setup();
    const first = await connect(t);
    const again = await connect(t, first.wallet);
    expect(again.created).toBe(false);
    expect(again.accountId).toBe(first.accountId);
  });

  it("transação pelo QR: o celular aprova e executa; outra carteira não consegue", async () => {
    const t = await setup();
    const c = await connect(t);
    const sec = await t.call("GET", `/v1/accounts/${c.accountId}/security`, undefined, c.token);
    t.chain.airdrop(new PublicKey(sec.json.account.vault), 5n * BigInt(LAMPORTS_PER_SOL));
    const to = Keypair.generate().publicKey.toBase58();
    const intent = await t.call("POST", `/v1/accounts/${c.accountId}/intents`, { type: "TRANSFER_SOL", destination: to, amountSol: "2" }, c.token);
    const qr = await t.call("POST", `/v1/intents/${intent.json.intent.id}/pay`, {}, c.token);

    expect((await t.phone(qr.json.link, DevMemorySigner.generate("OUTRA"))).error).toBe("WRONG_WALLET");
    const label = await t.call("GET", new URL(decodeURIComponent(qr.json.link.slice(7))).pathname);
    expect(label.json.label).toBe(`Dupla Chave · Enviar 2 SOL para ${to.slice(0, 4)}…${to.slice(-4)}`);
    const out = await t.phone(qr.json.link, c.wallet);
    expect(out.message).toContain("Aprovar e executar");
    expect((await t.call("GET", `/v1/pay/${qr.json.token}`)).json.result.status).toBe("EXECUTED");
    expect(await t.chain.getBalance(new PublicKey(to))).toBe(2n * BigInt(LAMPORTS_PER_SOL));
    expect((await t.call("GET", `/v1/intents/${intent.json.intent.id}`, undefined, c.token)).json.record.status).toBe("EXECUTED");
  });

  it("troca de carteira pelo QR: a nova prova posse por memo, o app confere a prova, a atual assina", async () => {
    const t = await setup();
    const c = await connect(t);
    const rot = await t.call("POST", `/v1/accounts/${c.accountId}/rotations/client`, {}, c.token);
    const proofQr = await t.call("POST", `/v1/rotations/${rot.json.rotationId}/pay-proof`, {}, c.token);
    const next = DevMemorySigner.generate("NOVA");
    expect((await t.phone(proofQr.json.link, c.wallet)).error).toBe("SAME_WALLET");
    // A prova é uma transação: a carteira nova paga a taxa dela (0,000005 SOL).
    expect((await t.phone(proofQr.json.link, next)).error).toBe("NEW_WALLET_NO_SOL");
    t.chain.airdrop(await next.publicKey(), 10_000_000n);
    const before = await t.chain.getBalance(await next.publicKey());
    expect((await t.phone(proofQr.json.link, next)).error).toBeNull();
    expect(before - (await t.chain.getBalance(await next.publicKey()))).toBe(5000n);
    const done = await t.call("GET", `/v1/pay/${proofQr.json.token}`);
    expect(done.json.status).toBe("DONE");
    const intentId = done.json.result.intentId;

    // O app confere a prova feita por transação (memo + assinatura da carteira nova).
    const prepared = await t.call("POST", `/v1/intents/${intentId}/prepare`, {}, c.token);
    expect(prepared.json.possession.via).toBe("transaction");
    await reviewPrepared(t.chain, prepared.json, await c.wallet.publicKey(), t.now());

    const signQr = await t.call("POST", `/v1/intents/${intentId}/pay`, {}, c.token);
    expect((await t.phone(signQr.json.link, c.wallet)).error).toBeNull();
    expect((await t.call("GET", `/v1/pay/${signQr.json.token}`)).json.result.status).toBe("EXECUTED");
    const state = await readMultisig(t.chain, new PublicKey(prepared.json.intent.multisig));
    expect(state.members.some((m) => m.key === (next as any).toJSON().publicKey)).toBe(true);
    expect((await t.call("GET", `/v1/accounts/${c.accountId}/security`, undefined, c.token)).status).toBe(401); // sessão antiga morreu
  });

  it("QR usado não serve de novo; QR sem pedido não existe", async () => {
    const t = await setup();
    const qr = await t.call("POST", "/v1/pay/connect");
    const w = DevMemorySigner.generate("W");
    t.chain.airdrop(await w.publicKey(), BigInt(LAMPORTS_PER_SOL));
    await t.phone(qr.json.link, w);
    const path = new URL(decodeURIComponent(qr.json.link.slice(7))).pathname;
    expect((await t.call("POST", path, { account: (await w.publicKey()).toBase58() })).json.error).toBe("PAY_USED");
    expect((await t.call("GET", "/pay/naoexiste")).json.error).toBe("PAY_NOT_FOUND");
  });
});
