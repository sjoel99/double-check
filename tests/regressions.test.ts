/**
 * Regressões: achados da revisão de 2026-10-01 (A2–A5) adaptados ao modelo
 * 2 de 3, e os casos próprios das transações preparadas e das trocas com prazo.
 */
import { describe, expect, it } from "vitest";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { DevMemorySigner } from "@duplachave/crypto";
import { SecurityError } from "@duplachave/shared";
import { PREPARED_WINDOW, reviewPrepared, webappCopyMessage } from "@duplachave/custody";
import { readMultisig } from "@duplachave/squads";
import { setupService } from "./support/service";

const SOL = BigInt(LAMPORTS_PER_SOL);
const dest = () => Keypair.generate().publicKey.toBase58();

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SecurityError) return e.code;
    return `OTHER:${String(e)}`;
  }
  return "NO_ERROR";
}

describe("A2 — nada fica aprovado e não executado", () => {
  it("preparar não escreve na chain; duas intenções no mesmo índice: só uma entra, a outra prepara de novo", async () => {
    const t = await setupService();
    const a = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    const b = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    const signedA = await t.walletTx(a.intent.id);
    expect((await readMultisig(t.chain, new PublicKey(t.account.multisig))).transactionIndex).toBe(0n);
    expect((await t.sign(b.intent.id)).intent.transactionIndex).toBe("1");
    expect(await code(t.custody.submitIntent(a.intent.id, signedA))).toBe("WALLET_TX_FAILED");
    expect((await t.sign(a.intent.id)).intent.transactionIndex).toBe("2");
  });
});

describe("A3 — transação preparada que entra depois", () => {
  it("recusada no app mas assinada e enviada pela carteira: a chain manda e a intenção vira EXECUTED", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    const signed = await t.walletTx(r.intent.id);
    await t.custody.rejectByClient(r.intent.id);
    await t.chain.sendTransaction(VersionedTransaction.deserialize(Buffer.from(signed, "base64")));
    await t.custody.expireDue(t.account.id);
    const rec = (await t.store.getIntent(r.intent.id))!;
    expect(rec.status).toBe("EXECUTED");
    expect(rec.reasons[0]).toContain("REJECTED");
  });

  it("pedido de troca preparado e nunca assinado: depois da janela vira FAILED e libera outro pedido", async () => {
    const t = await setupService();
    await t.custody.requestSecurityChange(t.account.id, { role: "SERVER" });
    expect(await code(t.custody.requestSecurityChange(t.account.id, { role: "SERVER" }))).toBe("CHANGE_IN_PROGRESS");
    t.advance(PREPARED_WINDOW + 1);
    await t.custody.expireDue(t.account.id);
    expect((await t.custody.listSecurityChanges(t.account.id))[0]!.status).toBe("FAILED");
    expect(await code(t.custody.requestSecurityChange(t.account.id, { role: "SERVER" }))).toBe("NO_ERROR");
  });
});

describe("A4 — o operador só assina o que o serviço preparou, com a chave do webapp", () => {
  it("mensagem com o blockhash trocado (mesmo assinada pelo webapp) não é assinada pelo operador", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    const request = await t.custody.prepareIntent(r.intent.id);
    const tx = VersionedTransaction.deserialize(Buffer.from(request.transaction, "base64"));
    tx.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
    const msg = tx.message.serialize();
    expect(await code(t.custody.authorizeIntent(r.intent.id, { message: Buffer.from(msg).toString("base64"), webappSignature: bs58.encode(await t.webapp.sign(msg)) }))).toBe("TX_NOT_EXPECTED");
  });

  it("depois do prazo da preparação, o operador não assina mais", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    const request = await t.custody.prepareIntent(r.intent.id);
    const review = await reviewPrepared(t.chain, request, { client: await t.wallet.publicKey(), webapp: await t.webapp.publicKey() }, t.now());
    t.advance(PREPARED_WINDOW + 1);
    expect(await code(t.custody.authorizeIntent(r.intent.id, { message: Buffer.from(review.message).toString("base64"), webappSignature: bs58.encode(await t.webapp.sign(review.message)) }))).toBe("PREPARED_EXPIRED");
  });

  it("cópia extra da chave do webapp só com a assinatura da própria chave", async () => {
    const t = await setupService();
    const blob = { credentialId: "outra-passkey", salt: "cw", iv: "aQ", ciphertext: "Yw" };
    const text = webappCopyMessage(t.account.multisig, blob.credentialId);
    const thief = DevMemorySigner.generate("LADRAO");
    expect(await code(t.custody.addWebappKeyCopy(t.account.id, { blob, deviceName: "x", signature: bs58.encode(await thief.sign(new TextEncoder().encode(text))) }))).toBe("WEBAPP_BAD_SIGNATURE");
    await t.custody.addWebappKeyCopy(t.account.id, { blob, deviceName: "Notebook", signature: bs58.encode(await t.webapp.sign(new TextEncoder().encode(text))) });
    expect((await t.custody.webappKeys(t.account.id)).map((k) => k.deviceName)).toEqual(["Celular de teste", "Notebook"]);
  });
});

describe("A5 — expiração concorrendo com o envio", () => {
  it("expireDue espera o envio em andamento: a intenção termina EXECUTED, não EXPIRED", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    const signed = await t.walletTx(r.intent.id);
    const orig = t.chain.sendTransaction.bind(t.chain);
    let concurrent: Promise<unknown> | null = null;
    t.chain.sendTransaction = async (tx) => {
      const sig = await orig(tx);
      t.advance(r.intent.expiresAt - t.now() + PREPARED_WINDOW + 1);
      concurrent = t.custody.expireDue(t.account.id);
      return sig;
    };
    expect((await t.custody.submitIntent(r.intent.id, signed)).status).toBe("EXECUTED");
    t.chain.sendTransaction = orig;
    await concurrent;
    expect((await t.store.getIntent(r.intent.id))!.status).toBe("EXECUTED");
  });

  it("expireDue não vence intenção autorizada ainda válida; depois da janela, vence", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    t.advance(r.intent.expiresAt - t.now() - 1);
    await t.walletTx(r.intent.id);
    t.advance(2);
    await t.custody.expireDue(t.account.id);
    expect((await t.store.getIntent(r.intent.id))?.status).toBe("AWAITING_CLIENT");
    t.advance(PREPARED_WINDOW);
    await t.custody.expireDue(t.account.id);
    expect((await t.store.getIntent(r.intent.id))?.status).toBe("EXPIRED");
  });
});
