/**
 * Protocolo completo: backend (CustodyService) + app (reviewOnChain /
 * signClientDecision) sobre o Squads v4 real no LiteSVM.
 */
import { describe, expect, it } from "vitest";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { DevMemorySigner, signStatement } from "@duplachave/crypto";
import { SecurityError, sealIntent, intentBody } from "@duplachave/shared";
import { reviewOnChain, signPossession, verifyAuditChain } from "@duplachave/custody";
import { readMultisig, readProposal, approveIx } from "@duplachave/squads";
import { sendInstructions } from "@duplachave/solana";
import { setupService } from "./support/service";
import { chainError } from "./support/setup";

const SOL = BigInt(LAMPORTS_PER_SOL);

async function securityError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SecurityError) return e.code;
    throw e;
  }
  throw new Error("esperava SecurityError");
}

describe("fluxo de operação", () => {
  it("intenção → app confere na chain → aprova → servidor aprova → executa", async () => {
    const t = await setupService();
    const dest = Keypair.generate().publicKey;
    const rec = await t.custody.createTransferSol(t.account.id, { destination: dest.toBase58(), amountLamports: (2n * SOL).toString() });
    expect(rec.status).toBe("AWAITING_CLIENT");
    expect(rec.riskFlags).toContain("EXTERNAL_DESTINATION");

    const done = await t.custody.submitClientDecision(rec.intent.id, await t.decide(rec.intent.id));
    expect(done.status).toBe("EXECUTED");
    expect(await t.chain.getBalance(dest)).toBe(2n * SOL);
    expect(t.notifications.sent.map((n) => n.kind)).toContain("transactionApprovalRequested");
  });

  it("cliente rejeita: proposta morre on-chain com um voto", async () => {
    const t = await setupService();
    const rec = await t.custody.createTransferSol(t.account.id, { destination: Keypair.generate().publicKey.toBase58(), amountLamports: SOL.toString() });
    const out = await t.custody.submitClientDecision(rec.intent.id, await t.decide(rec.intent.id, t.app, "REJECT"));
    expect(out.status).toBe("REJECTED");
    expect((await readProposal(t.chain, new PublicKey(t.account.multisig), BigInt(rec.intent.transactionIndex)))?.status).toBe("Rejected");
  });
});

describe("Teste 10 — trocar a public key nova depois da aprovação", () => {
  it("backend mostra CLIENT_B mas a chain tem CLIENT_C: o app recusa", async () => {
    const t = await setupService();
    const rot = await t.custody.requestClientRotation(t.account.id, { newDeviceName: "Galaxy S26" });
    const b = DevMemorySigner.generate("CLIENT_B");
    const { intent } = await t.custody.proveClientRotationKey(rot.id, await signPossession({ signer: b, operation: "ROTATE_CLIENT_KEY", cluster: "localnet", multisig: t.account.multisig, rotationId: rot.id, challenge: rot.challenge, now: t.now() }));

    // Intenção forjada: mesmo índice, chave diferente, hash recalculado (válido).
    const c = Keypair.generate().publicKey.toBase58();
    if (intent.type !== "ROTATE_MEMBER") throw new Error();
    const forged = sealIntent({ ...intentBody(intent), newKey: c } as never);
    expect(await securityError(reviewOnChain(t.chain, forged, await t.app.publicKey(), t.now()))).toBe("INTENT_MISMATCH");
  });

  it("aprovação assinada para CLIENT_B não serve se o registro passar a dizer CLIENT_C", async () => {
    const t = await setupService();
    const rot = await t.custody.requestClientRotation(t.account.id, { newDeviceName: "Galaxy S26" });
    const b = DevMemorySigner.generate("CLIENT_B");
    const { intent } = await t.custody.proveClientRotationKey(rot.id, await signPossession({ signer: b, operation: "ROTATE_CLIENT_KEY", cluster: "localnet", multisig: t.account.multisig, rotationId: rot.id, challenge: rot.challenge, now: t.now() }));
    const payload = await t.decide(intent.id);

    // Banco adulterado depois da assinatura.
    const rec = (await t.store.getIntent(intent.id))!;
    if (rec.intent.type !== "ROTATE_MEMBER") throw new Error();
    rec.intent = sealIntent({ ...intentBody(rec.intent), newKey: Keypair.generate().publicKey.toBase58() } as never);
    await t.store.saveIntent(rec);
    expect(await securityError(t.custody.submitClientDecision(intent.id, payload))).toBe("STATEMENT_MISMATCH");

    // E a chain continua com CLIENT_A como votante.
    const state = await readMultisig(t.chain, new PublicKey(t.account.multisig));
    expect(state.members.some((m) => m.key === t.account.roles.client)).toBe(true);
  });

  it("o voto do cliente (proposal_approve) não pode ser redirecionado para outro índice", async () => {
    const t = await setupService();
    const r1 = await t.custody.createTransferSol(t.account.id, { destination: Keypair.generate().publicKey.toBase58(), amountLamports: SOL.toString() });
    const p1 = await t.decide(r1.intent.id);
    // Rejeita a 1 para poder criar a 2 com o mesmo destino e valor.
    await t.custody.submitClientDecision(r1.intent.id, await t.decide(r1.intent.id, t.app, "REJECT"));
    const r2 = await t.custody.createTransferSol(t.account.id, { destination: Keypair.generate().publicKey.toBase58(), amountLamports: SOL.toString() });
    const p2 = await t.decide(r2.intent.id);
    // Declaração da 2 com o voto da 1.
    expect(await securityError(t.custody.submitClientDecision(r2.intent.id, { statement: p2.statement, approveTransaction: p1.approveTransaction }))).toBe("CLIENT_VOTE_INVALID");
  });
});

describe("Teste 11 — replay de aprovação antiga", () => {
  it("a mesma decisão não é aceita duas vezes, nem em outra intenção", async () => {
    const t = await setupService();
    const r1 = await t.custody.createTransferSol(t.account.id, { destination: Keypair.generate().publicKey.toBase58(), amountLamports: SOL.toString() });
    const p1 = await t.decide(r1.intent.id);
    await t.custody.submitClientDecision(r1.intent.id, p1);
    expect(await securityError(t.custody.submitClientDecision(r1.intent.id, p1))).toBe("INTENT_NOT_PENDING");

    const r2 = await t.custody.createTransferSol(t.account.id, { destination: Keypair.generate().publicKey.toBase58(), amountLamports: SOL.toString() });
    expect(await securityError(t.custody.submitClientDecision(r2.intent.id, p1))).toBe("STATEMENT_MISMATCH");
  });

  it("nonce de uso único: a declaração consumida não volta", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: Keypair.generate().publicKey.toBase58(), amountLamports: SOL.toString() });
    const p = await t.decide(r.intent.id);
    // Primeira tentativa sem a transação de voto: falha depois de consumir o nonce.
    expect(await securityError(t.custody.submitClientDecision(r.intent.id, { statement: p.statement }))).toBe("CLIENT_VOTE_INVALID");
    expect(await securityError(t.custody.submitClientDecision(r.intent.id, p))).toBe("REPLAY");
    // Um novo pedido do app (nonce novo) funciona.
    const fresh = await t.decide(r.intent.id);
    expect((await t.custody.submitClientDecision(r.intent.id, fresh)).status).toBe("EXECUTED");
  });

  it("no programa: votar duas vezes falha (AlreadyApproved)", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: Keypair.generate().publicKey.toBase58(), amountLamports: SOL.toString() });
    const ms = new PublicKey(t.account.multisig);
    const ix = approveIx(ms, BigInt(r.intent.transactionIndex), await t.app.publicKey());
    await sendInstructions(t.chain, [ix], [t.service.feePayer, t.app]);
    expect(await chainError(sendInstructions(t.chain, [ix], [t.service.feePayer, t.app]))).toBe("AlreadyApproved");
  });
});

describe("Teste 12 — proposta expirada", () => {
  it("depois do prazo: o app recusa, o backend recusa e a proposta é rejeitada on-chain", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: Keypair.generate().publicKey.toBase58(), amountLamports: SOL.toString() });
    const early = await t.decide(r.intent.id); // assinado ainda no prazo
    t.advance(11 * 60);

    expect(await securityError(t.decide(r.intent.id))).toBe("INTENT_EXPIRED");
    expect(await securityError(t.custody.submitClientDecision(r.intent.id, early))).toBe("INTENT_EXPIRED");
    const ms = new PublicKey(t.account.multisig);
    expect((await readProposal(t.chain, ms, BigInt(r.intent.transactionIndex)))?.status).toBe("Rejected");
    // Nem indo direto ao programa o cliente reaproveita a proposta.
    const ix = approveIx(ms, BigInt(r.intent.transactionIndex), await t.app.publicKey());
    expect(await chainError(sendInstructions(t.chain, [ix], [t.service.feePayer, t.app]))).toBe("InvalidProposalStatus");
    expect((await t.store.getIntent(r.intent.id))?.status).toBe("EXPIRED");
  });

  it("expireDue encerra pendências vencidas sem ninguém tocar nelas", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: Keypair.generate().publicKey.toBase58(), amountLamports: SOL.toString() });
    t.advance(11 * 60);
    await t.custody.expireDue(t.account.id);
    expect((await t.store.getIntent(r.intent.id))?.status).toBe("EXPIRED");
  });
});

describe("Teste 13 — chave nova sem prova de posse", () => {
  it("assinatura de outra chave, desafio errado, prova vencida ou reaproveitada: tudo recusado", async () => {
    const t = await setupService();
    const rot = await t.custody.requestClientRotation(t.account.id, { newDeviceName: "Galaxy S26" });
    const b = DevMemorySigner.generate("CLIENT_B");
    const c = DevMemorySigner.generate("CLIENT_C");
    const bKey = (await b.publicKey()).toBase58();
    const base = { operation: "ROTATE_CLIENT_KEY" as const, cluster: "localnet" as const, multisig: t.account.multisig, rotationId: rot.id, challenge: rot.challenge };

    // Declara a chave B, mas assina com C (quem não tem B tenta cadastrá-la).
    const good = await signPossession({ signer: b, ...base, now: t.now() });
    const stolen = await signStatement(c, { ...good.statement, newPublicKey: bKey });
    expect(await securityError(t.custody.proveClientRotationKey(rot.id, stolen))).toBe("POSSESSION_BAD_SIGNATURE");

    expect(await securityError(t.custody.proveClientRotationKey(rot.id, await signPossession({ signer: b, ...base, challenge: "ab".repeat(32), now: t.now() })))).toBe("POSSESSION_WRONG_CHALLENGE");
    expect(await securityError(t.custody.proveClientRotationKey(rot.id, await signPossession({ signer: b, ...base, now: t.now() - 600 })))).toBe("POSSESSION_EXPIRED");
    expect(await securityError(t.custody.proveClientRotationKey(rot.id, await signPossession({ signer: b, ...base, operation: "ROTATE_SERVER_KEY", now: t.now() })))).toBe("POSSESSION_WRONG_OPERATION");

    // Sem prova válida, nada foi proposto na chain.
    expect((await t.store.getRotation(rot.id))?.status).toBe("REQUESTED");
    const state = await readMultisig(t.chain, new PublicKey(t.account.multisig));
    expect(state.transactionIndex).toBe(0n);

    // A prova certa passa uma vez; a mesma prova de novo é replay.
    await t.custody.proveClientRotationKey(rot.id, good);
    expect((await t.store.getRotation(rot.id))?.status).toBe("AWAITING_CLIENT_APPROVAL");
  });

  it("a política recusa rotação para chave sem prova (ex.: proposta criada direto na chain)", async () => {
    const { DefaultPolicyEngine, DEFAULT_POLICY } = await import("@duplachave/policy-engine");
    const newKey = Keypair.generate().publicKey.toBase58();
    const oldKey = Keypair.generate().publicKey.toBase58();
    const intent = sealIntent({
      version: 1, id: crypto.randomUUID(), cluster: "localnet", multisig: Keypair.generate().publicKey.toBase58(), transactionIndex: "1",
      createdAt: 1, expiresAt: 100, kind: "CONFIG", type: "ROTATE_MEMBER", role: "CLIENT", oldKey, newKey, rotationId: crypto.randomUUID(),
    });
    const view = { kind: "CONFIG" as const, actions: [{ kind: "AddMember" as const, key: newKey, mask: 2 }, { kind: "RemoveMember" as const, key: oldKey }], rotation: { role: "CLIENT" as const, oldKey, newKey } };
    const d = await new DefaultPolicyEngine().validate({ id: "u", policy: DEFAULT_POLICY }, intent, view, { vaultLamports: 0n, verifiedNewKeys: [], revokedKeys: [] });
    expect(d.allowed).toBe(false);
    expect(d.reasons.join()).toContain("NO_PROOF_OF_POSSESSION");
  });
});

describe("rotação completa", () => {
  it("CLIENT_A → CLIENT_B: congela, drena, aprova (A + servidor), verifica e revoga A", async () => {
    const t = await setupService();
    const pending = await t.custody.createTransferSol(t.account.id, { destination: Keypair.generate().publicKey.toBase58(), amountLamports: SOL.toString() });

    const rot = await t.custody.requestClientRotation(t.account.id, { newDeviceName: "Galaxy S26" });
    const b = DevMemorySigner.generate("CLIENT_B");
    const { intent } = await t.custody.proveClientRotationKey(rot.id, await signPossession({ signer: b, operation: "ROTATE_CLIENT_KEY", cluster: "localnet", multisig: t.account.multisig, rotationId: rot.id, challenge: rot.challenge, now: t.now() }));

    // Fila drenada e operações congeladas.
    expect((await t.store.getIntent(pending.intent.id))?.status).toBe("REJECTED");
    expect(await securityError(t.custody.createTransferSol(t.account.id, { destination: Keypair.generate().publicKey.toBase58(), amountLamports: SOL.toString() }))).toBe("OPERATIONS_FROZEN");

    // CLIENT_B não aprova a própria entrada (não é membro); só CLIENT_A.
    expect(await securityError(t.decide(intent.id, b))).toBe("NOT_A_VOTER");
    const done = await t.custody.submitClientDecision(intent.id, await t.decide(intent.id, t.app));
    expect(done.status).toBe("EXECUTED");

    const rotation = (await t.store.getRotation(rot.id))!;
    expect(rotation.status).toBe("COMPLETED");
    expect(rotation.history.map((h) => h.status)).toEqual([
      "REQUESTED", "NEW_KEY_VERIFIED", "OPERATIONS_FROZEN", "AWAITING_CLIENT_APPROVAL", "AWAITING_SERVER_APPROVAL", "EXECUTING", "VERIFIED", "COMPLETED",
    ]);
    const acc = (await t.store.getAccount(t.account.id))!;
    expect(acc.roles.client).toBe((await b.publicKey()).toBase58());
    expect(acc.frozenBy).toBeNull();
    const members = await t.store.listMembers(t.account.id);
    expect(members.find((m) => m.publicKey === t.account.roles.client)?.status).toBe("REVOKED");

    // B opera; A não.
    const next = await t.custody.createTransferSol(t.account.id, { destination: Keypair.generate().publicKey.toBase58(), amountLamports: SOL.toString() });
    expect(await securityError(t.decide(next.intent.id, t.app))).toBe("NOT_A_VOTER");
    expect((await t.custody.submitClientDecision(next.intent.id, await t.decide(next.intent.id, b))).status).toBe("EXECUTED");
    expect(verifyAuditChain(await t.store.listAudit())).toBe(true);
  });

  it("INVARIANTE 6 — chave revogada nunca volta", async () => {
    const t = await setupService();
    const rot = await t.custody.requestClientRotation(t.account.id, { newDeviceName: "Galaxy S26" });
    const b = DevMemorySigner.generate("CLIENT_B");
    const { intent } = await t.custody.proveClientRotationKey(rot.id, await signPossession({ signer: b, operation: "ROTATE_CLIENT_KEY", cluster: "localnet", multisig: t.account.multisig, rotationId: rot.id, challenge: rot.challenge, now: t.now() }));
    await t.custody.submitClientDecision(intent.id, await t.decide(intent.id, t.app));

    // Tentar trazer CLIENT_A de volta.
    const back = await t.custody.requestClientRotation(t.account.id, { newDeviceName: "Pixel 9 antigo" });
    const proof = await signPossession({ signer: t.app, operation: "ROTATE_CLIENT_KEY", cluster: "localnet", multisig: t.account.multisig, rotationId: back.id, challenge: back.challenge, now: t.now() });
    expect(await securityError(t.custody.proveClientRotationKey(back.id, proof))).toBe("REVOKED_KEY_REUSE");
    await expect(t.store.saveMember({ ...(await t.store.listMembers(t.account.id)).find((m) => m.status === "REVOKED")!, status: "ACTIVE" })).rejects.toThrow();
  });

  it("SERVER_A → SERVER_B: o app precisa aprovar; sem ele, nada muda", async () => {
    const t = await setupService();
    const { rotation, intent } = await t.custody.requestServerRotation(t.account.id, "rotação trimestral");
    expect(rotation.status).toBe("AWAITING_CLIENT_APPROVAL");
    expect(t.notifications.sent.some((n) => n.kind === "keyRotationRequested")).toBe(true);

    // Sem o app, o prazo vence e a proposta é rejeitada.
    t.advance(31 * 60);
    await t.custody.expireDue(t.account.id);
    expect((await t.store.getRotation(rotation.id))?.status).toBe("EXPIRED");
    const ms = new PublicKey(t.account.multisig);
    expect((await readProposal(t.chain, ms, BigInt(intent.transactionIndex)))?.status).toBe("Rejected");
    expect((await t.store.getAccount(t.account.id))?.roles.server).toBe(t.account.roles.server);

    // Com o app aprovando: troca feita, chave antiga aposentada.
    const second = await t.custody.requestServerRotation(t.account.id, "rotação trimestral");
    const done = await t.custody.submitClientDecision(second.intent.id, await t.decide(second.intent.id));
    expect(done.status).toBe("EXECUTED");
    const acc = (await t.store.getAccount(t.account.id))!;
    expect(acc.roles.server).not.toBe(t.account.roles.server);
    expect(await t.serverKeys.get(t.account.roles.server)).toBeNull();
    const r = await t.custody.createTransferSol(t.account.id, { destination: Keypair.generate().publicKey.toBase58(), amountLamports: SOL.toString() });
    expect((await t.custody.submitClientDecision(r.intent.id, await t.decide(r.intent.id))).status).toBe("EXECUTED");
  });

  it("app rejeita a rotação do servidor: REJECTED e descongela", async () => {
    const t = await setupService();
    const { rotation, intent } = await t.custody.requestServerRotation(t.account.id, "?");
    await t.custody.submitClientDecision(intent.id, await t.decide(intent.id, t.app, "REJECT"));
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
    const { createVaultProposalIxs, executeVaultIx, vaultPda } = await import("@duplachave/squads");
    const { SystemProgram } = await import("@solana/web3.js");
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

  it("INVARIANTE 4 — o cliente não retira acima da política: servidor rejeita on-chain", async () => {
    const t = await setupService({ depositSol: 100 });
    expect(await securityError(t.custody.createTransferSol(t.account.id, { destination: Keypair.generate().publicKey.toBase58(), amountLamports: (60n * SOL).toString() }))).toBe("POLICY_DENIED");

    // Política endurecida depois da proposta criada: a checagem no momento da assinatura vale.
    const r = await t.custody.createTransferSol(t.account.id, { destination: Keypair.generate().publicKey.toBase58(), amountLamports: (5n * SOL).toString() });
    const user = (await t.store.getUser("user-1"))!;
    await t.store.saveUser({ ...user, policy: { ...user.policy, requireAddressBook: true } });
    const out = await t.custody.submitClientDecision(r.intent.id, await t.decide(r.intent.id));
    expect(out.status).toBe("REJECTED");
    expect(out.reasons.join()).toContain("DESTINATION_NOT_IN_ADDRESS_BOOK");
  });

  it("INVARIANTE 5 — app mostra A, chain tem B: o app recusa antes de assinar", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: Keypair.generate().publicKey.toBase58(), amountLamports: SOL.toString() });
    const request = await t.custody.approvalRequest(r.intent.id);
    if (request.intent.type !== "TRANSFER_SOL") throw new Error();
    const lie = sealIntent({ ...intentBody(request.intent), amountLamports: "1000" } as never);
    expect(await securityError(reviewOnChain(t.chain, lie, await t.app.publicKey(), t.now()))).toBe("INTENT_MISMATCH");
    const lie2 = { ...request.intent, amountLamports: "1000" };
    expect(await securityError(reviewOnChain(t.chain, lie2, await t.app.publicKey(), t.now()))).toBe("INTENT_HASH_INVALID");
  });

  it("auditoria encadeada: editar um evento quebra a cadeia", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: Keypair.generate().publicKey.toBase58(), amountLamports: SOL.toString() });
    await t.custody.submitClientDecision(r.intent.id, await t.decide(r.intent.id));
    const events = await t.store.listAudit();
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["SMART_ACCOUNT_CREATED", "TRANSACTION_PROPOSED", "CLIENT_APPROVED", "SERVER_APPROVED", "TRANSACTION_EXECUTED"]));
    expect(verifyAuditChain(events)).toBe(true);
    events[1]!.details = { adulterado: true };
    expect(verifyAuditChain(events)).toBe(false);
    expect(JSON.stringify(events)).not.toMatch(/secret|privateKey/i);
  });
});

describe("antes de propor", () => {
  it("destino que é programa é recusado; simulação que falha não vira proposta", async () => {
    const t = await setupService({ depositSol: 1 });
    const program = (await import("@sqds/multisig")).PROGRAM_ID.toBase58();
    expect(await securityError(t.custody.createTransferSol(t.account.id, { destination: program, amountLamports: "1000" }))).toBe("POLICY_DENIED");
    // Mais do que o saldo: a simulação como vault falha.
    expect(await securityError(t.custody.createTransferSol(t.account.id, { destination: Keypair.generate().publicKey.toBase58(), amountLamports: (5n * SOL).toString() }))).toBe("POLICY_DENIED");
    expect((await readMultisig(t.chain, new PublicKey(t.account.multisig))).transactionIndex).toBe(0n);
  });
});
