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
    expect((await t.call("GET", `/v1/handoff/${token}`)).json.kind).toBe("CONNECT");
    const phone = await enroll(t);
    expect((await t.call("POST", `/v1/handoff/${token}/claim`, { accountId: phone.account.id }, phone.token)).status).toBe(200);
    const st = await t.call("GET", `/v1/pay/${token}`);
    expect(st.json.status).toBe("DONE");
    expect((await t.call("GET", `/v1/accounts/${phone.account.id}/security`, undefined, st.json.result.sessionToken)).status).toBe(200);
  });

  it("pelo QR, sem entrar na conta: cópia cifrada da chave, conferência, webapp + operador + Phantom", async () => {
    const t = await setup();
    const { wallet, webapp, token: session, account } = await enroll(t);
    t.chain.airdrop(new PublicKey(account.vault), 5n * SOL);
    const to = Keypair.generate().publicKey.toBase58();
    const intent = await t.call("POST", `/v1/accounts/${account.id}/intents`, { type: "TRANSFER_SOL", destination: to, amountSol: "2" }, session);
    const token = tokenOf((await t.call("POST", `/v1/intents/${intent.json.intent.id}/pay`, {}, session)).json.url);
    const info = await t.call("GET", `/v1/handoff/${token}`);
    expect(info.json).toMatchObject({ kind: "SIGN_INTENT", intentId: intent.json.intent.id, wallet: account.roles.client });
    expect((await t.call("GET", `/v1/handoff/${token}/key`)).json.keys[0].publicKey).toBe(account.roles.webapp);
    // Assinatura de outra chave no lugar da do webapp: recusada.
    const prepared = await t.call("POST", `/v1/handoff/${token}/prepare`, {});
    const review = await reviewPrepared(t.chain, prepared.json, { client: await wallet.publicKey(), webapp: await webapp.publicKey() }, t.now());
    const bogus = DevMemorySigner.generate("X");
    expect((await t.call("POST", `/v1/handoff/${token}/authorize`, { message: Buffer.from(review.message).toString("base64"), webappSignature: bs58.encode(await bogus.sign(review.message)) })).json.error).toBe("WEBAPP_BAD_SIGNATURE");
    const done = await signIntent(t, `/v1/handoff/${token}`, wallet, webapp);
    expect(done.json.status).toBe("EXECUTED");
    expect((await t.call("GET", `/v1/pay/${token}`)).json.status).toBe("DONE");
    expect((await t.call("POST", `/v1/handoff/${token}/prepare`, {})).json.error).toBe("PAY_USED");
    expect(await t.chain.getBalance(new PublicKey(to))).toBe(2n * SOL);
  });

  it("QR sem pedido não existe", async () => {
    const t = await setup();
    expect((await t.call("GET", "/v1/handoff/naoexiste")).json.error).toBe("PAY_NOT_FOUND");
  });
});
