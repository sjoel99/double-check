import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { DevMemorySigner } from "@duplachave/crypto";
import { loginMessage } from "@duplachave/crypto";
import { emailBindingMessage, signAsWallet, vetoMessage } from "@duplachave/custody";
import { redactUrl, solToLamports, tokenEquals } from "../src/server";
import { blob, enroll, fromB64, setup, signIntent, signText, SOL } from "./helpers";

describe("API (modelo 2 de 3)", () => {
  it("limite por IP usa o X-Forwarded-For do proxy: um usuário esgotando o cadastro não bloqueia outro", async () => {
    const t = await setup();
    const hit = (ip: string) => t.call("POST", "/v1/enrollment/prepare", {}, undefined, { "x-forwarded-for": ip });
    for (let i = 0; i < 5; i++) expect((await hit("203.0.113.1")).status).toBe(400);
    expect((await hit("203.0.113.1")).status).toBe(429);
    expect((await hit("203.0.113.2")).status).toBe(400);
  });

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
    // Token errado do mesmo tamanho e token de outro tamanho: os dois 401 (comparação em tempo constante).
    expect((await t.call("POST", `/v1/admin/accounts/${account.id}/security-changes/server`, {}, undefined, { "x-admin-token": "admin-token-123457" })).status).toBe(401);
    expect((await t.call("POST", `/v1/admin/accounts/${account.id}/security-changes/server`, {}, undefined, { "x-admin-token": "curto" })).status).toBe(401);
    const r = await t.call("POST", `/v1/admin/accounts/${account.id}/security-changes/server`, {}, undefined, { "x-admin-token": "admin-token-123456" });
    expect(r.json.change.status).toBe("PREPARED");
    expect(r.json.desc.role).toBe("SERVER");
  });

  it("erros levam código e params: a tela monta a frase no idioma dela", async () => {
    const t = await setup();
    const { token, account } = await enroll(t);
    await t.call("POST", "/v1/dev/airdrop", { address: account.vault, sol: 100 });
    // Acima do teto da política (50 SOL): motivo e teto em params.
    const over = await t.call("POST", `/v1/accounts/${account.id}/intents`, { type: "TRANSFER_SOL", destination: Keypair.generate().publicKey.toBase58(), amountSol: "60" }, token);
    expect(over.status).toBe(422);
    expect(over.json).toMatchObject({ error: "POLICY_DENIED", params: { reason: "LIMIT_EXCEEDED", limitLamports: (50n * SOL).toString() } });
    expect(over.json.message).toMatch(/acima do limite/);
    // Cancelada e depois preparada: o status vai em params.
    const created = await t.call("POST", `/v1/accounts/${account.id}/intents`, { type: "TRANSFER_SOL", destination: Keypair.generate().publicKey.toBase58(), amountSol: "1" }, token);
    expect((await t.call("POST", `/v1/intents/${created.json.intent.id}/reject`, undefined, token)).json.status).toBe("REJECTED");
    const again = await t.call("POST", `/v1/intents/${created.json.intent.id}/prepare`, {}, token);
    expect(again.json).toMatchObject({ error: "INTENT_NOT_PENDING", params: { status: "REJECTED" } });
    // Erros de sessão e permissão têm código próprio.
    expect((await t.call("GET", `/v1/accounts/${account.id}/security`)).json).toMatchObject({ error: "SESSION_INVALID" });
    const other = await enroll(t);
    expect((await t.call("GET", `/v1/accounts/${account.id}/security`, undefined, other.token)).json).toMatchObject({ error: "FORBIDDEN_ACCOUNT" });
    expect((await t.call("GET", `/v1/accounts/${account.id}/intents/nope`, undefined, token)).status).toBe(404);
  });

  it("tokens do QR não vão para o log; comparação do admin token em tempo constante", () => {
    expect(redactUrl("/v1/pay/0123abcd")).toBe("/v1/pay/***");
    expect(redactUrl("/v1/handoff/0123abcd/prepare")).toBe("/v1/handoff/***/prepare");
    expect(redactUrl("/v1/handoff/0123abcd?x=1")).toBe("/v1/handoff/***?x=1");
    expect(redactUrl("/v1/intents/abc/pay")).toBe("/v1/intents/abc/pay");
    expect(tokenEquals("abc", "abc")).toBe(true);
    expect(tokenEquals("abd", "abc")).toBe(false);
    expect(tokenEquals("ab", "abc")).toBe(false);
    expect(tokenEquals(undefined, "abc")).toBe(false);
    expect(tokenEquals("abc", null)).toBe(false);
  });

  it("a cópia cifrada da chave do webapp é achada pela passkey (sem sessão: é só texto cifrado)", async () => {
    const t = await setup();
    const { token, account } = await enroll(t);
    const keys = (await t.call("GET", `/v1/accounts/${account.id}/webapp-keys`, undefined, token)).json.keys;
    const found = await t.call("POST", "/v1/webapp-keys/lookup", { credentialId: keys[0].blob.credentialId });
    // Só a chave pública e o texto cifrado: nada da conta sai sem sessão.
    expect(found.json).toEqual({ publicKey: account.roles.webapp, blob: keys[0].blob });
    expect((await t.call("POST", "/v1/webapp-keys/lookup", { credentialId: "nao-existe-123" })).json.error).toBe("WEBAPP_KEY_NOT_FOUND");
    // Uma passkey guarda a chave de UMA conta: outra conta não registra a mesma credencial (nem no cadastro, nem como cópia, nem na troca).
    const other = await enroll(t, undefined, undefined, { ...blob(), credentialId: keys[0].blob.credentialId });
    expect(other.error?.error).toBe("CREDENTIAL_IN_USE");
    const b = await enroll(t);
    const thief = DevMemorySigner.generate("WEBAPP_LADRAO");
    const req = await t.call("POST", `/v1/accounts/${b.account.id}/security-changes`, { role: "WEBAPP", newKey: (await thief.publicKey()).toBase58(), newKeyBlob: { ...blob(), credentialId: keys[0].blob.credentialId } }, b.token);
    expect(req.json.error).toBe("CREDENTIAL_IN_USE");
    // A mesma conta pode guardar mais uma cópia para a mesma credencial.
    expect((await t.call("POST", "/v1/webapp-keys/lookup", { credentialId: keys[0].blob.credentialId })).json.publicKey).toBe(account.roles.webapp);
    void loginMessage;
  });

  it("o texto de entrada diz o site; a sessão aberta com a chave do webapp morre quando essa chave é trocada", async () => {
    const t = await setup();
    const { webapp, account } = await enroll(t);
    const ch = await t.call("POST", "/v1/auth/challenge", { publicKey: account.roles.webapp });
    expect(ch.json.message).toContain("Site: dupla.example");
    const login = await t.call("POST", "/v1/auth/webapp", { challengeId: ch.json.challengeId, publicKey: account.roles.webapp, signature: await signText(webapp, ch.json.message) });
    expect(login.status).toBe(200);
    expect((await t.call("GET", `/v1/accounts/${account.id}/security`, undefined, login.json.token)).status).toBe(200);
    // Troca da chave do webapp concluída (aqui, direto no banco): a sessão antiga não vale mais.
    const acc = (await t.store.getAccount(account.id))!;
    await t.store.saveAccount({ ...acc, roles: { ...acc.roles, webapp: (await DevMemorySigner.generate("WEBAPP_NOVA").publicKey()).toBase58() } });
    expect((await t.call("GET", `/v1/accounts/${account.id}/security`, undefined, login.json.token)).json.error).toBe("SESSION_STALE_WALLET");
  });

  it("e-mail de alerta: exige sessão e a assinatura da chave do webapp", async () => {
    const t = await setup();
    const { wallet, webapp, token, account } = await enroll(t);
    const email = "dono@exemplo.com";
    const text = emailBindingMessage(account.multisig, email);
    expect((await t.call("POST", `/v1/accounts/${account.id}/email/start`, { email, signature: await signText(webapp, text) })).status).toBe(401);
    const byPhantom = await t.call("POST", `/v1/accounts/${account.id}/email/start`, { email, signature: await signText(wallet, text) }, token);
    expect(byPhantom.json.error).toBe("WEBAPP_BAD_SIGNATURE");
    const ok = await t.call("POST", `/v1/accounts/${account.id}/email/start`, { email: " Dono@Exemplo.com ", signature: await signText(webapp, text) }, token);
    expect(ok.status).toBe(200);
    expect(ok.json.email).toBe(email);
    const bad = await t.call("POST", `/v1/accounts/${account.id}/email/confirm`, { challengeId: ok.json.challengeId, code: "abc" }, token);
    expect(bad.status).toBe(400);
    const sec = await t.call("GET", `/v1/accounts/${account.id}/security`, undefined, token);
    expect(sec.json.alertEmail).toBeNull();
  });
});
