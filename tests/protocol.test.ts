/**
 * Protocolo completo no modelo 2 de 3 (Phantom + chave do webapp + serviço;
 * só o operador do serviço executa), sobre o Squads v4 real no LiteSVM:
 * serviço (CustodyService) + webapp (review/assinatura) + Phantom.
 */
import { describe, expect, it } from "vitest";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { DevMemorySigner } from "@duplachave/crypto";
import { SecurityError, sealIntent, intentBody } from "@duplachave/shared";
import { inspectPrepared, reviewPrepared, signAsWallet, verifyAuditChain, verifyEnrollmentTransaction } from "@duplachave/custody";
import { approveIx, createVaultProposalIxs, executeVaultIx, readMultisig, vaultPda } from "@duplachave/squads";
import { ChainTxError, sendInstructions } from "@duplachave/solana";
import * as multisig from "@sqds/multisig";
import { enrollWallet, fakeBlob, setupService } from "./support/service";
import { chainError } from "./support/setup";

const SOL = BigInt(LAMPORTS_PER_SOL);
const H72 = 72 * 3600;
const dest = () => Keypair.generate().publicKey.toBase58();
const pk = async (s: DevMemorySigner) => (await s.publicKey()).toBase58();

async function securityError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SecurityError) return e.code;
    throw e;
  }
  throw new Error("esperava SecurityError");
}

describe("cadastro", () => {
  it("a Phantom cria e paga a multisig 2 de 3: Phantom, webapp e serviço votam; só o operador executa; rent volta para a Phantom", async () => {
    const t = await setupService();
    const s = await readMultisig(t.chain, new PublicKey(t.account.multisig));
    expect(s.threshold).toBe(2);
    for (const k of [t.account.roles.client, t.account.roles.webapp, t.account.roles.server]) expect(s.members.find((m) => m.key === k)?.mask).toBe(2);
    expect(s.members.find((m) => m.key === t.account.roles.operator)?.mask).toBe(5);
    expect(s.rentCollector).toBe(t.account.roles.client);
    expect((await t.custody.webappKeys(t.account.id)).length).toBe(1);
    const paid = SOL - (await t.chain.getBalance(new PublicKey(t.account.roles.client)));
    console.log("custo do cadastro (2 de 3) para a Phantom:", Number(paid) / 1e9, "SOL");
    expect(paid).toBeLessThan(SOL / 100n);
  });

  it("sem a assinatura da chave do webapp (ou da Phantom) não há conta; Phantom sem SOL nem prepara", async () => {
    const t = await setupService();
    const w = DevMemorySigner.generate("OUTRA");
    const k = DevMemorySigner.generate("WEBAPP_OUTRA");
    t.chain.airdrop(await w.publicKey(), SOL);
    const p = await t.custody.prepareEnrollment({ publicKey: await pk(w), webappPublicKey: await pk(k), walletName: "Phantom" });
    const onlyWallet = VersionedTransaction.deserialize(Buffer.from(p.transaction, "base64"));
    expect(await securityError(t.custody.submitEnrollment(p.enrollmentId, await signAsWallet(onlyWallet, w), fakeBlob()))).toBe("WEBAPP_BAD_SIGNATURE");
    const onlyWebapp = VersionedTransaction.deserialize(Buffer.from(p.transaction, "base64"));
    onlyWebapp.addSignature(await k.publicKey(), await k.sign(onlyWebapp.message.serialize()));
    expect(await securityError(t.custody.submitEnrollment(p.enrollmentId, Buffer.from(onlyWebapp.serialize()).toString("base64"), fakeBlob()))).toBe("WALLET_BAD_SIGNATURE");
    expect(await t.chain.getAccountInfo(new PublicKey(p.multisig))).toBeNull();
    const broke = DevMemorySigner.generate("SEM_SOL");
    expect(await securityError(t.custody.prepareEnrollment({ publicKey: await pk(broke), webappPublicKey: await pk(k), walletName: "Phantom" }))).toBe("WALLET_NO_SOL");
  });

  it("o webapp confere a criação: recusa transferência escondida da Phantom e outra chave do webapp", async () => {
    const t = await setupService();
    const w = DevMemorySigner.generate("NOVA");
    const k = DevMemorySigner.generate("WEBAPP_NOVA");
    t.chain.airdrop(await w.publicKey(), SOL);
    const p = await t.custody.prepareEnrollment({ publicKey: await pk(w), webappPublicKey: await pk(k), walletName: "Phantom" });
    const me = await w.publicKey();
    const kp = await k.publicKey();
    expect(verifyEnrollmentTransaction(p.transaction, me, kp).multisig).toBe(p.multisig);
    expect(() => verifyEnrollmentTransaction(p.transaction, me, Keypair.generate().publicKey)).toThrow(/memo da carteira e do webapp/);
    const msg = TransactionMessage.decompile(VersionedTransaction.deserialize(Buffer.from(p.transaction, "base64")).message);
    msg.instructions.push(SystemProgram.transfer({ fromPubkey: me, toPubkey: Keypair.generate().publicKey, lamports: SOL / 2n }));
    const sneaky = Buffer.from(new VersionedTransaction(msg.compileToV0Message()).serialize()).toString("base64");
    expect(() => verifyEnrollmentTransaction(sneaky, me, kp)).toThrow(/instruções a mais/);
  });
});

describe("operações (Phantom + webapp votam, o operador executa)", () => {
  it("rascunho não toca a chain; webapp + operador + Phantom; a Phantom paga só a taxa; o voto do serviço não entra", async () => {
    const t = await setupService();
    const to = dest();
    const ms = new PublicKey(t.account.multisig);
    const rec = await t.custody.createTransferSol(t.account.id, { destination: to, amountLamports: (2n * SOL).toString() });
    expect((await readMultisig(t.chain, ms)).transactionIndex).toBe(0n);
    const before = await t.chain.getBalance(new PublicKey(t.account.roles.client));
    const done = await t.sign(rec.intent.id);
    expect(done.status).toBe("EXECUTED");
    expect(await t.chain.getBalance(new PublicKey(to))).toBe(2n * SOL);
    expect(before - (await t.chain.getBalance(new PublicKey(t.account.roles.client)))).toBe(15_000n);
    const landed = (await t.chain.getLandedTransaction(done.signatures.execute!))!;
    expect(landed.signers.map((k) => k.toBase58()).sort()).toEqual([t.account.roles.client, t.account.roles.webapp, t.account.roles.operator].sort());
    for (const key of [t.account.roles.server, t.account.roles.operator, t.account.roles.webapp]) expect(await t.chain.getBalance(new PublicKey(key))).toBe(0n);
  });

  it("o operador só assina com a chave do webapp desta conta, sobre uma mensagem que o serviço preparou", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    const request = await t.custody.prepareIntent(r.intent.id);
    const review = await reviewPrepared(t.chain, request, { client: await t.wallet.publicKey(), webapp: await t.webapp.publicKey() }, t.now());
    const message = Buffer.from(review.message).toString("base64");
    const intruder = DevMemorySigner.generate("INTRUSO");
    expect(await securityError(t.custody.authorizeIntent(r.intent.id, { message, webappSignature: bs58.encode(await intruder.sign(review.message)) }))).toBe("WEBAPP_BAD_SIGNATURE");
    const forged = Buffer.from(review.message);
    forged[forged.length - 1]! ^= 1;
    expect(await securityError(t.custody.authorizeIntent(r.intent.id, { message: forged.toString("base64"), webappSignature: bs58.encode(await t.webapp.sign(forged)) }))).toBe("TX_NOT_EXPECTED");
  });

  it("cliente recusa no app: nada a desfazer; execução que falharia é pega ao preparar", async () => {
    const t = await setupService({ depositSol: 10 });
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    expect((await t.custody.rejectByClient(r.intent.id)).status).toBe("REJECTED");
    const a = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: (6n * SOL).toString() });
    const b = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: (6n * SOL).toString() });
    await t.sign(a.intent.id);
    expect(await securityError(t.custody.prepareIntent(b.intent.id))).toBe("POLICY_DENIED");
  });

  it("INVARIANTE 5 — o webapp mostra A, a transação faz B: recusa e mostra o que ela faria", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    const request = await t.custody.prepareIntent(r.intent.id);
    if (request.intent.type !== "TRANSFER_SOL") throw new Error();
    const mine = { client: await t.wallet.publicKey(), webapp: await t.webapp.publicKey() };
    const lie = { ...request, intent: sealIntent({ ...intentBody(request.intent), amountLamports: "1000" } as never) };
    expect(await securityError(reviewPrepared(t.chain, lie, mine, t.now()))).toBe("INTENT_MISMATCH");
    expect(await securityError(reviewPrepared(t.chain, { ...request, intent: { ...request.intent, amountLamports: "1000" } }, mine, t.now()))).toBe("INTENT_HASH_INVALID");
    const seen = await inspectPrepared(t.chain, lie, mine, t.now());
    if (seen.ok) throw new Error();
    expect(seen.actual?.[0]).toMatchObject({ kind: "SYSTEM_TRANSFER", lamports: SOL, to: request.intent.destination });
  });

  it("Teste 11 — a mesma transação assinada não serve duas vezes; Teste 12 — vencida não prepara", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    const signed = await t.walletTx(r.intent.id);
    await t.custody.submitIntent(r.intent.id, signed);
    expect(await securityError(t.custody.submitIntent(r.intent.id, signed))).toBe("INTENT_NOT_PENDING");
    const late = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    t.advance(11 * 60);
    expect(await securityError(t.custody.prepareIntent(late.intent.id))).toBe("INTENT_EXPIRED");
  });

  it("blockhash vencido enquanto a carteira assinava: TX_EXPIRED, a intenção continua aberta e assinar de novo funciona", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    const signed = await t.walletTx(r.intent.id);
    const send = t.chain.sendTransaction.bind(t.chain);
    t.chain.sendTransaction = async () => {
      throw new ChainTxError('simulação falhou: "BlockhashNotFound"', [], null);
    };
    expect(await securityError(t.custody.submitIntent(r.intent.id, signed))).toBe("TX_EXPIRED");
    t.chain.sendTransaction = send;
    expect((await t.store.getIntent(r.intent.id))!.status).toBe("AWAITING_CLIENT");
    expect((await t.sign(r.intent.id)).status).toBe("EXECUTED");
  });
});

describe("trocas de chave com prazo de 72 h", () => {
  it("trocar a Phantom: webapp + serviço pedem; antes de 72 h não executa; depois, a Phantom nova paga e assume", async () => {
    const t = await setupService();
    const next = DevMemorySigner.generate("PHANTOM_B");
    t.chain.airdrop(await next.publicKey(), SOL / 10n);
    const { change } = await t.requestChange("CLIENT", next);
    expect(change.status).toBe("PENDING");
    expect(change.executeAfter! - t.now()).toBeGreaterThanOrEqual(H72 - 5);
    expect(t.notifications.sent.some((n) => JSON.stringify(n).includes("CHANGE_REQUESTED"))).toBe(true);
    expect(await securityError(t.custody.prepareSecurityExecute(change.id))).toBe("CHANGE_NOT_DUE");
    // Enquanto isso, operações continuam com a Phantom atual + webapp.
    const mid = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    expect((await t.sign(mid.intent.id)).status).toBe("EXECUTED");
    t.advance(H72);
    expect((await t.executeChange(change.id, next)).status).toBe("EXECUTED");
    const acc = (await t.store.getAccount(t.account.id))!;
    expect(acc.roles.client).toBe(await pk(next));
    expect((await readMultisig(t.chain, new PublicKey(acc.multisig))).rentCollector).toBe(await pk(next));
    const after = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    expect(await securityError(t.walletTx(after.intent.id, t.wallet))).toBe("NOT_A_VOTER");
    expect((await t.sign(after.intent.id, next)).status).toBe("EXECUTED");
    expect(await securityError(enrollWallet(t.custody, t.wallet))).toBe("KEY_REVOKED"); // INVARIANTE 6
  });

  it("recuperar o webapp (perdeu o aparelho): Phantom + serviço pedem; depois de 72 h a chave nova vale e a antiga não", async () => {
    const t = await setupService();
    const fresh = DevMemorySigner.generate("WEBAPP_B");
    const { change } = await t.requestChange("WEBAPP", fresh);
    t.advance(H72);
    await t.executeChange(change.id, t.wallet);
    expect((await t.custody.webappKeys(t.account.id)).map((k) => k.publicKey)).toEqual([await pk(fresh)]);
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    expect(await securityError(t.walletTx(r.intent.id, t.wallet, t.webapp))).toBe("WEBAPP_NOT_A_VOTER");
    expect((await t.sign(r.intent.id, t.wallet, fresh)).status).toBe("EXECUTED");
  });

  it("'Não fui eu': seed vazada pede recuperação do webapp; a chave atual do webapp veta e nada muda — e a seed sozinha não veta", async () => {
    const t = await setupService();
    const thief = DevMemorySigner.generate("WEBAPP_DO_LADRAO");
    const { change } = await t.requestChange("WEBAPP", thief); // o ladrão tem a seed da Phantom
    expect(await securityError(t.veto(change.id, t.wallet))).toBe("VETO_NOT_ALLOWED"); // a seed não veta a troca do webapp
    expect((await t.veto(change.id, t.webapp)).status).toBe("VETOED");
    t.advance(H72);
    expect(await securityError(t.custody.prepareSecurityExecute(change.id))).toBe("CHANGE_NOT_PENDING");
    expect((await t.store.getAccount(t.account.id))!.roles.webapp).toBe(await pk(t.webapp));
  });

  it("chave do webapp vazada pede a troca da Phantom; a Phantom atual veta", async () => {
    const t = await setupService();
    const thief = DevMemorySigner.generate("PHANTOM_DO_LADRAO");
    t.chain.airdrop(await thief.publicKey(), SOL / 10n);
    const { change } = await t.requestChange("CLIENT", thief);
    expect(await securityError(t.veto(change.id, t.webapp))).toBe("VETO_NOT_ALLOWED");
    expect((await t.veto(change.id, t.wallet)).status).toBe("VETOED");
  });

  it("uma troca por vez; veto com assinatura falsa é recusado", async () => {
    const t = await setupService();
    const { change } = await t.requestChange("WEBAPP", DevMemorySigner.generate("W2"));
    expect(await securityError(t.requestChange("WEBAPP", DevMemorySigner.generate("W3")))).toBe("CHANGE_IN_PROGRESS");
    const forger = DevMemorySigner.generate("FORJA");
    expect(await securityError(t.custody.vetoSecurityChange(change.id, { publicKey: await pk(t.webapp), signature: bs58.encode(await forger.sign(new TextEncoder().encode("qualquer coisa"))) }))).toBe("BAD_SIGNATURE");
  });

  it("chave do serviço: o serviço gera a nova; Phantom + serviço pedem; depois de 72 h a antiga é aposentada", async () => {
    const t = await setupService();
    const { change } = await t.requestChange("SERVER", null);
    t.advance(H72);
    await t.executeChange(change.id, t.wallet);
    expect(await t.serverKeys.get(t.account.roles.server)).toBeNull();
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    expect((await t.sign(r.intent.id)).status).toBe("EXECUTED");
  });
});

describe("invariantes", () => {
  it("INVARIANTE 3 — serviço inteiro comprometido (voto + operador) não retira fundos", async () => {
    const t = await setupService();
    const thief = DevMemorySigner.generate("LADRAO");
    t.chain.airdrop(await thief.publicKey(), SOL);
    const ms = new PublicKey(t.account.multisig);
    const server = (await t.serverKeys.get(t.account.roles.server))!;
    const index = (await readMultisig(t.chain, ms)).transactionIndex + 1n;
    await sendInstructions(t.chain, createVaultProposalIxs({
      multisig: ms, index, proposer: await t.service.operator.publicKey(), rentPayer: await thief.publicKey(),
      instructions: [SystemProgram.transfer({ fromPubkey: vaultPda(ms), toPubkey: await thief.publicKey(), lamports: 9n * SOL })], recentBlockhash: await t.chain.getLatestBlockhash(),
    }), [thief, t.service.operator]);
    await sendInstructions(t.chain, [approveIx(ms, index, await server.publicKey())], [thief, server]);
    const { instruction } = await executeVaultIx(t.chain, ms, index, await t.service.operator.publicKey());
    expect(await chainError(sendInstructions(t.chain, [instruction], [thief, t.service.operator]))).toBe("InvalidProposalStatus");
    expect(await t.chain.getBalance(vaultPda(ms))).toBe(10n * SOL);
  });

  it("INVARIANTE 4 — acima da política nada é preparado; destino programa não vira intenção", async () => {
    const t = await setupService({ depositSol: 100 });
    expect(await securityError(t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: (60n * SOL).toString() }))).toBe("POLICY_DENIED");
    expect(await securityError(t.custody.createTransferSol(t.account.id, { destination: multisig.PROGRAM_ID.toBase58(), amountLamports: "1000" }))).toBe("POLICY_DENIED");
    // A tela recebe o motivo em português; os códigos ficam na auditoria.
    const msg = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: (60n * SOL).toString() }).catch((e: Error) => e.message);
    expect(msg).toBe("[POLICY_DENIED] acima do limite de 50 SOL por envio.");
    const denied = (await t.store.listAudit()).filter((e) => e.type === "TRANSACTION_POLICY_DENIED").at(-1)!;
    expect(JSON.stringify(denied.details)).toContain("LIMIT_EXCEEDED");
  });

  it("auditoria encadeada: editar um evento quebra a cadeia", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    await t.sign(r.intent.id);
    const events = await t.store.listAudit();
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["SMART_ACCOUNT_CREATED", "TRANSACTION_PROPOSED", "SERVER_APPROVED", "CLIENT_APPROVED", "TRANSACTION_EXECUTED"]));
    expect(verifyAuditChain(events)).toBe(true);
    events[1]!.details = { adulterado: true };
    expect(verifyAuditChain(events)).toBe(false);
  });
});
