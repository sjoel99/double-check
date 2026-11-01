/**
 * Continuar no celular: o QR abre o nosso app no celular. O celular confere,
 * a chave do webapp (biometria) assina, o operador assina e a Phantom assina —
 * sem entrar na conta: o token do QR dá acesso àquela intenção.
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { DevMemorySigner } from "@duplachave/crypto";
import { reviewPrepared } from "@duplachave/custody";
import { enroll, setup, signIntent, SOL } from "./helpers";

const tokenOf = (url: string) => url.split("/#/m/")[1]!;

describe("continuar no celular", () => {
  it("o QR abre o nosso app (HTTPS); entrar pelo celular entrega a sessão ao computador", async () => {
    const t = await setup();
    const qr = await t.call("POST", "/v1/pay/connect");
    expect(qr.json.url).toMatch(/^https:\/\/dupla\.example\/#\/m\/[0-9a-f]{48}$/);
    const token = tokenOf(qr.json.url);
    expect(qr.json.poll).toMatch(/^[0-9a-f]{48}$/);
    expect(qr.json.poll).not.toBe(token);
    const info = await t.call("GET", `/v1/handoff/${token}`);
    expect(info.json.kind).toBe("CONNECT");
    expect(info.json.summary).toEqual({ type: "CONNECT" });
    // Sem sessão no celular: código estável, não frase solta.
    expect((await t.call("POST", `/v1/handoff/${token}/claim`, { accountId: "00000000-0000-4000-8000-000000000000" })).json).toMatchObject({ error: "PHONE_NOT_SIGNED_IN" });
    const phone = await enroll(t);
    expect((await t.call("POST", `/v1/handoff/${token}/claim`, { accountId: phone.account.id }, phone.token)).status).toBe(200);
    // Quem só viu o QR (token) não lê o resultado: o acompanhamento é pelo `poll`.
    expect((await t.call("GET", `/v1/pay/${token}`)).json.error).toBe("PAY_NOT_FOUND");
    // O token de sessão não fica no banco: é emitido quando o computador busca, uma vez só.
    expect((await t.store.getHandoff(token))?.status).toBe("DONE");
    expect(JSON.stringify((await t.store.getHandoff(token))?.result)).not.toContain("sessionToken");
    const st = await t.call("GET", `/v1/pay/${qr.json.poll}`);
    expect(st.json.status).toBe("DONE");
    expect(st.json.result.publicKey).toBe(phone.account.roles.client);
    expect((await t.call("GET", `/v1/accounts/${phone.account.id}/security`, undefined, st.json.result.sessionToken)).status).toBe(200);
    const again = await t.call("GET", `/v1/pay/${qr.json.poll}`);
    expect(again.json.status).toBe("DONE");
    expect(again.json.result.sessionToken).toBeUndefined();
    expect(JSON.stringify((await t.store.getHandoff(token))?.result)).not.toContain("sessionToken");
  });

  it("pelo QR, sem entrar na conta: cópia cifrada da chave, conferência, webapp + operador + Phantom", async () => {
    const t = await setup();
    const { wallet, webapp, token: session, account } = await enroll(t);
    t.chain.airdrop(new PublicKey(account.vault), 5n * SOL);
    const to = Keypair.generate().publicKey.toBase58();
    const intent = await t.call("POST", `/v1/accounts/${account.id}/intents`, { type: "TRANSFER_SOL", destination: to, amountSol: "2" }, session);
    const pay = await t.call("POST", `/v1/intents/${intent.json.intent.id}/pay`, {}, session);
    const token = tokenOf(pay.json.url);
    const info = await t.call("GET", `/v1/handoff/${token}`);
    expect(info.json).toMatchObject({ kind: "SIGN_INTENT", intentId: intent.json.intent.id, wallet: account.roles.client, summary: { type: "TRANSFER_SOL", amountLamports: (2n * SOL).toString(), destination: to, toSelf: false } });
    expect((await t.call("GET", `/v1/handoff/${token}/key`)).json.keys[0].publicKey).toBe(account.roles.webapp);
    // Assinatura de outra chave no lugar da do webapp: recusada.
    const prepared = await t.call("POST", `/v1/handoff/${token}/prepare`, {});
    const review = await reviewPrepared(t.chain, prepared.json, { client: await wallet.publicKey(), webapp: await webapp.publicKey() }, t.now());
    const bogus = DevMemorySigner.generate("X");
    expect((await t.call("POST", `/v1/handoff/${token}/authorize`, { message: Buffer.from(review.message).toString("base64"), webappSignature: bs58.encode(await bogus.sign(review.message)) })).json.error).toBe("WEBAPP_BAD_SIGNATURE");
    const done = await signIntent(t, `/v1/handoff/${token}`, wallet, webapp);
    expect(done.json.status).toBe("EXECUTED");
    // Assinada, o token do QR não abre mais nada da conta — mesmo antes de o computador buscar.
    expect((await t.call("GET", `/v1/handoff/${token}/key`)).json).toMatchObject({ error: "PAY_USED", params: { what: "USED" } });
    expect((await t.call("POST", `/v1/handoff/${token}/reject`, {})).json).toMatchObject({ error: "PAY_USED" });
    expect((await t.call("GET", `/v1/handoff/${token}/intent`)).json.record.status).toBe("EXECUTED");
    expect((await t.call("GET", `/v1/pay/${pay.json.poll}`)).json.status).toBe("DONE");
    expect((await t.call("POST", `/v1/handoff/${token}/prepare`, {})).json).toMatchObject({ error: "PAY_USED", params: { what: "USED" } });
    expect(await t.chain.getBalance(new PublicKey(to))).toBe(2n * SOL);
  });

  it("QR de assinatura vencido: nem a intenção nem a chave saem; sem sessão, um id de intenção não se confirma", async () => {
    const t = await setup();
    const { token: session, account } = await enroll(t);
    t.chain.airdrop(new PublicKey(account.vault), 5n * SOL);
    const intent = await t.call("POST", `/v1/accounts/${account.id}/intents`, { type: "TRANSFER_SOL", destination: Keypair.generate().publicKey.toBase58(), amountSol: "1" }, session);
    const pay = await t.call("POST", `/v1/intents/${intent.json.intent.id}/pay`, {}, session);
    const token = tokenOf(pay.json.url);
    t.advance(11 * 60);
    expect((await t.call("GET", `/v1/handoff/${token}/intent`)).json.error).toBe("PAY_USED");
    expect((await t.call("GET", `/v1/handoff/${token}/key`)).json.error).toBe("PAY_USED");
    // Sem sessão: 401 tanto para um id real quanto para um inventado.
    expect((await t.call("GET", `/v1/intents/${intent.json.intent.id}`)).status).toBe(401);
    expect((await t.call("GET", "/v1/intents/00000000-0000-4000-8000-000000000000")).status).toBe(401);
    expect((await t.call("POST", `/v1/intents/${intent.json.intent.id}/pay`, {})).status).toBe(401);
  });

  it("QR sem pedido não existe", async () => {
    const t = await setup();
    expect((await t.call("GET", "/v1/handoff/naoexiste")).json.error).toBe("PAY_NOT_FOUND");
  });
});
