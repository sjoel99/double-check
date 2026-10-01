import { describe, expect, it } from "vitest";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { DevMemorySigner, randomHex, signStatement } from "@duplachave/crypto";
import { DefaultPolicyEngine } from "@duplachave/policy-engine";
import { CustodyService, DevServerKeyProvider, LogNotificationService, MemoryStore, signClientDecision, signPossession } from "@duplachave/custody";
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
    custody, store, chain, cluster: "localnet", appRpcUrl: "/rpc", sessionSecret: "s".repeat(64), adminToken: "admin-token-123456",
    feePayer: (await service.feePayer.publicKey()).toBase58(),
    airdrop: async (a, l) => chain.airdrop(a, BigInt(l)),
  });
  const call = async (method: "GET" | "POST", url: string, body?: unknown, token?: string, headers: Record<string, string> = {}) => {
    const r = await app.inject({ method, url, payload: body as object, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
    return { status: r.statusCode, json: r.json() as any };
  };
  return { chain, app, call, now, store };
}

async function enroll(t: Awaited<ReturnType<typeof setup>>, device = DevMemorySigner.generate("APP")) {
  const ch = await t.call("POST", "/v1/enrollment/challenge", {});
  const possession = await signPossession({ signer: device, operation: "ENROLL_CLIENT_KEY", cluster: "localnet", multisig: "", rotationId: ch.json.challengeId, challenge: ch.json.challenge, now: t.now() });
  const r = await t.call("POST", "/v1/enrollment", { userId: ch.json.userId, deviceName: "Pixel 9", challengeId: ch.json.challengeId, possession });
  expect(r.status).toBe(200);
  return { device, token: r.json.token as string, account: r.json.account };
}

describe("API", () => {
  it("solToLamports não usa float e recusa milhar", () => {
    expect(solToLamports("1,5")).toBe("1500000000");
    expect(solToLamports("0.000000001")).toBe("1");
    expect(() => solToLamports("1.000,00")).toThrow();
  });

  it("cadastro → envio → aprovação pelo app → executado", async () => {
    const t = await setup();
    const { device, token, account } = await enroll(t);
    await t.call("POST", "/v1/dev/airdrop", { address: account.vault, sol: 5 });
    const dest = Keypair.generate().publicKey.toBase58();
    const created = await t.call("POST", `/v1/accounts/${account.id}/intents`, { type: "TRANSFER_SOL", destination: dest, amountSol: "1,25" }, token);
    expect(created.status).toBe(200);
    expect(created.json.display.rows[0].value).toBe("1,25 SOL");

    const got = await t.call("GET", `/v1/intents/${created.json.intent.id}`, undefined, token);
    const payload = await signClientDecision({ chain: t.chain, request: got.json.approvalRequest, signer: device, decision: "APPROVE", now: t.now() });
    const done = await t.call("POST", `/v1/intents/${created.json.intent.id}/decision`, payload, token);
    expect(done.json.status).toBe("EXECUTED");
    expect(await t.chain.getBalance(new PublicKey(dest))).toBe(1_250_000_000n);
  });

  it("sessão não substitui assinatura: decisão com assinatura de outra chave é recusada", async () => {
    const t = await setup();
    const { token, account } = await enroll(t);
    await t.call("POST", "/v1/dev/airdrop", { address: account.vault, sol: 5 });
    const created = await t.call("POST", `/v1/accounts/${account.id}/intents`, { type: "TRANSFER_SOL", destination: Keypair.generate().publicKey.toBase58(), amountSol: "1" }, token);
    const got = await t.call("GET", `/v1/intents/${created.json.intent.id}`, undefined, token);
    const intruder = DevMemorySigner.generate("X");
    await expect(signClientDecision({ chain: t.chain, request: got.json.approvalRequest, signer: intruder, decision: "APPROVE", now: t.now() })).rejects.toThrow(/NOT_A_VOTER/);
    // Mesmo forjando a declaração com o campo signer certo, a assinatura não confere.
    const st = { domain: "duplachave/approval/v1", decision: "APPROVE", cluster: "localnet", multisig: account.multisig, transactionIndex: created.json.intent.transactionIndex, transactionKind: "VAULT", intentId: created.json.intent.id, intentHash: created.json.intent.intentHash, transactionHash: created.json.transactionHash, signer: account.roles.client, nonce: randomHex(16), createdAt: t.now(), expiresAt: t.now() + 60 };
    const forged = await signStatement(intruder, st);
    const r = await t.call("POST", `/v1/intents/${created.json.intent.id}/decision`, { statement: forged }, token);
    expect(r.json.error).toBe("BAD_SIGNATURE");
  });

  it("sem sessão: 401; conta de outro: 403", async () => {
    const t = await setup();
    const a = await enroll(t);
    const b = await enroll(t);
    expect((await t.call("GET", `/v1/accounts/${a.account.id}/security`)).status).toBe(401);
    expect((await t.call("GET", `/v1/accounts/${a.account.id}/security`, undefined, b.token)).status).toBe(403);
    const ok = await t.call("GET", `/v1/accounts/${a.account.id}/security`, undefined, a.token);
    expect(ok.json.invariantOk).toBe(true);
  });

  it("troca de aparelho pela API: pareamento, prova, aprovação do antigo; sessão antiga morre", async () => {
    const t = await setup();
    const { device, token, account } = await enroll(t);
    const rot = await t.call("POST", `/v1/accounts/${account.id}/rotations/client`, { newDeviceName: "Galaxy S26" }, token);
    const { rotationId, challenge, multisig } = rot.json.pairing;

    // Aparelho novo, só com o QR.
    const pairing = await t.call("GET", `/v1/rotations/${rotationId}/pairing?c=${challenge}`);
    expect(pairing.json.status).toBe("REQUESTED");
    const fresh = DevMemorySigner.generate("NEW");
    const proof = await t.call("POST", `/v1/rotations/${rotationId}/proof`, { possession: await signPossession({ signer: fresh, operation: "ROTATE_CLIENT_KEY", cluster: "localnet", multisig, rotationId, challenge, now: t.now() }) });
    expect(proof.status).toBe(200);

    // Aparelho antigo aprova.
    const intentId = proof.json.intent.id;
    const got = await t.call("GET", `/v1/intents/${intentId}`, undefined, token);
    const payload = await signClientDecision({ chain: t.chain, request: got.json.approvalRequest, signer: device, decision: "APPROVE", now: t.now() });
    expect((await t.call("POST", `/v1/intents/${intentId}/decision`, payload, token)).json.status).toBe("EXECUTED");

    // Sessão do aparelho antigo não vale mais; o novo entra assinando um desafio.
    expect((await t.call("GET", `/v1/accounts/${account.id}/security`, undefined, token)).status).toBe(401);
    const pk = (await fresh.publicKey()).toBase58();
    const ch = await t.call("POST", "/v1/auth/challenge", { publicKey: pk });
    const login = await t.call("POST", "/v1/auth/verify", { challengeId: ch.json.challengeId, signed: await signStatement(fresh, { domain: "duplachave/auth/v1", challenge: ch.json.challenge, publicKey: pk, cluster: "localnet", nonce: randomHex(16), createdAt: t.now() }) });
    expect(login.status).toBe(200);
    expect((await t.call("GET", `/v1/accounts/${account.id}/security`, undefined, login.json.token)).json.account.roles.client).toBe(pk);
  });

  it("rotação do servidor só com token de admin, e ainda depende do app", async () => {
    const t = await setup();
    const { token, account } = await enroll(t);
    expect((await t.call("POST", `/v1/admin/accounts/${account.id}/rotations/server`, { reason: "x" })).status).toBe(401);
    const r = await t.call("POST", `/v1/admin/accounts/${account.id}/rotations/server`, { reason: "trimestral" }, undefined, { "x-admin-token": "admin-token-123456" });
    expect(r.json.rotation.status).toBe("AWAITING_CLIENT_APPROVAL");
    const sec = await t.call("GET", `/v1/accounts/${account.id}/security`, undefined, token);
    expect(sec.json.account.frozenBy).toBe(r.json.rotation.id);
  });
});
