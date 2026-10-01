import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { DevMemorySigner } from "@duplachave/crypto";
import { loginMessage } from "@duplachave/crypto";
import { signAsWallet, vetoMessage } from "@duplachave/custody";
import { solToLamports } from "../src/server";
import { blob, enroll, fromB64, setup, signIntent, signText, SOL } from "./helpers";

describe("API (modelo 2 de 3)", () => {
  it("solToLamports não usa float e recusa milhar", () => {
    expect(solToLamports("1,5")).toBe("1500000000");
    expect(solToLamports("0.000000001")).toBe("1");
    expect(() => solToLamports("1.000,00")).toThrow();
  });

  it("cadastro (Phantom + chave do webapp) → envio → webapp + operador + Phantom → executado", async () => {
    const t = await setup();
    const { wallet, webapp, token, account } = await enroll(t);
    await t.call("POST", "/v1/dev/airdrop", { address: account.vault, sol: 5 });
    const to = Keypair.generate().publicKey.toBase58();
    const created = await t.call("POST", `/v1/accounts/${account.id}/intents`, { type: "TRANSFER_SOL", destination: to, amountSol: "1,25" }, token);
    expect(created.json.display.rows[0].value).toBe("1,25 SOL");
    const done = await signIntent(t, `/v1/intents/${created.json.intent.id}`, wallet, webapp, token);
    expect(done.json.status).toBe("EXECUTED");
    expect(await t.chain.getBalance(new PublicKey(to))).toBe(1_250_000_000n);
    expect((await t.call("GET", `/v1/accounts/${account.id}/webapp-keys`, undefined, token)).json.keys).toHaveLength(1);
  });

  it("sessão não substitui assinatura: assinatura de outra chave no lugar do webapp é recusada", async () => {
    const t = await setup();
    const { token, account } = await enroll(t);
    await t.call("POST", "/v1/dev/airdrop", { address: account.vault, sol: 5 });
    const created = await t.call("POST", `/v1/accounts/${account.id}/intents`, { type: "TRANSFER_SOL", destination: Keypair.generate().publicKey.toBase58(), amountSol: "1" }, token);
    const prepared = await t.call("POST", `/v1/intents/${created.json.intent.id}/prepare`, {}, token);
    const msg = fromB64(prepared.json.transaction).message.serialize();
    const intruder = DevMemorySigner.generate("X");
    const r = await t.call("POST", `/v1/intents/${created.json.intent.id}/authorize`, { message: Buffer.from(msg).toString("base64"), webappSignature: bs58.encode(await intruder.sign(msg)) }, token);
    expect(r.json.error).toBe("WEBAPP_BAD_SIGNATURE");
  });

  it("o serviço não paga nada; sem sessão: 401; conta de outro: 403", async () => {
    const t = await setup();
    expect((await t.call("GET", "/v1/config")).json.feePayer).toBeUndefined();
    const a = await enroll(t);
    const b = await enroll(t);
    expect((await t.call("GET", `/v1/accounts/${a.account.id}/security`)).status).toBe(401);
    expect((await t.call("GET", `/v1/accounts/${a.account.id}/security`, undefined, b.token)).status).toBe(403);
    expect((await t.call("GET", `/v1/accounts/${a.account.id}/security`, undefined, a.token)).json.invariantOk).toBe(true);
    expect(await t.chain.getBalance(await t.service.operator.publicKey())).toBe(0n);
  });

  it("perdeu a Phantom: entra com a chave do webapp (biometria) e pede a troca; a Phantom nova paga", async () => {
    const t = await setup();
    const { webapp, account } = await enroll(t);
    // Entrada pela chave do webapp.
    const ch = await t.call("POST", "/v1/auth/challenge", { publicKey: account.roles.webapp });
    const login = await t.call("POST", "/v1/auth/webapp", { challengeId: ch.json.challengeId, publicKey: account.roles.webapp, signature: await signText(webapp, ch.json.message) });
    expect(login.status).toBe(200);
    const token = login.json.token;
    // Pedido da troca da Phantom.
    const next = DevMemorySigner.generate("PHANTOM_NOVA");
    t.chain.airdrop(await next.publicKey(), SOL / 10n);
    const req = await t.call("POST", `/v1/accounts/${account.id}/security-changes`, { role: "CLIENT", newKey: (await next.publicKey()).toBase58() }, token);
    expect(req.status).toBe(200);
    const msg = fromB64(req.json.transaction).message.serialize();
    const auth = await t.call("POST", `/v1/security-changes/${req.json.change.id}/authorize`, { message: Buffer.from(msg).toString("base64"), webappSignature: bs58.encode(await webapp.sign(msg)) }, token);
    const sub = await t.call("POST", `/v1/security-changes/${req.json.change.id}/submit`, { transaction: await signAsWallet(fromB64(auth.json.transaction), next) }, token);
    expect(sub.json.status).toBe("PENDING");
    expect((await t.call("GET", `/v1/accounts/${account.id}/security-changes`, undefined, token)).json.changes[0].status).toBe("PENDING");
  });

  it("'Não fui eu' pela API, sem sessão: a assinatura da chave que seria trocada basta", async () => {
    const t = await setup();
    const { wallet, webapp, token, account } = await enroll(t);
    const thief = DevMemorySigner.generate("WEBAPP_LADRAO");
    const req = await t.call("POST", `/v1/accounts/${account.id}/security-changes`, { role: "WEBAPP", newKey: (await thief.publicKey()).toBase58(), newKeyBlob: blob("Celular do ladrão") }, token);
    const tx = fromB64((await t.call("POST", `/v1/security-changes/${req.json.change.id}/authorize`, { message: Buffer.from(fromB64(req.json.transaction).message.serialize()).toString("base64") }, token)).json.transaction);
    tx.addSignature(await thief.publicKey(), await thief.sign(tx.message.serialize()));
    await t.call("POST", `/v1/security-changes/${req.json.change.id}/submit`, { transaction: await signAsWallet(tx, wallet) }, token);
    const text = vetoMessage({ id: req.json.change.id, multisig: account.multisig, role: "WEBAPP", newKey: (await thief.publicKey()).toBase58() });
    const veto = await t.call("POST", `/v1/security-changes/${req.json.change.id}/veto`, { publicKey: account.roles.webapp, signature: await signText(webapp, text) });
    expect(veto.json.status).toBe("VETOED");
  });

  it("troca da chave do serviço só com token de admin, e ainda precisa da Phantom e do prazo", async () => {
    const t = await setup();
    const { account } = await enroll(t);
    expect((await t.call("POST", `/v1/admin/accounts/${account.id}/security-changes/server`, {})).status).toBe(401);
    const r = await t.call("POST", `/v1/admin/accounts/${account.id}/security-changes/server`, {}, undefined, { "x-admin-token": "admin-token-123456" });
    expect(r.json.change.status).toBe("PREPARED");
    expect(r.json.desc.role).toBe("SERVER");
  });

  it("a cópia cifrada da chave do webapp é achada pela passkey (sem sessão: é só texto cifrado)", async () => {
    const t = await setup();
    const { token, account } = await enroll(t);
    const keys = (await t.call("GET", `/v1/accounts/${account.id}/webapp-keys`, undefined, token)).json.keys;
    const found = await t.call("POST", "/v1/webapp-keys/lookup", { credentialId: keys[0].blob.credentialId });
    expect(found.json).toMatchObject({ accountId: account.id, publicKey: account.roles.webapp });
    expect((await t.call("POST", "/v1/webapp-keys/lookup", { credentialId: "nao-existe-123" })).json.error).toBe("WEBAPP_KEY_NOT_FOUND");
    void loginMessage;
  });
});
