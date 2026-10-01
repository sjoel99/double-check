/**
 * Protocolo completo no fluxo da carteira comum: backend (CustodyService) +
 * app (buildWalletTransaction / reviewOnChain) + carteira (assina), sobre o
 * Squads v4 real no LiteSVM.
 */
import { describe, expect, it } from "vitest";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { DevMemorySigner } from "@duplachave/crypto";
import { SecurityError, sealIntent, intentBody } from "@duplachave/shared";
import { reviewOnChain, signWalletPossession, verifyAuditChain } from "@duplachave/custody";
import { approveIx, createVaultProposalIxs, executeVaultIx, readMultisig, readProposal, vaultPda } from "@duplachave/squads";
import { sendInstructions } from "@duplachave/solana";
import * as multisig from "@sqds/multisig";
import { setupService } from "./support/service";
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

describe("cadastro", () => {
  it("a carteira comum entra na multisig com Vote + Execute; o servidor só com Vote", async () => {
    const t = await setupService();
    const state = await readMultisig(t.chain, new PublicKey(t.account.multisig));
    expect(state.members.find((m) => m.key === t.account.roles.client)?.mask).toBe(6);
    expect(state.members.find((m) => m.key === t.account.roles.server)?.mask).toBe(2);
    expect(state.threshold).toBe(2);
  });

  it("cadastro exige a assinatura da própria carteira sobre o texto emitido", async () => {
    const t = await setupService();
    const other = DevMemorySigner.generate("OTHER");
    const pk = (await other.publicKey()).toBase58();
    const ch = await t.custody.createChallenge("ENROLL_CLIENT_KEY", pk);
    const forger = DevMemorySigner.generate("FORGER");
    const bs58 = (await import("bs58")).default;
    const sig = bs58.encode(await forger.sign(new TextEncoder().encode(ch.message)));
    expect(await securityError(t.custody.enroll({ challengeId: ch.id, publicKey: pk, signature: sig, walletName: "Phantom" }))).toBe("POSSESSION_BAD_SIGNATURE");
  });
});

describe("fluxo de transação", () => {
  it("app monta → servidor já aprovou → carteira aprova e executa num clique", async () => {
    const t = await setupService();
    const to = dest();
    const rec = await t.custody.createTransferSol(t.account.id, { destination: to, amountLamports: (2n * SOL).toString() });
    expect(rec.status).toBe("AWAITING_CLIENT");
    const p = await readProposal(t.chain, new PublicKey(t.account.multisig), BigInt(rec.intent.transactionIndex));
    expect(p?.approved).toEqual([t.account.roles.server]);

    const done = await t.sign(rec.intent.id);
    expect(done.status).toBe("EXECUTED");
    expect(await t.chain.getBalance(new PublicKey(to))).toBe(2n * SOL);
  });

  it("cliente recusa no app: o servidor troca o voto e a proposta morre", async () => {
    const t = await setupService();
    const rec = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    expect((await t.custody.rejectByClient(rec.intent.id)).status).toBe("REJECTED");
    expect((await readProposal(t.chain, new PublicKey(t.account.multisig), BigInt(rec.intent.transactionIndex)))?.status).toBe("Rejected");
  });

  it("se a execução falha, nada fica aprovado: a intenção continua aguardando", async () => {
    const t = await setupService({ depositSol: 10 });
    const r1 = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: (6n * SOL).toString() });
    const r2 = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: (6n * SOL).toString() });
    await t.sign(r1.intent.id);
    expect(await securityError(t.sign(r2.intent.id))).toBe("WALLET_TX_FAILED");
    expect((await t.store.getIntent(r2.intent.id))?.status).toBe("AWAITING_CLIENT");
    expect((await readProposal(t.chain, new PublicKey(t.account.multisig), BigInt(r2.intent.transactionIndex)))?.status).toBe("Active");
  });
});

describe("Teste 10 — trocar a public key nova depois da aprovação", () => {
  it("backend mostra CARTEIRA_B mas a chain tem CARTEIRA_C: o app recusa", async () => {
    const t = await setupService();
    const { intent } = await t.rotateTo(DevMemorySigner.generate("WALLET_B"));
    if (intent.type !== "ROTATE_MEMBER") throw new Error();
    const forged = sealIntent({ ...intentBody(intent), newKey: dest() } as never);
    expect(await securityError(reviewOnChain(t.chain, forged, await t.wallet.publicKey(), t.now()))).toBe("INTENT_MISMATCH");
  });

  it("registro adulterado depois da assinatura da carteira: o backend recusa", async () => {
    const t = await setupService();
    const { intent } = await t.rotateTo(DevMemorySigner.generate("WALLET_B"));
    const signed = await t.walletTx(intent.id);
    const rec = (await t.store.getIntent(intent.id))!;
    if (rec.intent.type !== "ROTATE_MEMBER") throw new Error();
    rec.intent = sealIntent({ ...intentBody(rec.intent), newKey: dest() } as never);
    await t.store.saveIntent(rec);
    expect(await securityError(t.custody.submitWalletTransaction(intent.id, signed))).toBe("INTENT_MISMATCH");
    const state = await readMultisig(t.chain, new PublicKey(t.account.multisig));
    expect(state.members.some((m) => m.key === t.account.roles.client)).toBe(true);
  });

  it("a transação da carteira não pode ser redirecionada para outro índice", async () => {
    const t = await setupService();
    const r1 = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    const signed1 = await t.walletTx(r1.intent.id);
    const r2 = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    expect(await securityError(t.custody.submitWalletTransaction(r2.intent.id, signed1))).toBe("TX_NOT_EXPECTED");
  });
});

describe("Teste 11 — replay", () => {
  it("a mesma transação assinada não serve duas vezes", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    const signed = await t.walletTx(r.intent.id);
    await t.custody.submitWalletTransaction(r.intent.id, signed);
    expect(await securityError(t.custody.submitWalletTransaction(r.intent.id, signed))).toBe("INTENT_NOT_PENDING");
  });

  it("no programa: votar duas vezes falha (AlreadyApproved)", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    const ms = new PublicKey(t.account.multisig);
    const server = (await t.serverKeys.get(t.account.roles.server))!;
    const ix = approveIx(ms, BigInt(r.intent.transactionIndex), await server.publicKey());
    expect(await chainError(sendInstructions(t.chain, [ix], [t.service.feePayer, server]))).toBe("AlreadyApproved");
  });
});

describe("Teste 12 — proposta expirada", () => {
  it("depois do prazo: app recusa, backend recusa e a proposta é rejeitada on-chain", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    const early = await t.walletTx(r.intent.id); // assinada ainda no prazo
    t.advance(11 * 60);
    expect(await securityError(t.walletTx(r.intent.id))).toBe("INTENT_EXPIRED");
    expect(await securityError(t.custody.submitWalletTransaction(r.intent.id, early))).toBe("INTENT_EXPIRED");
    const ms = new PublicKey(t.account.multisig);
    expect((await readProposal(t.chain, ms, BigInt(r.intent.transactionIndex)))?.status).toBe("Rejected");
    const ix = approveIx(ms, BigInt(r.intent.transactionIndex), await t.wallet.publicKey());
    expect(await chainError(sendInstructions(t.chain, [ix], [t.service.feePayer, t.wallet]))).toBe("InvalidProposalStatus");
  });

  it("expireDue encerra pendências vencidas", async () => {
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
    expect((await readMultisig(t.chain, new PublicKey(t.account.multisig))).transactionIndex).toBe(0n);

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
  it("CARTEIRA_A → CARTEIRA_B: congela, drena, servidor aprova, A assina, executor executa e A é revogada", async () => {
    const t = await setupService();
    const pending = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    const b = DevMemorySigner.generate("WALLET_B");
    const { rotation, intent } = await t.rotateTo(b);

    expect((await t.store.getIntent(pending.intent.id))?.status).toBe("REJECTED");
    expect(await securityError(t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() }))).toBe("OPERATIONS_FROZEN");
    expect(await securityError(t.walletTx(intent.id, b))).toBe("NOT_A_VOTER"); // B não aprova a própria entrada

    expect((await t.sign(intent.id)).status).toBe("EXECUTED");
    const rot = (await t.store.getRotation(rotation.id))!;
    expect(rot.history.map((h) => h.status)).toEqual([
      "REQUESTED", "NEW_KEY_VERIFIED", "OPERATIONS_FROZEN", "AWAITING_SERVER_APPROVAL", "AWAITING_CLIENT_APPROVAL", "EXECUTING", "VERIFIED", "COMPLETED",
    ]);
    const acc = (await t.store.getAccount(t.account.id))!;
    expect(acc.roles.client).toBe((await b.publicKey()).toBase58());
    expect(acc.frozenBy).toBeNull();
    const state = await readMultisig(t.chain, new PublicKey(t.account.multisig));
    expect(state.members.find((m) => m.key === acc.roles.client)?.mask).toBe(6);

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
  });

  it("SERVER_A → SERVER_B: sem a carteira do cliente, expira e nada muda; com ela, troca", async () => {
    const t = await setupService();
    const first = await t.custody.requestServerRotation(t.account.id, "programada");
    expect(first.rotation.status).toBe("AWAITING_CLIENT_APPROVAL");
    t.advance(31 * 60);
    await t.custody.expireDue(t.account.id);
    expect((await t.store.getRotation(first.rotation.id))?.status).toBe("EXPIRED");
    expect((await readProposal(t.chain, new PublicKey(t.account.multisig), BigInt(first.intent.transactionIndex)))?.status).toBe("Rejected");

    const second = await t.custody.requestServerRotation(t.account.id, "programada");
    expect((await t.sign(second.intent.id)).status).toBe("EXECUTED");
    const acc = (await t.store.getAccount(t.account.id))!;
    expect(acc.roles.server).not.toBe(t.account.roles.server);
    expect(await t.serverKeys.get(t.account.roles.server)).toBeNull();
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    expect((await t.sign(r.intent.id)).status).toBe("EXECUTED");
  });

  it("cliente recusa a troca da chave do serviço: REJECTED e descongela", async () => {
    const t = await setupService();
    const { rotation, intent } = await t.custody.requestServerRotation(t.account.id, "?");
    await t.custody.rejectByClient(intent.id);
    expect((await t.store.getRotation(rotation.id))?.status).toBe("REJECTED");
    expect((await t.store.getAccount(t.account.id))?.frozenBy).toBeNull();
  });
});

describe("invariantes", () => {
  it("INVARIANTE 3 — backend inteiro comprometido (servidor + proposer + executor) não retira fundos", async () => {
    const t = await setupService();
    const thief = Keypair.generate().publicKey;
    const ms = new PublicKey(t.account.multisig);
    const server = (await t.serverKeys.get(t.account.roles.server))!;
    const index = (await readMultisig(t.chain, ms)).transactionIndex + 1n;
    await sendInstructions(t.chain, createVaultProposalIxs({
      multisig: ms, index, proposer: await t.service.proposer.publicKey(), rentPayer: await t.service.feePayer.publicKey(),
      instructions: [SystemProgram.transfer({ fromPubkey: vaultPda(ms), toPubkey: thief, lamports: 9n * SOL })], recentBlockhash: await t.chain.getLatestBlockhash(),
    }), [t.service.feePayer, t.service.proposer]);
    await sendInstructions(t.chain, [approveIx(ms, index, await server.publicKey())], [t.service.feePayer, server]);
    const { instruction } = await executeVaultIx(t.chain, ms, index, await t.service.executor.publicKey());
    expect(await chainError(sendInstructions(t.chain, [instruction], [t.service.feePayer, t.service.executor]))).toBe("InvalidProposalStatus");
    expect(await t.chain.getBalance(thief)).toBe(0n);
  });

  it("INVARIANTE 4 — a carteira sozinha não cria nem aprova transação do Vault; acima da política nada é proposto", async () => {
    const t = await setupService({ depositSol: 100 });
    const ms = new PublicKey(t.account.multisig);
    const index = (await readMultisig(t.chain, ms)).transactionIndex + 1n;
    const [create] = createVaultProposalIxs({
      multisig: ms, index, proposer: await t.wallet.publicKey(), rentPayer: await t.wallet.publicKey(),
      instructions: [SystemProgram.transfer({ fromPubkey: vaultPda(ms), toPubkey: Keypair.generate().publicKey, lamports: SOL })], recentBlockhash: await t.chain.getLatestBlockhash(),
    });
    t.chain.airdrop(await t.wallet.publicKey(), SOL);
    expect(await chainError(sendInstructions(t.chain, [create!], [t.wallet]))).toBe("Unauthorized"); // carteira não tem Initiate
    expect(await securityError(t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: (60n * SOL).toString() }))).toBe("POLICY_DENIED");
  });

  it("INVARIANTE 5 — app mostra A, chain tem B: o app recusa antes de montar a transação", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    const request = await t.custody.approvalRequest(r.intent.id);
    if (request.intent.type !== "TRANSFER_SOL") throw new Error();
    const lie = sealIntent({ ...intentBody(request.intent), amountLamports: "1000" } as never);
    expect(await securityError(reviewOnChain(t.chain, lie, await t.wallet.publicKey(), t.now()))).toBe("INTENT_MISMATCH");
    expect(await securityError(reviewOnChain(t.chain, { ...request.intent, amountLamports: "1000" }, await t.wallet.publicKey(), t.now()))).toBe("INTENT_HASH_INVALID");
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
  it("destino que é programa é recusado; simulação que falha não vira proposta", async () => {
    const t = await setupService({ depositSol: 1 });
    expect(await securityError(t.custody.createTransferSol(t.account.id, { destination: multisig.PROGRAM_ID.toBase58(), amountLamports: "1000" }))).toBe("POLICY_DENIED");
    expect(await securityError(t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: (5n * SOL).toString() }))).toBe("POLICY_DENIED");
    expect((await readMultisig(t.chain, new PublicKey(t.account.multisig))).transactionIndex).toBe(0n);
  });
});
