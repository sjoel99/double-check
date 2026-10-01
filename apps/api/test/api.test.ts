import { describe, expect, it } from "vitest";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { DevMemorySigner, possessionMessage } from "@duplachave/crypto";
import { DefaultPolicyEngine } from "@duplachave/policy-engine";
import { buildWalletTransaction, CustodyService, DevServerKeyProvider, LogNotificationService, MemoryStore, signAsWallet } from "@duplachave/custody";
import { LiteSvmChain } from "../../../tests/support/litesvm-chain";
import { buildServer, solToLamports } from "../src/server";

async function setup() {
  const chain = new LiteSvmChain();
  const service = { executor: DevMemorySigner.generate("E"), proposer: DevMemorySigner.generate("P"), feePayer: DevMemorySigner.generate("F") };
  chain.airdrop(await service.feePayer.publicKey(), 100n * BigInt(LAMPORTS_PER_SOL));
  const now = () => Math.floor(Date.now() / 1000);
  chain.warp(now() - (await chain.now()));
  const store = new MemoryStore();
  const custody = new CustodyService({ cluster: "localnet", chain, store, policy: new DefaultPolicyEngine(), serverKeys: new DevServerKeyProvider("localnet"), service, notifications: new LogNotificationService(), squadsTreasury: chain.treasury });
  const app = await buildServer({
    custody, store, chain, cluster: "localnet", sessionSecret: "s".repeat(64), adminToken: "admin-token-123456",
    feePayer: (await service.feePayer.publicKey()).toBase58(),
    signAsFeePayer: (m) => service.feePayer.sign(m),
    airdrop: async (a, l) => chain.airdrop(a, BigInt(l)),
  });
  const call = async (method: "GET" | "POST", url: string, body?: unknown, token?: string, headers: Record<string, string> = {}) => {
    const r = await app.inject({ method, url, payload: body as object, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
    return { status: r.statusCode, json: r.json() as any };
  };
  return { chain, app, call, now, store, service };
}

const signText = async (w: DevMemorySigner, text: string) => bs58.encode(await w.sign(new TextEncoder().encode(text)));

/** "Conectar carteira" + assinar o texto de vínculo, como a Phantom faria. */
async function enroll(t: Awaited<ReturnType<typeof setup>>, wallet = DevMemorySigner.generate("PHANTOM")) {
  const publicKey = (await wallet.publicKey()).toBase58();
  const ch = await t.call("POST", "/v1/enrollment/challenge", { publicKey });
  expect(ch.json.message).toContain("Vincular esta carteira");
  const r = await t.call("POST", "/v1/enrollment", { challengeId: ch.json.challengeId, publicKey, signature: await signText(wallet, ch.json.message), walletName: "Phantom" });
  expect(r.status).toBe(200);
  return { wallet, token: r.json.token as string, account: r.json.account };
}

async function signIntent(t: Awaited<ReturnType<typeof setup>>, token: string, intentId: string, wallet: DevMemorySigner) {
  const got = await t.call("GET", `/v1/intents/${intentId}`, undefined, token);
  const { transaction } = await buildWalletTransaction({ chain: t.chain, request: got.json.approvalRequest, wallet: await wallet.publicKey(), now: t.now() });
  return t.call("POST", `/v1/intents/${intentId}/sign`, { transaction: await signAsWallet(transaction, wallet) }, token);
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
    const got = await t.call("GET", `/v1/intents/${created.json.intent.id}`, undefined, token);
    await expect(buildWalletTransaction({ chain: t.chain, request: got.json.approvalRequest, wallet: await intruder.publicKey(), now: t.now() })).rejects.toThrow(/NOT_A_VOTER/);
    const r = await signIntent(t, token, created.json.intent.id, intruder).catch(() => null);
    expect(r).toBeNull();
  });

  it("depósito da carteira para o Vault: só aceita transferência da carteira da conta para o Vault dela", async () => {
    const t = await setup();
    const { wallet, token, account } = await enroll(t);
    const pk = await wallet.publicKey();
    t.chain.airdrop(pk, 3n * BigInt(LAMPORTS_PER_SOL));
    const mk = async (to: PublicKey) => {
      const msg = new TransactionMessage({ payerKey: await t.service.feePayer.publicKey(), recentBlockhash: await t.chain.getLatestBlockhash(), instructions: [SystemProgram.transfer({ fromPubkey: pk, toPubkey: to, lamports: BigInt(LAMPORTS_PER_SOL) })] }).compileToV0Message();
      return signAsWallet(new VersionedTransaction(msg), wallet);
    };
    expect((await t.call("POST", `/v1/accounts/${account.id}/deposit`, { transaction: await mk(Keypair.generate().publicKey) }, token)).json.error).toBe("DEPOSIT_NOT_EXPECTED");
    const ok = await t.call("POST", `/v1/accounts/${account.id}/deposit`, { transaction: await mk(new PublicKey(account.vault)) }, token);
    expect(ok.status).toBe(200);
    expect(await t.chain.getBalance(new PublicKey(account.vault))).toBe(BigInt(LAMPORTS_PER_SOL));
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
    expect((await t.call("GET", `/v1/accounts/${account.id}/security`, undefined, token)).json.account.frozenBy).toBe(r.json.rotation.id);
  });
});
