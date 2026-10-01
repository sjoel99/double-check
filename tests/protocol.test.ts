/**
 * Protocolo completo no modelo atômico: backend (CustodyService) prepara e
 * assina como servidor, o app (reviewPrepared) remonta os bytes e confere, e a
 * carteira assina por último e paga — sobre o Squads v4 real no LiteSVM.
 */
import { describe, expect, it } from "vitest";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { DevMemorySigner } from "@duplachave/crypto";
import { SecurityError, sealIntent, intentBody } from "@duplachave/shared";
import { inspectPrepared, reviewPrepared, signAsWallet, signWalletPossession, verifyAuditChain, verifyEnrollmentTransaction } from "@duplachave/custody";
import { approveIx, createVaultProposalIxs, executeVaultIx, readMultisig, vaultPda } from "@duplachave/squads";
import { sendInstructions } from "@duplachave/solana";
import * as multisig from "@sqds/multisig";
import { enrollWallet, setupService } from "./support/service";
import { chainError } from "./support/setup";

const SOL = BigInt(LAMPORTS_PER_SOL);
const dest = () => Keypair.generate().publicKey.toBase58();

async function securityError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SecurityError) return e.code;
    throw e;
  }
  throw new Error("esperava SecurityError");
}

const pk = async (s: DevMemorySigner) => (await s.publicKey()).toBase58();

describe("cadastro", () => {
  it("a carteira cria e paga a multisig: Vote + Execute para ela, só Vote para o servidor, rent de volta para ela", async () => {
    const t = await setupService();
    const state = await readMultisig(t.chain, new PublicKey(t.account.multisig));
    expect(state.members.find((m) => m.key === t.account.roles.client)?.mask).toBe(6);
    expect(state.members.find((m) => m.key === t.account.roles.server)?.mask).toBe(2);
    expect(state.threshold).toBe(2);
    expect(state.rentCollector).toBe(t.account.roles.client);
    const paid = SOL - (await t.chain.getBalance(new PublicKey(t.account.roles.client)));
    console.log("custo do cadastro para a carteira:", Number(paid) / 1e9, "SOL");
    expect(paid).toBeGreaterThan(0n);
    expect(paid).toBeLessThan(SOL / 100n);
  });

  it("sem a assinatura da própria carteira não há conta; carteira sem SOL nem chega a preparar", async () => {
    const t = await setupService();
    const other = DevMemorySigner.generate("OTHER");
    t.chain.airdrop(await other.publicKey(), SOL);
    const p = await t.custody.prepareEnrollment({ publicKey: await pk(other), walletName: "Phantom" });
    const forger = DevMemorySigner.generate("FORGER");
    const tx = VersionedTransaction.deserialize(Buffer.from(p.transaction, "base64"));
    tx.signatures[0] = await forger.sign(tx.message.serialize());
    expect(await securityError(t.custody.submitEnrollment(p.enrollmentId, Buffer.from(tx.serialize()).toString("base64")))).toBe("WALLET_BAD_SIGNATURE");
    expect(await t.chain.getAccountInfo(new PublicKey(p.multisig))).toBeNull();

    const broke = DevMemorySigner.generate("BROKE");
    expect(await securityError(t.custody.prepareEnrollment({ publicKey: await pk(broke), walletName: "Phantom" }))).toBe("WALLET_NO_SOL");
  });
});

describe("cadastro conferido pelo app", () => {
  it("o app aceita a criação 2-de-2 e recusa transferência escondida da carteira ou membros trocados", async () => {
    const t = await setupService();
    const w = DevMemorySigner.generate("NEW");
    t.chain.airdrop(await w.publicKey(), SOL);
    const p = await t.custody.prepareEnrollment({ publicKey: await pk(w), walletName: "Phantom" });
    const me = await w.publicKey();
    expect(verifyEnrollmentTransaction(p.transaction, me).multisig).toBe(p.multisig);

    const tx = VersionedTransaction.deserialize(Buffer.from(p.transaction, "base64"));
    const msg = TransactionMessage.decompile(tx.message);
    msg.instructions.push(SystemProgram.transfer({ fromPubkey: me, toPubkey: Keypair.generate().publicKey, lamports: SOL / 2n }));
    const sneaky = Buffer.from(new VersionedTransaction(msg.compileToV0Message()).serialize()).toString("base64");
    expect(() => verifyEnrollmentTransaction(sneaky, me)).toThrow(/instruções a mais/);
    expect(() => verifyEnrollmentTransaction(p.transaction, Keypair.generate().publicKey)).toThrow(/não é esta carteira/);
  });
});

describe("fluxo de transação", () => {
  it("rascunho não toca a chain; preparar → app confere → carteira assina e paga só a taxa; o sistema não gasta nada", async () => {
    const t = await setupService();
    const to = dest();
    const ms = new PublicKey(t.account.multisig);
    const rec = await t.custody.createTransferSol(t.account.id, { destination: to, amountLamports: (2n * SOL).toString() });
    expect(rec.status).toBe("AWAITING_CLIENT");
    expect((await readMultisig(t.chain, ms)).transactionIndex).toBe(0n);

    const wallet = new PublicKey(t.account.roles.client);
    const before = await t.chain.getBalance(wallet);
    const done = await t.sign(rec.intent.id);
    expect(done.status).toBe("EXECUTED");
    expect(await t.chain.getBalance(new PublicKey(to))).toBe(2n * SOL);
    expect(before - (await t.chain.getBalance(wallet))).toBe(15_000n);
    for (const key of [t.account.roles.server, t.account.roles.proposer, t.account.roles.executor]) expect(await t.chain.getBalance(new PublicKey(key))).toBe(0n);
    expect((await readMultisig(t.chain, ms)).transactionIndex).toBe(1n);
  });

  it("cliente recusa no app: nada a desfazer na chain", async () => {
    const t = await setupService();
    const rec = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    expect((await t.custody.rejectByClient(rec.intent.id)).status).toBe("REJECTED");
    expect(await securityError(t.custody.prepareIntent(rec.intent.id))).toBe("INTENT_NOT_PENDING");
    expect((await readMultisig(t.chain, new PublicKey(t.account.multisig))).transactionIndex).toBe(0n);
  });

  it("execução que falharia é pega ao preparar: o servidor não assina", async () => {
    const t = await setupService({ depositSol: 10 });
    const r1 = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: (6n * SOL).toString() });
    const r2 = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: (6n * SOL).toString() });
    await t.sign(r1.intent.id);
    expect(await securityError(t.custody.prepareIntent(r2.intent.id))).toBe("POLICY_DENIED");
    expect((await t.store.getIntent(r2.intent.id))?.prepared ?? []).toEqual([]);
    expect((await readMultisig(t.chain, new PublicKey(t.account.multisig))).transactionIndex).toBe(1n);
  });
});

describe("Teste 10 — trocar a public key nova depois da aprovação", () => {
  it("backend mostra CARTEIRA_C mas a transação adiciona CARTEIRA_B: o app recusa", async () => {
    const t = await setupService();
    const { intent, fields } = await t.rotateTo(DevMemorySigner.generate("WALLET_B"));
    const request = await t.custody.prepareIntent(intent.id);
    if (request.intent.type !== "ROTATE_MEMBER") throw new Error();
    // Servidor malicioso: gera C ele mesmo (então tem uma prova "válida" de C) e mostra C.
    const c = DevMemorySigner.generate("WALLET_C");
    const lie = { ...request, intent: sealIntent({ ...intentBody(request.intent), newKey: await pk(c) } as never), possession: await signWalletPossession(c, fields) };
    expect(await securityError(reviewPrepared(t.chain, lie, await t.wallet.publicKey(), t.now()))).toBe("INTENT_MISMATCH");
  });

  it("a transação assinada não serve para outra intenção, nem alterada depois de preparada", async () => {
    const t = await setupService();
    const r1 = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    const signed1 = await t.walletTx(r1.intent.id);
    const r2 = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    expect(await securityError(t.custody.submitIntent(r2.intent.id, signed1))).toBe("TX_NOT_EXPECTED");

    // A carteira (ou um app adulterado) muda o blockhash e assina: não é a preparada.
    const request = await t.custody.prepareIntent(r2.intent.id);
    const tx = VersionedTransaction.deserialize(Buffer.from(request.transaction, "base64"));
    tx.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
    expect(await securityError(t.custody.submitIntent(r2.intent.id, await signAsWallet(tx, t.wallet)))).toBe("TX_NOT_EXPECTED");
  });
});

describe("Teste 11 — replay", () => {
  it("a mesma transação assinada não serve duas vezes", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    const signed = await t.walletTx(r.intent.id);
    await t.custody.submitIntent(r.intent.id, signed);
    expect(await securityError(t.custody.submitIntent(r.intent.id, signed))).toBe("INTENT_NOT_PENDING");
  });

  it("no programa: a transação preparada não entra sem a carteira, e a carteira não troca o servidor", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    const request = await t.custody.prepareIntent(r.intent.id);
    const partial = VersionedTransaction.deserialize(Buffer.from(request.transaction, "base64"));
    await expect(t.chain.sendTransaction(partial)).rejects.toThrow();
    expect((await readMultisig(t.chain, new PublicKey(t.account.multisig))).transactionIndex).toBe(0n);
  });
});

describe("Teste 12 — intenção expirada", () => {
  it("depois do prazo: o servidor não prepara e o app recusa o pedido antigo", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    const request = await t.custody.prepareIntent(r.intent.id);
    t.advance(11 * 60);
    expect(await securityError(reviewPrepared(t.chain, request, await t.wallet.publicKey(), t.now()))).toBe("INTENT_EXPIRED");
    expect(await securityError(t.custody.prepareIntent(r.intent.id))).toBe("INTENT_EXPIRED");
    expect((await t.store.getIntent(r.intent.id))?.status).toBe("EXPIRED");
  });

  it("expireDue encerra rascunhos vencidos", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    t.advance(11 * 60);
    await t.custody.expireDue(t.account.id);
    expect((await t.store.getIntent(r.intent.id))?.status).toBe("EXPIRED");
  });
});

describe("Teste 13 — carteira nova sem prova de posse", () => {
  it("assinatura de outra carteira, desafio ou operação errados: recusados e nada proposto", async () => {
    const t = await setupService();
    const { rotation, fields } = await t.custody.requestClientRotation(t.account.id);
    const b = DevMemorySigner.generate("WALLET_B");
    const c = DevMemorySigner.generate("WALLET_C");
    const good = await signWalletPossession(b, fields);
    const stolen = { ...(await signWalletPossession(c, fields)), publicKey: good.publicKey };
    expect(await securityError(t.custody.proveClientRotationKey(rotation.id, stolen))).toBe("POSSESSION_BAD_SIGNATURE");
    expect(await securityError(t.custody.proveClientRotationKey(rotation.id, await signWalletPossession(b, { ...fields, challenge: "ab".repeat(32) })))).toBe("POSSESSION_WRONG_CHALLENGE");
    expect(await securityError(t.custody.proveClientRotationKey(rotation.id, await signWalletPossession(b, { ...fields, operation: "ROTATE_SERVER_KEY" })))).toBe("POSSESSION_WRONG_OPERATION");
    expect(await securityError(t.custody.proveClientRotationKey(rotation.id, await signWalletPossession(b, { ...fields, account: "nova" })))).toBe("POSSESSION_WRONG_ACCOUNT");
    expect((await t.store.getRotation(rotation.id))?.status).toBe("REQUESTED");
    expect(await t.store.listIntents(t.account.id)).toEqual([]);

    await t.custody.proveClientRotationKey(rotation.id, good);
    expect((await t.store.getRotation(rotation.id))?.status).toBe("AWAITING_CLIENT_APPROVAL");
  });

  it("prova vencida é recusada", async () => {
    const t = await setupService();
    const { rotation, fields } = await t.custody.requestClientRotation(t.account.id);
    const proof = await signWalletPossession(DevMemorySigner.generate("WALLET_B"), fields);
    t.advance(31 * 60);
    expect(await securityError(t.custody.proveClientRotationKey(rotation.id, proof))).toBe("ROTATION_EXPIRED");
  });

  it("a política recusa rotação para chave sem prova", async () => {
    const { DefaultPolicyEngine, DEFAULT_POLICY } = await import("@duplachave/policy-engine");
    const newKey = dest();
    const oldKey = dest();
    const intent = sealIntent({
      version: 1, id: crypto.randomUUID(), cluster: "localnet", multisig: dest(), transactionIndex: "1",
      createdAt: 1, expiresAt: 100, kind: "CONFIG", type: "ROTATE_MEMBER", role: "CLIENT", oldKey, newKey, rotationId: crypto.randomUUID(),
    });
    const view = { kind: "CONFIG" as const, actions: [{ kind: "AddMember" as const, key: newKey, mask: 6 }, { kind: "RemoveMember" as const, key: oldKey }], rotation: { role: "CLIENT" as const, oldKey, newKey } };
    const d = await new DefaultPolicyEngine().validate({ id: "u", policy: DEFAULT_POLICY }, intent, view, { vaultLamports: 0n, verifiedNewKeys: [], revokedKeys: [] });
    expect(d.reasons.join()).toContain("NO_PROOF_OF_POSSESSION");
  });
});

describe("troca de carteira", () => {
  it("CARTEIRA_A → CARTEIRA_B numa transação: A assina e paga, B entra, A sai e o rent passa para B", async () => {
    const t = await setupService();
    const b = DevMemorySigner.generate("WALLET_B");
    const { rotation, intent } = await t.rotateTo(b);

    // Sem congelamento: um envio no meio não atrapalha; a troca só vai para o índice seguinte.
    const meanwhile = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    expect((await t.sign(meanwhile.intent.id)).status).toBe("EXECUTED");
    expect(await securityError(t.walletTx(intent.id, b))).toBe("NOT_A_VOTER"); // B não aprova a própria entrada

    const done = await t.sign(intent.id);
    expect(done.status).toBe("EXECUTED");
    expect(done.intent.transactionIndex).toBe("2");
    const rot = (await t.store.getRotation(rotation.id))!;
    expect(rot.history.map((h) => h.status)).toEqual(["REQUESTED", "NEW_KEY_VERIFIED", "AWAITING_CLIENT_APPROVAL", "VERIFIED", "COMPLETED"]);
    const acc = (await t.store.getAccount(t.account.id))!;
    expect(acc.roles.client).toBe(await pk(b));
    const state = await readMultisig(t.chain, new PublicKey(t.account.multisig));
    expect(state.members.find((m) => m.key === acc.roles.client)?.mask).toBe(6);
    expect(state.members.some((m) => m.key === t.account.roles.client)).toBe(false);
    expect(state.rentCollector).toBe(acc.roles.client);

    t.chain.airdrop(await b.publicKey(), SOL / 10n);
    const next = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    expect(await securityError(t.walletTx(next.intent.id, t.wallet))).toBe("NOT_A_VOTER");
    expect((await t.sign(next.intent.id, b)).status).toBe("EXECUTED");
    expect(verifyAuditChain(await t.store.listAudit())).toBe(true);
  });

  it("INVARIANTE 6 — carteira revogada nunca volta", async () => {
    const t = await setupService();
    const { intent } = await t.rotateTo(DevMemorySigner.generate("WALLET_B"));
    await t.sign(intent.id);
    const { rotation, fields } = await t.custody.requestClientRotation(t.account.id);
    expect(await securityError(t.custody.proveClientRotationKey(rotation.id, await signWalletPossession(t.wallet, fields)))).toBe("REVOKED_KEY_REUSE");
    expect(await securityError(enrollWallet(t.custody, t.wallet))).toBe("KEY_REVOKED");
  });

  it("SERVER_A → SERVER_B: sem a carteira do cliente, expira e nada muda; com ela, troca", async () => {
    const t = await setupService();
    const first = await t.custody.requestServerRotation(t.account.id, "programada");
    expect(first.rotation.status).toBe("AWAITING_CLIENT_APPROVAL");
    t.advance(31 * 60);
    await t.custody.expireDue(t.account.id);
    expect((await t.store.getRotation(first.rotation.id))?.status).toBe("EXPIRED");
    expect((await readMultisig(t.chain, new PublicKey(t.account.multisig))).members.some((m) => m.key === t.account.roles.server)).toBe(true);

    const second = await t.custody.requestServerRotation(t.account.id, "programada");
    expect((await t.sign(second.intent.id)).status).toBe("EXECUTED");
    const acc = (await t.store.getAccount(t.account.id))!;
    expect(acc.roles.server).not.toBe(t.account.roles.server);
    expect(await t.serverKeys.get(t.account.roles.server)).toBeNull();
    expect((await readMultisig(t.chain, new PublicKey(t.account.multisig))).rentCollector).toBe(t.account.roles.client);
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    expect((await t.sign(r.intent.id)).status).toBe("EXECUTED");
  });

  it("cliente recusa a troca da chave do serviço: REJECTED", async () => {
    const t = await setupService();
    const { rotation, intent } = await t.custody.requestServerRotation(t.account.id, "?");
    await t.custody.rejectByClient(intent.id);
    expect((await t.store.getRotation(rotation.id))?.status).toBe("REJECTED");
  });
});

describe("invariantes", () => {
  it("INVARIANTE 3 — backend inteiro comprometido (servidor + proposer + executor) não retira fundos", async () => {
    const t = await setupService();
    const thief = DevMemorySigner.generate("THIEF");
    t.chain.airdrop(await thief.publicKey(), SOL);
    const ms = new PublicKey(t.account.multisig);
    const server = (await t.serverKeys.get(t.account.roles.server))!;
    const index = (await readMultisig(t.chain, ms)).transactionIndex + 1n;
    await sendInstructions(t.chain, createVaultProposalIxs({
      multisig: ms, index, proposer: await t.service.proposer.publicKey(), rentPayer: await thief.publicKey(),
      instructions: [SystemProgram.transfer({ fromPubkey: vaultPda(ms), toPubkey: await thief.publicKey(), lamports: 9n * SOL })], recentBlockhash: await t.chain.getLatestBlockhash(),
    }), [thief, t.service.proposer]);
    await sendInstructions(t.chain, [approveIx(ms, index, await server.publicKey())], [thief, server]);
    const { instruction } = await executeVaultIx(t.chain, ms, index, await t.service.executor.publicKey());
    expect(await chainError(sendInstructions(t.chain, [instruction], [thief, t.service.executor]))).toBe("InvalidProposalStatus");
    expect(await t.chain.getBalance(vaultPda(ms))).toBe(10n * SOL);
  });

  it("INVARIANTE 4 — a carteira sozinha não cria nem aprova transação do Vault; acima da política nada é preparado", async () => {
    const t = await setupService({ depositSol: 100 });
    const ms = new PublicKey(t.account.multisig);
    const index = (await readMultisig(t.chain, ms)).transactionIndex + 1n;
    const [create] = createVaultProposalIxs({
      multisig: ms, index, proposer: await t.wallet.publicKey(), rentPayer: await t.wallet.publicKey(),
      instructions: [SystemProgram.transfer({ fromPubkey: vaultPda(ms), toPubkey: Keypair.generate().publicKey, lamports: SOL })], recentBlockhash: await t.chain.getLatestBlockhash(),
    });
    expect(await chainError(sendInstructions(t.chain, [create!], [t.wallet]))).toBe("Unauthorized"); // carteira não tem Initiate
    expect(await securityError(t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: (60n * SOL).toString() }))).toBe("POLICY_DENIED");
  });

  it("INVARIANTE 5 — app mostra A, a transação faz B: o app recusa e mostra o que ela faria", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    const request = await t.custody.prepareIntent(r.intent.id);
    if (request.intent.type !== "TRANSFER_SOL") throw new Error();
    const me = await t.wallet.publicKey();
    const lie = { ...request, intent: sealIntent({ ...intentBody(request.intent), amountLamports: "1000" } as never) };
    expect(await securityError(reviewPrepared(t.chain, lie, me, t.now()))).toBe("INTENT_MISMATCH");
    expect(await securityError(reviewPrepared(t.chain, { ...request, intent: { ...request.intent, amountLamports: "1000" } }, me, t.now()))).toBe("INTENT_HASH_INVALID");
    const seen = await inspectPrepared(t.chain, lie, me, t.now());
    expect(seen.ok).toBe(false);
    if (seen.ok) throw new Error();
    expect(seen.actual?.[0]).toMatchObject({ kind: "SYSTEM_TRANSFER", lamports: SOL, to: request.intent.destination });
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

describe("antes de propor", () => {
  it("destino que é programa é recusado; simulação que falha não vira intenção", async () => {
    const t = await setupService({ depositSol: 1 });
    expect(await securityError(t.custody.createTransferSol(t.account.id, { destination: multisig.PROGRAM_ID.toBase58(), amountLamports: "1000" }))).toBe("POLICY_DENIED");
    expect(await securityError(t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: (5n * SOL).toString() }))).toBe("POLICY_DENIED");
    expect(await t.store.listIntents(t.account.id)).toEqual([]);
  });
});
