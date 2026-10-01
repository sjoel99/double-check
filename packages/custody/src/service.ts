import { randomUUID } from "node:crypto";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  ApprovalStatementSchema,
  type Cluster,
  deny,
  type IntentBody,
  PossessionStatementSchema,
  SecurityError,
  sealIntent,
  type TransactionIntent,
  type TransferSolIntent,
} from "@duplachave/shared";
import { randomHex, type Signed, type Signer, signStatement, verifyEd25519, verifyStatement } from "@duplachave/crypto";
import { type Chain, ChainTxError, parseInstruction, type RawInstruction, SYSTEM_PROGRAM, sendInstructions } from "@duplachave/solana";
import {
  approvalMemo,
  approveIx,
  assertStrictTwoOfTwo,
  cancelIx,
  compareIntent,
  createConfigProposalIxs,
  createStrictMultisigIx,
  createVaultProposalIxs,
  executeConfigIx,
  executeVaultIx,
  type ExpectedRoles,
  readMultisig,
  readProposal,
  readTransaction,
  rejectIx,
  rotationActions,
  type MultisigState,
  vaultPda,
  vaultMessageInstructions,
  viewConfigTransaction,
  viewVaultTransaction,
} from "@duplachave/squads";
import { DEFAULT_POLICY, type PolicyEngine, type User } from "@duplachave/policy-engine";
import type { ApprovalRequest, ClientDecisionPayload } from "./client";
import type { ServerKeyProvider, ServiceKeys } from "./keys";
import type { NotificationService } from "./notifications";
import type {
  AuditInput,
  ChallengeStore,
  IntentRecord,
  RotationRecord,
  RotationStatus,
  SmartAccountRecord,
  Store,
} from "./store";
import { renderIntent } from "./display";

export type CustodyConfig = {
  cluster: Cluster;
  chain: Chain;
  store: Store & ChallengeStore;
  policy: PolicyEngine;
  serverKeys: ServerKeyProvider;
  service: ServiceKeys;
  notifications: NotificationService;
  /** Relógio do servidor, em segundos. Injetável para teste. */
  now?: () => number;
  /** Tesouraria da Squads (ProgramConfig) para multisig_create_v2. */
  squadsTreasury: PublicKey;
  intentTtl?: number;
  rotationTtl?: number;
  log?: (msg: string) => void;
};

/** Transições permitidas da rotação. Qualquer outra é erro. */
const ROTATION_TRANSITIONS: Record<RotationStatus, RotationStatus[]> = {
  REQUESTED: ["NEW_KEY_VERIFIED", "REJECTED", "EXPIRED", "FAILED"],
  NEW_KEY_VERIFIED: ["OPERATIONS_FROZEN", "EXPIRED", "FAILED"],
  OPERATIONS_FROZEN: ["AWAITING_CLIENT_APPROVAL", "EXPIRED", "FAILED", "ROLLBACK_REQUIRED"],
  AWAITING_CLIENT_APPROVAL: ["AWAITING_SERVER_APPROVAL", "REJECTED", "EXPIRED", "FAILED"],
  AWAITING_SERVER_APPROVAL: ["EXECUTING", "REJECTED", "EXPIRED", "FAILED"],
  EXECUTING: ["VERIFIED", "FAILED", "REJECTED", "ROLLBACK_REQUIRED"],
  VERIFIED: ["COMPLETED", "ROLLBACK_REQUIRED"],
  COMPLETED: [],
  REJECTED: [],
  EXPIRED: [],
  FAILED: [],
  ROLLBACK_REQUIRED: [],
};

const TERMINAL: RotationStatus[] = ["COMPLETED", "REJECTED", "EXPIRED", "FAILED", "ROLLBACK_REQUIRED"];

export class CustodyService {
  readonly chain: Chain;
  private readonly store: Store & ChallengeStore;
  private readonly now: () => number;
  private readonly intentTtl: number;
  private readonly rotationTtl: number;
  private locks = new Map<string, Promise<unknown>>();

  constructor(private readonly cfg: CustodyConfig) {
    this.chain = cfg.chain;
    this.store = cfg.store;
    this.now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
    this.intentTtl = cfg.intentTtl ?? 10 * 60;
    this.rotationTtl = cfg.rotationTtl ?? 30 * 60;
  }

  // -------------------------------------------------------------------------
  // utilidades
  // -------------------------------------------------------------------------

  /** Uma operação por conta de cada vez (o índice da próxima transação depende disso). */
  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    this.locks.set(key, prev.then(() => next));
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }

  private async audit(e: AuditInput) {
    await this.store.appendAudit(e, this.now());
  }

  private async account(id: string): Promise<SmartAccountRecord> {
    const a = await this.store.getAccount(id);
    if (!a) deny("ACCOUNT_NOT_FOUND", `conta ${id} não existe`);
    return a;
  }

  private async user(id: string): Promise<User> {
    const u = await this.store.getUser(id);
    if (!u) deny("USER_NOT_FOUND", `usuário ${id} não existe`);
    return { id: u.id, policy: u.policy };
  }

  /** Lê a multisig na chain e confere o modelo STRICT_2_OF_2 contra os papéis esperados. */
  async verifiedState(acc: SmartAccountRecord): Promise<MultisigState> {
    const state = await readMultisig(this.chain, new PublicKey(acc.multisig));
    try {
      assertStrictTwoOfTwo(state, acc.roles);
    } catch (e) {
      await this.audit({ type: "INVARIANT_VIOLATION", accountId: acc.id, multisig: acc.multisig, details: { error: String(e) } });
      await this.store.saveSecurityEvent({ id: randomUUID(), accountId: acc.id, code: "INVARIANT_VIOLATION", message: String(e), at: this.now() });
      await this.cfg.notifications.securityAlert({ userId: acc.userId, accountId: acc.id }, { code: "INVARIANT_VIOLATION", message: String(e) });
      throw e;
    }
    return state;
  }

  private async serverSigner(acc: SmartAccountRecord): Promise<Signer> {
    const s = await this.cfg.serverKeys.get(acc.roles.server);
    if (!s) deny("SERVER_KEY_UNAVAILABLE", "chave do servidor indisponível");
    return s;
  }

  private async send(ixs: Parameters<typeof sendInstructions>[1], signers: Signer[]) {
    return sendInstructions(this.chain, ixs, [this.cfg.service.feePayer, ...signers]);
  }

  private async serverReject(acc: SmartAccountRecord, index: bigint, memo: string) {
    const server = await this.serverSigner(acc);
    return this.send([rejectIx(new PublicKey(acc.multisig), index, await server.publicKey(), memo)], [server]);
  }

  // -------------------------------------------------------------------------
  // cadastro
  // -------------------------------------------------------------------------

  async createChallenge(purpose: "ENROLL_CLIENT_KEY" | "AUTH", subject: string) {
    const c = { id: randomUUID(), purpose, subject, challenge: randomHex(32), expiresAt: this.now() + 300 };
    await this.store.putChallenge(c);
    return c;
  }

  private async checkPossession(
    signed: Signed<unknown>,
    expected: { operation: "ENROLL_CLIENT_KEY" | "ROTATE_CLIENT_KEY" | "ROTATE_SERVER_KEY"; multisig: string; rotationId: string; challenge: string; newPublicKey?: string },
  ) {
    const parsed = PossessionStatementSchema.safeParse(signed.statement);
    if (!parsed.success) deny("POSSESSION_MALFORMED", parsed.error.message);
    const st = parsed.data;
    const now = this.now();
    if (st.operation !== expected.operation) deny("POSSESSION_WRONG_OPERATION", st.operation);
    if (st.cluster !== this.cfg.cluster) deny("POSSESSION_WRONG_CLUSTER", st.cluster);
    if (st.multisig !== expected.multisig) deny("POSSESSION_WRONG_MULTISIG", st.multisig);
    if (st.rotationId !== expected.rotationId) deny("POSSESSION_WRONG_ID", st.rotationId);
    if (st.challenge !== expected.challenge) deny("POSSESSION_WRONG_CHALLENGE", "desafio diferente do emitido");
    if (expected.newPublicKey && st.newPublicKey !== expected.newPublicKey) deny("POSSESSION_WRONG_KEY", st.newPublicKey);
    if (st.expiresAt < now || st.createdAt > now + 60) deny("POSSESSION_EXPIRED", "prova fora da validade");
    if (!verifyStatement(signed as Signed<object>, new PublicKey(st.newPublicKey))) deny("POSSESSION_BAD_SIGNATURE", "assinatura não é da chave nova");
    if (!(await this.store.consumeNonce("possession", st.nonce, st.expiresAt))) deny("REPLAY", "prova de posse já usada");
    if (await this.store.isRevokedKey(st.newPublicKey)) deny("REVOKED_KEY_REUSE", "chave revogada não volta");
    return st;
  }

  /**
   * Cria a Smart Account: multisig 2-de-2 com a chave do app (posse provada),
   * uma chave nova do servidor, o executor e o proposer do serviço.
   */
  async enroll(args: { userId: string; userName?: string; deviceName: string; challengeId: string; possession: Signed<unknown> }) {
    const ch = await this.store.takeChallenge(args.challengeId);
    if (!ch || ch.purpose !== "ENROLL_CLIENT_KEY" || ch.subject !== args.userId) deny("CHALLENGE_INVALID", "desafio inexistente ou já usado");
    if (ch.expiresAt < this.now()) deny("CHALLENGE_EXPIRED", "desafio expirado");
    const st = await this.checkPossession(args.possession, { operation: "ENROLL_CLIENT_KEY", multisig: "", rotationId: ch.id, challenge: ch.challenge });

    if (!(await this.store.getUser(args.userId))) {
      await this.store.saveUser({ id: args.userId, name: args.userName ?? args.userId, policy: DEFAULT_POLICY, createdAt: this.now() });
    }
    const server = await this.cfg.serverKeys.create(`server:${args.userId}`);
    const roles: ExpectedRoles = {
      client: st.newPublicKey,
      server: (await server.publicKey()).toBase58(),
      executor: (await this.cfg.service.executor.publicKey()).toBase58(),
      proposer: (await this.cfg.service.proposer.publicKey()).toBase58(),
    };
    const createKey = randomCreateKey(this.cfg.cluster);
    const created = createStrictMultisigIx({
      createKey: await createKey.publicKey(),
      creator: await this.cfg.service.feePayer.publicKey(),
      treasury: this.cfg.squadsTreasury,
      layout: {
        client: new PublicKey(roles.client),
        server: new PublicKey(roles.server),
        executor: new PublicKey(roles.executor),
        proposer: new PublicKey(roles.proposer),
      },
    });
    const sig = await this.send([created.instruction], [createKey]);

    const deviceId = randomUUID();
    const now = this.now();
    await this.store.saveDevice({ id: deviceId, userId: args.userId, name: args.deviceName, publicKey: roles.client, createdAt: now, revokedAt: null });
    const acc: SmartAccountRecord = {
      id: randomUUID(),
      userId: args.userId,
      cluster: this.cfg.cluster,
      multisig: created.multisig.toBase58(),
      vault: created.vault.toBase58(),
      roles,
      frozenBy: null,
      createdAt: now,
    };
    await this.store.saveAccount(acc);
    await this.verifiedState(acc);
    const member = (publicKey: string, role: "CLIENT" | "SERVER" | "EXECUTOR" | "PROPOSER", permissions: number, dev: string | null = null) =>
      this.store.saveMember({ accountId: acc.id, publicKey, role, permissions, status: "ACTIVE", deviceId: dev, createdAt: now, revokedAt: null });
    await member(roles.client, "CLIENT", 2, deviceId);
    await member(roles.server, "SERVER", 2);
    await member(roles.executor, "EXECUTOR", 4);
    await member(roles.proposer, "PROPOSER", 1);
    await this.audit({ type: "SMART_ACCOUNT_CREATED", accountId: acc.id, userId: acc.userId, deviceId, multisig: acc.multisig, txSignature: sig, publicKey: roles.client });
    return { account: acc, deviceId };
  }

  // -------------------------------------------------------------------------
  // operações (VaultTransaction)
  // -------------------------------------------------------------------------

  async createTransferSol(accountId: string, req: { destination: string; amountLamports: string }) {
    return this.withLock(accountId, async () => {
      const acc = await this.account(accountId);
      if (acc.frozenBy) deny("OPERATIONS_FROZEN", "rotação de chave em andamento");
      const user = await this.user(acc.userId);
      const state = await this.verifiedState(acc);
      const ms = new PublicKey(acc.multisig);
      const vault = vaultPda(ms, 0);
      const destination = new PublicKey(req.destination);
      const amount = BigInt(req.amountLamports);
      if (amount <= 0n) deny("INVALID_AMOUNT", "valor deve ser positivo");

      const index = state.transactionIndex + 1n;
      const now = this.now();
      const body: TransferSolIntent = {
        version: 1,
        id: randomUUID(),
        cluster: this.cfg.cluster,
        multisig: acc.multisig,
        transactionIndex: index.toString(),
        createdAt: now,
        expiresAt: now + this.intentTtl,
        kind: "OPERATION",
        type: "TRANSFER_SOL",
        vault: vault.toBase58(),
        vaultIndex: 0,
        amountLamports: amount.toString(),
        destination: destination.toBase58(),
        programs: [SYSTEM_PROGRAM.toBase58()],
      };
      const intent = sealIntent(body);
      const instructions = [SystemProgram.transfer({ fromPubkey: vault, toPubkey: destination, lamports: amount })];

      // Política antes de criar qualquer coisa na chain, com a mesma visão que
      // o servidor usará para assinar (a mensagem é reconstruída dos bytes).
      const preview = previewVaultView(vault, instructions);
      const vaultLamports = await this.chain.getBalance(vault);
      const pre = await this.cfg.policy.validate(user, intent, preview, { vaultLamports, verifiedNewKeys: [], revokedKeys: [] });

      // Destino: programa (executável) não recebe SOL; conta de outro programa é marcada.
      const destInfo = await this.chain.getAccountInfo(destination);
      if (destInfo?.executable) {
        pre.allowed = false;
        pre.reasons.push("DESTINATION_IS_PROGRAM: o destino é um programa, não uma carteira");
      } else if (destInfo && !destInfo.owner.equals(SystemProgram.programId)) {
        pre.riskFlags.push("DESTINATION_NOT_WALLET");
      }
      // Simulação como o vault: o que falharia na execução não vira proposta.
      if (pre.allowed && this.chain.simulate) {
        const sim = await this.chain.simulate(vault, instructions);
        if (!sim.ok) {
          pre.allowed = false;
          pre.reasons.push(`SIMULATION_FAILED: ${sim.error}`);
        }
      }
      if (!pre.allowed) {
        await this.audit({ type: "TRANSACTION_POLICY_DENIED", accountId, multisig: acc.multisig, intentId: intent.id, intentHash: intent.intentHash, details: { reasons: pre.reasons } });
        throw new SecurityError("POLICY_DENIED", pre.reasons.join("; "));
      }

      const proposer = this.cfg.service.proposer;
      const ixs = createVaultProposalIxs({
        multisig: ms,
        index,
        proposer: await proposer.publicKey(),
        rentPayer: await this.cfg.service.feePayer.publicKey(),
        instructions,
        recentBlockhash: await this.chain.getLatestBlockhash(),
        memo: `dk1:intent:${intent.intentHash.slice(0, 32)}`,
      });
      const sig = await this.send(ixs, [proposer]);

      // Relê da chain e confere: o que foi criado é o que a intenção diz.
      const onchain = await readTransaction(this.chain, ms, index);
      if (!onchain || onchain.kind !== "VAULT") deny("TX_NOT_CREATED", "transação não apareceu na chain");
      const diffs = compareIntent(intent, viewVaultTransaction(onchain, vault));
      if (diffs.length) deny("INTENT_MISMATCH", diffs.join("; "));

      const rec: IntentRecord = {
        intent,
        accountId,
        transactionHash: onchain.hash,
        status: "AWAITING_CLIENT",
        riskFlags: pre.riskFlags,
        reasons: [],
        signatures: { create: sig },
        updatedAt: now,
      };
      await this.store.saveIntent(rec);
      await this.store.saveSquadsTransaction({ accountId, multisig: acc.multisig, transactionIndex: index.toString(), kind: "VAULT", address: onchain.address, hash: onchain.hash, intentId: intent.id, createSignature: sig, createdAt: now });
      await this.audit({ type: "TRANSACTION_PROPOSED", accountId, multisig: acc.multisig, transactionIndex: index.toString(), intentId: intent.id, intentHash: intent.intentHash, txSignature: sig });
      await this.cfg.notifications.transactionApprovalRequested(
        { userId: acc.userId, accountId },
        { intentId: intent.id, summary: renderIntent(intent).rows.map((r) => `${r.label}: ${r.value}`).slice(0, 2).join(" · ") },
      );
      return rec;
    });
  }

  /** O que o app recebe para revisar. O app confere tudo na chain antes de assinar. */
  async approvalRequest(intentId: string): Promise<ApprovalRequest> {
    const rec = await this.store.getIntent(intentId);
    if (!rec) deny("INTENT_NOT_FOUND", intentId);
    let deviceName: string | null = null;
    let possession: Signed<unknown> | null = null;
    if (rec.intent.type === "ROTATE_MEMBER") {
      const rot = await this.store.getRotation(rec.intent.rotationId);
      deviceName = rot?.newDeviceName ?? null;
      possession = (rot?.possession as Signed<unknown> | null) ?? null;
    }
    return {
      intent: rec.intent,
      riskFlags: rec.riskFlags,
      feePayer: (await this.cfg.service.feePayer.publicKey()).toBase58(),
      recentBlockhash: await this.chain.getLatestBlockhash(),
      deviceName,
      possession,
    };
  }

  /**
   * Recebe a decisão assinada pelo app. Para APPROVE: confere a declaração e o
   * voto do cliente, envia o voto, roda a política com estado fresco da chain,
   * e só então o servidor assina e o executor executa.
   */
  async submitClientDecision(intentId: string, payload: ClientDecisionPayload) {
    const first = await this.store.getIntent(intentId);
    if (!first) deny("INTENT_NOT_FOUND", intentId);
    return this.withLock(first.accountId, async () => {
      const rec = (await this.store.getIntent(intentId))!;
      const acc = await this.account(rec.accountId);
      const intent = rec.intent;
      const index = BigInt(intent.transactionIndex);
      const ms = new PublicKey(acc.multisig);
      const refuse = async (code: string, msg: string): Promise<never> => {
        await this.audit({ type: "APPROVAL_REFUSED", accountId: acc.id, multisig: acc.multisig, transactionIndex: intent.transactionIndex, intentId, intentHash: intent.intentHash, details: { code, msg } });
        throw new SecurityError(code, msg);
      };

      const cancelling = (payload.statement?.statement as { decision?: string } | undefined)?.decision === "CANCEL";
      if (cancelling) {
        if (rec.status !== "APPROVED_PENDING_EXECUTION") return refuse("INTENT_NOT_CANCELLABLE", `intenção em ${rec.status}`);
      } else if (rec.status !== "AWAITING_CLIENT") return refuse("INTENT_NOT_PENDING", `intenção em ${rec.status}`);
      if (!cancelling && this.now() > intent.expiresAt) {
        await this.expireIntent(rec, acc);
        return refuse("INTENT_EXPIRED", "intenção expirada; proposta rejeitada on-chain");
      }

      // 1. Declaração assinada: formato, vínculos e validade.
      const parsed = ApprovalStatementSchema.safeParse(payload.statement?.statement);
      if (!parsed.success) return refuse("STATEMENT_MALFORMED", parsed.error.message);
      const st = parsed.data;
      const mismatch =
        st.cluster !== this.cfg.cluster ||
        st.multisig !== acc.multisig ||
        st.transactionIndex !== intent.transactionIndex ||
        st.intentId !== intent.id ||
        st.intentHash !== intent.intentHash ||
        st.transactionKind !== (intent.kind === "OPERATION" ? "VAULT" : "CONFIG");
      if (mismatch) return refuse("STATEMENT_MISMATCH", "declaração não corresponde a esta intenção");
      const now = this.now();
      if (st.expiresAt < now || st.createdAt > now + 60 || (!cancelling && st.expiresAt > intent.expiresAt)) return refuse("STATEMENT_EXPIRED", "declaração fora da validade");

      // 2. Quem assinou é o CLIENT atual segundo a chain (não segundo o banco).
      const state = await this.verifiedState(acc);
      if (st.signer !== acc.roles.client) return refuse("NOT_CURRENT_CLIENT", "a chave que assinou não é a CLIENT_APPROVAL_KEY atual");
      if (!state.members.some((m) => m.key === st.signer && m.vote)) return refuse("NOT_CURRENT_CLIENT", "chave não é votante on-chain");
      if (!verifyStatement(payload.statement as Signed<object>, new PublicKey(st.signer))) return refuse("BAD_SIGNATURE", "assinatura da declaração inválida");

      // 3. O conteúdo on-chain é o mesmo que o app viu e o mesmo da intenção.
      const onchain = await readTransaction(this.chain, ms, index);
      if (!onchain) return refuse("TX_NOT_FOUND", "transação sumiu da chain");
      if (onchain.hash !== st.transactionHash || onchain.hash !== rec.transactionHash) return refuse("TX_HASH_MISMATCH", "conteúdo on-chain difere do aprovado");
      const view = onchain.kind === "VAULT" ? viewVaultTransaction(onchain, vaultPda(ms, 0)) : viewConfigTransaction(onchain, state, acc.roles);
      const diffs = compareIntent(intent, view);
      if (diffs.length) return refuse("INTENT_MISMATCH", diffs.join("; "));

      // 4. Uso único.
      if (!(await this.store.consumeNonce(`approval:${acc.multisig}`, st.nonce, st.expiresAt))) return refuse("REPLAY", "declaração já usada");

      const target = { userId: acc.userId, accountId: acc.id };
      if (st.decision === "CANCEL") return this.cancelApproved(acc, rec, payload, st.signer);
      if (st.decision === "REJECT") {
        const sig = await this.serverReject(acc, index, `dk1:client-reject:${intent.intentHash.slice(0, 32)}`);
        rec.status = "REJECTED";
        rec.signatures.reject = sig;
        rec.updatedAt = now;
        await this.store.saveIntent(rec);
        await this.store.saveApproval({ id: randomUUID(), intentId, accountId: acc.id, publicKey: st.signer, role: "CLIENT", decision: "REJECT", statement: payload.statement, txSignature: sig, createdAt: now });
        await this.audit({ type: "CLIENT_REJECTED", accountId: acc.id, publicKey: st.signer, multisig: acc.multisig, transactionIndex: intent.transactionIndex, intentId, intentHash: intent.intentHash, txSignature: sig });
        if (intent.type === "ROTATE_MEMBER") await this.finishRotation(intent.rotationId, "REJECTED", "cliente rejeitou");
        return rec;
      }

      // 5. O voto do cliente: exatamente proposal_approve(multisig, índice, cliente).
      const clientSig = await this.relayClientVote(acc, intent, onchain.hash, payload.approveTransaction, "APPROVE").catch((e) => refuse("CLIENT_VOTE_INVALID", String(e)));
      rec.status = "AWAITING_SERVER";
      rec.signatures.clientApprove = clientSig;
      rec.updatedAt = this.now();
      await this.store.saveIntent(rec);
      await this.store.saveApproval({ id: randomUUID(), intentId, accountId: acc.id, publicKey: st.signer, role: "CLIENT", decision: "APPROVE", statement: payload.statement, txSignature: clientSig, createdAt: this.now() });
      await this.audit({ type: "CLIENT_APPROVED", accountId: acc.id, publicKey: st.signer, multisig: acc.multisig, transactionIndex: intent.transactionIndex, intentId, intentHash: intent.intentHash, txSignature: clientSig });
      if (intent.type === "ROTATE_MEMBER") await this.advanceRotation(intent.rotationId, "AWAITING_SERVER_APPROVAL");

      // 6. Política com estado fresco, e só então o servidor assina.
      const user = await this.user(acc.userId);
      const rotation = intent.type === "ROTATE_MEMBER" ? await this.store.getRotation(intent.rotationId) : null;
      const decision = await this.cfg.policy.validate(user, intent, view, {
        vaultLamports: await this.chain.getBalance(vaultPda(ms, 0)),
        verifiedNewKeys: rotation?.newKey && rotation.history.some((h) => h.status === "NEW_KEY_VERIFIED") ? [rotation.newKey] : [],
        revokedKeys: rotation?.newKey && (await this.store.isRevokedKey(rotation.newKey)) ? [rotation.newKey] : [],
      });
      if (intent.type === "ROTATE_MEMBER") {
        // A chave nova do SERVIDOR tem que ser uma chave que o servidor controla; a do CLIENTE, nunca.
        const serverControls = Boolean(await this.cfg.serverKeys.get(intent.newKey));
        if (intent.role === "SERVER" && !serverControls) decision.reasons.push("SERVER_KEY_NOT_CONTROLLED: a chave nova do servidor não está no provedor de chaves");
        if (intent.role === "CLIENT" && serverControls) decision.reasons.push("CLIENT_KEY_IS_SERVER_KEY");
        if (rotation?.role !== intent.role) decision.reasons.push("ROTATION_ROLE_MISMATCH");
        decision.allowed = decision.reasons.length === 0;
      } else if (view.kind === "VAULT" && this.chain.simulate) {
        // Estado mudou desde a proposta (saldo, contas): simula de novo antes de votar.
        const sim = await this.chain.simulate(vaultPda(ms, 0), vaultMessageInstructions(onchain.kind === "VAULT" ? onchain.account : (null as never)).map(toInstruction));
        if (!sim.ok) {
          decision.allowed = false;
          decision.reasons.push(`SIMULATION_FAILED: ${sim.error}`);
        }
      }
      if (!decision.allowed) {
        const sig = await this.serverReject(acc, index, `dk1:policy-reject:${intent.intentHash.slice(0, 32)}`);
        rec.status = "REJECTED";
        rec.reasons = decision.reasons;
        rec.signatures.reject = sig;
        await this.store.saveIntent(rec);
        await this.audit({ type: "SERVER_REJECTED", accountId: acc.id, multisig: acc.multisig, transactionIndex: intent.transactionIndex, intentId, intentHash: intent.intentHash, txSignature: sig, details: { reasons: decision.reasons } });
        if (intent.type === "ROTATE_MEMBER") await this.finishRotation(intent.rotationId, "REJECTED", "política recusou");
        await this.cfg.notifications.securityAlert(target, { code: "POLICY_DENIED", message: decision.reasons.join("; ") });
        return rec;
      }

      const server = await this.serverSigner(acc);
      const serverSig = await this.send([approveIx(ms, index, await server.publicKey(), approvalMemo(intent.intentHash, onchain.hash))], [server]);
      rec.signatures.serverApprove = serverSig;
      rec.status = "EXECUTING";
      await this.store.saveIntent(rec);
      await this.store.saveApproval({ id: randomUUID(), intentId, accountId: acc.id, publicKey: acc.roles.server, role: "SERVER", decision: "APPROVE", statement: { policy: "allowed", riskFlags: decision.riskFlags }, txSignature: serverSig, createdAt: this.now() });
      await this.audit({ type: "SERVER_APPROVED", accountId: acc.id, publicKey: acc.roles.server, multisig: acc.multisig, transactionIndex: intent.transactionIndex, intentId, intentHash: intent.intentHash, txSignature: serverSig });

      const proposal = await readProposal(this.chain, ms, index);
      if (proposal?.status !== "Approved") deny("NOT_APPROVED", `proposta em ${proposal?.status}`);
      await this.audit({ type: "TRANSACTION_APPROVED", accountId: acc.id, multisig: acc.multisig, transactionIndex: intent.transactionIndex, intentId, intentHash: intent.intentHash });

      // 7. Execução.
      if (intent.type === "ROTATE_MEMBER") {
        await this.executeRotation(acc, rec);
      } else {
        await this.executeVault(acc, rec);
      }
      return (await this.store.getIntent(intentId))!;
    });
  }

  /**
   * Executa uma VaultTransaction aprovada. Se falhar, a proposta continua
   * executável on-chain: a intenção vai para APPROVED_PENDING_EXECUTION (nunca
   * "falhou"), e o usuário escolhe tentar de novo ou cancelar (CLIENT + SERVER).
   */
  private async executeVault(acc: SmartAccountRecord, rec: IntentRecord) {
    const intent = rec.intent;
    const ms = new PublicKey(acc.multisig);
    const index = BigInt(intent.transactionIndex);
    const executor = this.cfg.service.executor;
    try {
      const { instruction, lookupTableAccounts } = await executeVaultIx(this.chain, ms, index, await executor.publicKey());
      const execSig = await sendInstructions(this.chain, [instruction], [this.cfg.service.feePayer, executor], lookupTableAccounts);
      rec.signatures.execute = execSig;
      rec.status = "EXECUTED";
      rec.reasons = [];
      rec.updatedAt = this.now();
      await this.store.saveIntent(rec);
      await this.audit({ type: "TRANSACTION_EXECUTED", accountId: acc.id, multisig: acc.multisig, transactionIndex: intent.transactionIndex, intentId: intent.id, intentHash: intent.intentHash, txSignature: execSig });
    } catch (e) {
      rec.status = "APPROVED_PENDING_EXECUTION";
      rec.reasons = [`EXECUTION_FAILED: ${e instanceof ChainTxError ? (e.programError ?? e.message) : String(e)}`];
      rec.updatedAt = this.now();
      await this.store.saveIntent(rec);
      await this.audit({ type: "EXECUTION_FAILED", accountId: acc.id, multisig: acc.multisig, transactionIndex: intent.transactionIndex, intentId: intent.id, intentHash: intent.intentHash, details: { reasons: rec.reasons } });
      await this.store.saveSecurityEvent({ id: randomUUID(), accountId: acc.id, code: "APPROVED_NOT_EXECUTED", message: `proposta ${intent.transactionIndex} aprovada e não executada: executar de novo ou cancelar`, at: this.now() });
    }
  }

  /** Tenta de novo a execução de uma aprovada (VaultTransaction ou rotação). */
  async retryExecution(intentId: string) {
    const first = await this.store.getIntent(intentId);
    if (!first) deny("INTENT_NOT_FOUND", intentId);
    return this.withLock(first.accountId, async () => {
      const rec = (await this.store.getIntent(intentId))!;
      const acc = await this.account(rec.accountId);
      if (rec.status !== "APPROVED_PENDING_EXECUTION") deny("INTENT_NOT_PENDING_EXECUTION", rec.status);
      const p = await readProposal(this.chain, new PublicKey(acc.multisig), BigInt(rec.intent.transactionIndex));
      if (p?.status !== "Approved") deny("NOT_APPROVED", `proposta em ${p?.status}`);
      if (rec.intent.type === "ROTATE_MEMBER") await this.executeRotation(acc, rec);
      else await this.executeVault(acc, rec);
      return (await this.store.getIntent(intentId))!;
    });
  }

  /** Cancela uma aprovada não executada: voto de cancelamento do cliente + do servidor. */
  private async cancelApproved(acc: SmartAccountRecord, rec: IntentRecord, payload: ClientDecisionPayload, signer: string) {
    const intent = rec.intent;
    const ms = new PublicKey(acc.multisig);
    const index = BigInt(intent.transactionIndex);
    const clientSig = await this.relayClientVote(acc, intent, rec.transactionHash, payload.approveTransaction, "CANCEL").catch((e) => {
      throw new SecurityError("CLIENT_VOTE_INVALID", String(e));
    });
    const server = await this.serverSigner(acc);
    const serverSig = await this.send([cancelIx(ms, index, await server.publicKey(), `dk1:cancel:${intent.intentHash.slice(0, 32)}`)], [server]);
    const p = await readProposal(this.chain, ms, index);
    if (p?.status !== "Cancelled") deny("NOT_CANCELLED", `proposta em ${p?.status}`);
    rec.status = "CANCELLED";
    rec.signatures.reject = serverSig;
    rec.updatedAt = this.now();
    await this.store.saveIntent(rec);
    await this.store.saveApproval({ id: randomUUID(), intentId: intent.id, accountId: acc.id, publicKey: signer, role: "CLIENT", decision: "CANCEL", statement: payload.statement, txSignature: clientSig, createdAt: this.now() });
    await this.audit({ type: "TRANSACTION_CANCELLED", accountId: acc.id, multisig: acc.multisig, transactionIndex: intent.transactionIndex, intentId: intent.id, intentHash: intent.intentHash, txSignature: serverSig });
    if (intent.type === "ROTATE_MEMBER") await this.finishRotation(intent.rotationId, "REJECTED", "aprovada e cancelada");
    return rec;
  }

  /** Confere a transação de voto montada pelo app e a envia, pagando a taxa. */
  private async relayClientVote(acc: SmartAccountRecord, intent: TransactionIntent, txHash: string, b64: string | undefined, kind: "APPROVE" | "CANCEL"): Promise<string> {
    if (!b64) deny("NO_VOTE", "aprovação sem a transação de voto");
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
    const feePayer = await this.cfg.service.feePayer.publicKey();
    const client = new PublicKey(acc.roles.client);
    const msg = TransactionMessage.decompile(tx.message);
    if (!msg.payerKey.equals(feePayer)) deny("WRONG_PAYER", "pagador inesperado");
    if (tx.message.addressTableLookups.length) deny("ALT_IN_VOTE", "voto com lookup table");
    if (msg.instructions.length !== 1) deny("VOTE_EXTRA_INSTRUCTIONS", "voto deve ter exatamente uma instrução");
    const expected = (kind === "CANCEL" ? cancelIx : approveIx)(new PublicKey(acc.multisig), BigInt(intent.transactionIndex), client, approvalMemo(intent.intentHash, txHash));
    const got = msg.instructions[0]!;
    const sameKeys =
      got.keys.length === expected.keys.length &&
      got.keys.every((k, i) => k.pubkey.equals(expected.keys[i]!.pubkey) && k.isSigner === expected.keys[i]!.isSigner && k.isWritable === expected.keys[i]!.isWritable);
    if (!got.programId.equals(expected.programId) || !sameKeys || !Buffer.from(got.data).equals(Buffer.from(expected.data)))
      deny("VOTE_NOT_EXPECTED", "a instrução não é o voto esperado para esta intenção");
    const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
    const ci = signers.findIndex((k) => k.equals(client));
    if (ci < 0 || !verifyEd25519(tx.message.serialize(), tx.signatures[ci]!, client)) deny("VOTE_BAD_SIGNATURE", "voto sem assinatura válida do cliente");
    tx.addSignature(feePayer, await this.cfg.service.feePayer.sign(tx.message.serialize()));
    try {
      return await this.chain.sendTransaction(tx);
    } catch (e) {
      if (e instanceof ChainTxError) deny("CLIENT_VOTE_FAILED", e.programError ?? e.message);
      throw e;
    }
  }

  private async expireIntent(rec: IntentRecord, acc: SmartAccountRecord) {
    const index = BigInt(rec.intent.transactionIndex);
    const p = await readProposal(this.chain, new PublicKey(acc.multisig), index);
    // Já aprovada pelos dois: não é "vencida", é execução pendente — nunca descongela nem esconde.
    if (p?.status === "Approved") return;
    let sig: string | undefined;
    if (p?.status === "Active") sig = await this.serverReject(acc, index, `dk1:expired:${rec.intent.intentHash.slice(0, 32)}`);
    rec.status = "EXPIRED";
    if (sig) rec.signatures.reject = sig;
    rec.updatedAt = this.now();
    await this.store.saveIntent(rec);
    await this.audit({ type: "TRANSACTION_EXPIRED", accountId: acc.id, multisig: acc.multisig, transactionIndex: rec.intent.transactionIndex, intentId: rec.intent.id, intentHash: rec.intent.intentHash, txSignature: sig ?? null });
    if (rec.intent.type === "ROTATE_MEMBER") await this.finishRotation(rec.intent.rotationId, "EXPIRED", "aprovação não chegou a tempo");
  }

  /**
   * Varre intenções vencidas e as encerra on-chain (um voto de rejeição basta em 2-de-2).
   * Roda sob o mesmo lock das decisões; um item com erro não impede os outros.
   */
  async expireDue(accountId: string) {
    return this.withLock(accountId, async () => {
      const acc = await this.account(accountId);
      const now = this.now();
      for (const rec of await this.store.listIntents(accountId)) {
        if ((rec.status === "AWAITING_CLIENT" || rec.status === "AWAITING_SERVER") && now > rec.intent.expiresAt) {
          try {
            await this.expireIntent(rec, acc);
          } catch (e) {
            this.cfg.log?.(`expirar ${rec.intent.id}: ${String(e)}`);
          }
        }
      }
      for (const rot of await this.store.listRotations(accountId)) {
        if (TERMINAL.includes(rot.status) || now <= rot.expiresAt) continue;
        if (["EXECUTING", "VERIFIED"].includes(rot.status)) continue; // em execução: quem resolve é a execução
        const rec = rot.intentId ? await this.store.getIntent(rot.intentId) : null;
        if (rec && ["AWAITING_CLIENT", "AWAITING_SERVER", "APPROVED_PENDING_EXECUTION", "EXECUTING"].includes(rec.status)) continue;
        try {
          await this.finishRotation(rot.id, "EXPIRED", "prazo da rotação venceu");
        } catch (e) {
          this.cfg.log?.(`expirar rotação ${rot.id}: ${String(e)}`);
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  // rotação (ConfigTransaction)
  // -------------------------------------------------------------------------

  private async advanceRotation(id: string, to: RotationStatus, note?: string, patch: Partial<RotationRecord> = {}) {
    const rot = await this.store.getRotation(id);
    if (!rot) deny("ROTATION_NOT_FOUND", id);
    if (!ROTATION_TRANSITIONS[rot.status].includes(to)) deny("ROTATION_BAD_TRANSITION", `${rot.status} → ${to}`);
    const next: RotationRecord = { ...rot, ...patch, status: to, history: [...rot.history, { status: to, at: this.now(), note }] };
    await this.store.saveRotation(next);
    return next;
  }

  /** Encerra uma rotação sem sucesso: mata a proposta on-chain, se houver, e descongela. */
  private async finishRotation(id: string, to: "REJECTED" | "EXPIRED" | "FAILED", note: string) {
    const rot = await this.store.getRotation(id);
    if (!rot || TERMINAL.includes(rot.status)) return;
    const acc = await this.account(rot.accountId);
    if (rot.intentId) {
      const rec = await this.store.getIntent(rot.intentId);
      if (rec && !["REJECTED", "EXPIRED", "EXECUTED"].includes(rec.status)) {
        const p = await readProposal(this.chain, new PublicKey(acc.multisig), BigInt(rec.intent.transactionIndex));
        if (p?.status === "Active") rec.signatures.reject = await this.serverReject(acc, BigInt(rec.intent.transactionIndex), `dk1:rotation-${to.toLowerCase()}`);
        rec.status = to === "EXPIRED" ? "EXPIRED" : to === "FAILED" ? "FAILED" : "REJECTED";
        await this.store.saveIntent(rec);
      }
    }
    if (ROTATION_TRANSITIONS[rot.status].includes(to)) await this.advanceRotation(id, to, note);
    else await this.store.saveRotation({ ...rot, status: "FAILED", history: [...rot.history, { status: "FAILED", at: this.now(), note: `${note} (de ${rot.status})` }] });
    if (acc.frozenBy === id) {
      await this.store.saveAccount({ ...acc, frozenBy: null });
      await this.audit({ type: "OPERATIONS_UNFROZEN", accountId: acc.id, multisig: acc.multisig, details: { rotationId: id } });
    }
    const type = to === "REJECTED" ? "ROTATION_REJECTED" : to === "EXPIRED" ? "ROTATION_EXPIRED" : "ROTATION_FAILED";
    await this.audit({ type, accountId: acc.id, multisig: acc.multisig, details: { rotationId: id, note } });
  }

  /** Aprovada e não executada sobrevive à rotação: precisa sair da fila antes. */
  private async assertNoApprovedPending(acc: SmartAccountRecord, state: MultisigState) {
    const ms = new PublicKey(acc.multisig);
    for (let i = state.staleTransactionIndex + 1n; i <= state.transactionIndex; i++) {
      if ((await readProposal(this.chain, ms, i))?.status === "Approved")
        deny("APPROVED_PENDING", `proposta ${i} aprovada e não executada: execute ou cancele antes de trocar chaves`);
    }
  }

  /** Passo 1 (CLIENT): o app atual pede a troca; o backend emite o desafio para a chave nova. */
  async requestClientRotation(accountId: string, args: { newDeviceName: string }) {
    return this.withLock(accountId, async () => {
      const acc = await this.account(accountId);
      const state = await this.verifiedState(acc);
      const open = (await this.store.listRotations(accountId)).find((r) => !TERMINAL.includes(r.status));
      if (open) deny("ROTATION_IN_PROGRESS", open.id);
      await this.assertNoApprovedPending(acc, state);
      const now = this.now();
      const rot: RotationRecord = {
        id: randomUUID(),
        accountId,
        role: "CLIENT",
        oldKey: acc.roles.client,
        newKey: null,
        newDeviceName: args.newDeviceName,
        status: "REQUESTED",
        challenge: randomHex(32),
        createdAt: now,
        expiresAt: now + this.rotationTtl,
        intentId: null,
        possession: null,
        history: [{ status: "REQUESTED", at: now }],
      };
      await this.store.saveRotation(rot);
      await this.audit({ type: "CLIENT_KEY_ROTATION_REQUESTED", accountId, multisig: acc.multisig, publicKey: acc.roles.client, details: { rotationId: rot.id, newDeviceName: args.newDeviceName } });
      return rot;
    });
  }

  /** Passo 2 (CLIENT): o dispositivo novo prova posse; o backend congela, drena e propõe. */
  async proveClientRotationKey(rotationId: string, possession: Signed<unknown>) {
    const rot0 = await this.store.getRotation(rotationId);
    if (!rot0) deny("ROTATION_NOT_FOUND", rotationId);
    return this.withLock(rot0.accountId, async () => {
      const rot = (await this.store.getRotation(rotationId))!;
      const acc = await this.account(rot.accountId);
      if (rot.role !== "CLIENT") deny("ROTATION_WRONG_ROLE", "esta rotação não é da chave do cliente");
      if (rot.status !== "REQUESTED") deny("ROTATION_BAD_STATE", rot.status);
      if (this.now() > rot.expiresAt) {
        await this.finishRotation(rot.id, "EXPIRED", "prova chegou depois do prazo");
        deny("ROTATION_EXPIRED", "rotação expirada");
      }
      let st;
      try {
        st = await this.checkPossession(possession, { operation: "ROTATE_CLIENT_KEY", multisig: acc.multisig, rotationId, challenge: rot.challenge });
      } catch (e) {
        await this.audit({ type: "NEW_KEY_PROOF_REFUSED", accountId: acc.id, multisig: acc.multisig, details: { rotationId, error: String(e) } });
        throw e;
      }
      const state = await this.verifiedState(acc);
      if (state.members.some((m) => m.key === st.newPublicKey)) deny("KEY_ALREADY_MEMBER", "a chave nova já é membro");
      if (await this.cfg.serverKeys.get(st.newPublicKey)) deny("CLIENT_KEY_IS_SERVER_KEY", "chave do servidor não pode virar chave do cliente");
      await this.advanceRotation(rotationId, "NEW_KEY_VERIFIED", undefined, { newKey: st.newPublicKey, possession });
      await this.audit({ type: "NEW_KEY_PROOF_VERIFIED", accountId: acc.id, multisig: acc.multisig, publicKey: st.newPublicKey, details: { rotationId } });
      return this.freezeAndPropose(rotationId);
    });
  }

  /** Rotação da chave do servidor: o backend gera a nova, prova posse sozinho, e o app precisa aprovar. */
  async requestServerRotation(accountId: string, reason: string) {
    return this.withLock(accountId, async () => {
      const acc = await this.account(accountId);
      const state = await this.verifiedState(acc);
      const open = (await this.store.listRotations(accountId)).find((r) => !TERMINAL.includes(r.status));
      if (open) deny("ROTATION_IN_PROGRESS", open.id);
      await this.assertNoApprovedPending(acc, state);
      const now = this.now();
      const rot: RotationRecord = {
        id: randomUUID(),
        accountId,
        role: "SERVER",
        oldKey: acc.roles.server,
        newKey: null,
        newDeviceName: null,
        status: "REQUESTED",
        challenge: randomHex(32),
        createdAt: now,
        expiresAt: now + this.rotationTtl,
        intentId: null,
        possession: null,
        history: [{ status: "REQUESTED", at: now, note: reason }],
      };
      await this.store.saveRotation(rot);
      await this.audit({ type: "SERVER_KEY_ROTATION_REQUESTED", accountId, multisig: acc.multisig, publicKey: acc.roles.server, details: { rotationId: rot.id, reason } });

      try {
      const newKey = await this.cfg.serverKeys.create(`server:${acc.userId}:rot:${rot.id}`);
      const possession = await signStatement(newKey, {
        domain: "duplachave/possession/v1",
        operation: "ROTATE_SERVER_KEY",
        cluster: this.cfg.cluster,
        multisig: acc.multisig,
        rotationId: rot.id,
        newPublicKey: (await newKey.publicKey()).toBase58(),
        challenge: rot.challenge,
        nonce: randomHex(16),
        createdAt: now,
        expiresAt: now + 300,
      });
      const st = await this.checkPossession(possession, { operation: "ROTATE_SERVER_KEY", multisig: acc.multisig, rotationId: rot.id, challenge: rot.challenge });
      await this.advanceRotation(rot.id, "NEW_KEY_VERIFIED", undefined, { newKey: st.newPublicKey, possession });
      await this.audit({ type: "NEW_KEY_PROOF_VERIFIED", accountId, multisig: acc.multisig, publicKey: st.newPublicKey, details: { rotationId: rot.id } });
      } catch (e) {
        await this.finishRotation(rot.id, "FAILED", `pedido do servidor falhou: ${String(e)}`);
        throw e;
      }
      return this.freezeAndPropose(rot.id);
    });
  }

  /**
   * Congela operações, drena a fila (rejeita propostas ativas; uma vault
   * transaction já aprovada continua executável depois da rotação, então
   * aprovadas pendentes bloqueiam) e cria a ConfigTransaction atômica.
   */
  private async freezeAndPropose(rotationId: string) {
    let created: bigint | null = null;
    try {
      return await this.freezeAndProposeInner(rotationId, (i) => (created = i));
    } catch (e) {
      // Qualquer falha encerra a rotação e descongela; proposta criada sem registro é rejeitada.
      const rot = await this.store.getRotation(rotationId);
      if (rot && !rot.intentId && created !== null) {
        const acc = await this.account(rot.accountId);
        const p = await readProposal(this.chain, new PublicKey(acc.multisig), created).catch(() => null);
        if (p?.status === "Active") await this.serverReject(acc, created, "dk1:rotation-failed").catch(() => {});
      }
      await this.finishRotation(rotationId, "FAILED", String(e)).catch(() => {});
      throw e;
    }
  }

  private async freezeAndProposeInner(rotationId: string, onCreate: (index: bigint) => void) {
    let rot = (await this.store.getRotation(rotationId))!;
    let acc = await this.account(rot.accountId);
    await this.store.saveAccount({ ...acc, frozenBy: rot.id });
    acc = await this.account(rot.accountId);
    await this.audit({ type: "OPERATIONS_FROZEN", accountId: acc.id, multisig: acc.multisig, details: { rotationId } });

    const ms = new PublicKey(acc.multisig);
    let state = await this.verifiedState(acc);
    for (let i = state.staleTransactionIndex + 1n; i <= state.transactionIndex; i++) {
      const p = await readProposal(this.chain, ms, i);
      if (!p) continue;
      if (p.status === "Active") {
        const sig = await this.serverReject(acc, i, "dk1:rotation-drain");
        await this.audit({ type: "PENDING_PROPOSAL_REJECTED", accountId: acc.id, multisig: acc.multisig, transactionIndex: i.toString(), txSignature: sig, details: { rotationId } });
        const pending = (await this.store.listIntents(acc.id)).find((r) => r.intent.transactionIndex === i.toString());
        if (pending && pending.status !== "EXECUTED") await this.store.saveIntent({ ...pending, status: "REJECTED", reasons: ["rotação de chave"], updatedAt: this.now() });
      } else if (p.status === "Approved") {
        deny("APPROVED_PENDING", `proposta ${i} aprovada e não executada: execute ou cancele antes de trocar chaves`);
      }
    }
    rot = await this.advanceRotation(rotationId, "OPERATIONS_FROZEN");

    state = await this.verifiedState(acc);
    const index = state.transactionIndex + 1n;
    const now = this.now();
    const body: IntentBody = {
      version: 1,
      id: randomUUID(),
      cluster: this.cfg.cluster,
      multisig: acc.multisig,
      transactionIndex: index.toString(),
      createdAt: now,
      expiresAt: Math.min(rot.expiresAt, now + this.rotationTtl),
      kind: "CONFIG",
      type: "ROTATE_MEMBER",
      role: rot.role,
      oldKey: rot.oldKey,
      newKey: rot.newKey!,
      rotationId: rot.id,
    };
    const intent = sealIntent(body);
    const proposer = this.cfg.service.proposer;
    onCreate(index);
    const sig = await this.send(
      createConfigProposalIxs({
        multisig: ms,
        index,
        proposer: await proposer.publicKey(),
        rentPayer: await this.cfg.service.feePayer.publicKey(),
        actions: rotationActions(new PublicKey(rot.oldKey), new PublicKey(rot.newKey!)),
        memo: `dk1:rotation:${intent.intentHash.slice(0, 32)}`,
      }),
      [proposer],
    );
    const onchain = await readTransaction(this.chain, ms, index);
    if (!onchain || onchain.kind !== "CONFIG") deny("TX_NOT_CREATED", "config transaction não apareceu");
    const diffs = compareIntent(intent, viewConfigTransaction(onchain, state, acc.roles));
    if (diffs.length) deny("INTENT_MISMATCH", diffs.join("; "));

    const flags = ["SECURITY_CHANGE", rot.role === "CLIENT" ? "CLIENT_KEY_ROTATION" : "SERVER_KEY_ROTATION"];
    await this.store.saveIntent({ intent, accountId: acc.id, transactionHash: onchain.hash, status: "AWAITING_CLIENT", riskFlags: flags, reasons: [], signatures: { create: sig }, updatedAt: now });
    await this.store.saveSquadsTransaction({ accountId: acc.id, multisig: acc.multisig, transactionIndex: index.toString(), kind: "CONFIG", address: onchain.address, hash: onchain.hash, intentId: intent.id, createSignature: sig, createdAt: now });
    await this.audit({ type: "TRANSACTION_PROPOSED", accountId: acc.id, multisig: acc.multisig, transactionIndex: index.toString(), intentId: intent.id, intentHash: intent.intentHash, txSignature: sig, details: { rotationId } });
    const updated = await this.advanceRotation(rotationId, "AWAITING_CLIENT_APPROVAL", undefined, { intentId: intent.id });
    await this.cfg.notifications.keyRotationRequested(
      { userId: acc.userId, accountId: acc.id },
      { rotationId, role: rot.role, summary: rot.role === "CLIENT" ? "Troca da chave de aprovação" : "O serviço pede atualização da chave de segurança" },
    );
    return { rotation: updated, intent };
  }

  /** Executa a ConfigTransaction aprovada e confere o resultado na chain. */
  private async executeRotation(acc: SmartAccountRecord, rec: IntentRecord) {
    const intent = rec.intent;
    if (intent.type !== "ROTATE_MEMBER") return;
    const ms = new PublicKey(acc.multisig);
    const index = BigInt(intent.transactionIndex);
    const rot0 = (await this.store.getRotation(intent.rotationId))!;
    if (rot0.status !== "EXECUTING") await this.advanceRotation(intent.rotationId, "EXECUTING");
    const executor = this.cfg.service.executor;
    let sig: string;
    try {
      sig = await sendInstructions(this.chain, [executeConfigIx(ms, index, await executor.publicKey(), await this.cfg.service.feePayer.publicKey())], [this.cfg.service.feePayer, executor]);
    } catch (e) {
      // Aprovada on-chain: continua congelada (a troca ainda pode acontecer). Tentar de novo ou cancelar.
      rec.status = "APPROVED_PENDING_EXECUTION";
      rec.reasons = [`EXECUTION_FAILED: ${e instanceof ChainTxError ? (e.programError ?? e.message) : String(e)}`];
      rec.updatedAt = this.now();
      await this.store.saveIntent(rec);
      await this.audit({ type: "EXECUTION_FAILED", accountId: acc.id, multisig: acc.multisig, transactionIndex: intent.transactionIndex, intentId: intent.id, details: { rotationId: intent.rotationId, reasons: rec.reasons } });
      return;
    }
    rec.signatures.execute = sig;
    rec.status = "EXECUTED";
    rec.updatedAt = this.now();
    await this.store.saveIntent(rec);
    await this.audit({ type: "NEW_MEMBER_ADDED", accountId: acc.id, multisig: acc.multisig, publicKey: intent.newKey, transactionIndex: intent.transactionIndex, intentId: intent.id, intentHash: intent.intentHash, txSignature: sig });
    await this.audit({ type: "OLD_MEMBER_REMOVED", accountId: acc.id, multisig: acc.multisig, publicKey: intent.oldKey, transactionIndex: intent.transactionIndex, intentId: intent.id, intentHash: intent.intentHash, txSignature: sig });

    const roles: ExpectedRoles = { ...acc.roles, [intent.role === "CLIENT" ? "client" : "server"]: intent.newKey };
    const state = await readMultisig(this.chain, ms);
    try {
      assertStrictTwoOfTwo(state, roles);
    } catch (e) {
      await this.advanceRotation(intent.rotationId, "ROLLBACK_REQUIRED", String(e));
      await this.audit({ type: "INVARIANT_VIOLATION", accountId: acc.id, multisig: acc.multisig, details: { error: String(e) } });
      throw e;
    }
    await this.advanceRotation(intent.rotationId, "VERIFIED");

    const now = this.now();
    const rot = (await this.store.getRotation(intent.rotationId))!;
    const members = await this.store.listMembers(acc.id);
    const old = members.find((m) => m.publicKey === intent.oldKey);
    if (old) await this.store.saveMember({ ...old, status: "REVOKED", revokedAt: now });
    let deviceId: string | null = null;
    if (intent.role === "CLIENT") {
      deviceId = randomUUID();
      await this.store.saveDevice({ id: deviceId, userId: acc.userId, name: rot.newDeviceName ?? "novo dispositivo", publicKey: intent.newKey, createdAt: now, revokedAt: null });
      if (old?.deviceId) {
        const dev = await this.store.getDevice(old.deviceId);
        if (dev) await this.store.saveDevice({ ...dev, revokedAt: now });
      }
    } else {
      await this.cfg.serverKeys.retire(intent.oldKey);
    }
    await this.store.saveMember({ accountId: acc.id, publicKey: intent.newKey, role: intent.role, permissions: 2, status: "ACTIVE", deviceId, createdAt: now, revokedAt: null });
    await this.store.saveAccount({ ...acc, roles, frozenBy: null });
    await this.advanceRotation(intent.rotationId, "COMPLETED");
    await this.audit({ type: "ROTATION_COMPLETED", accountId: acc.id, multisig: acc.multisig, publicKey: intent.newKey, intentId: intent.id, txSignature: sig, details: { rotationId: intent.rotationId, role: intent.role } });
    await this.audit({ type: "OPERATIONS_UNFROZEN", accountId: acc.id, multisig: acc.multisig, details: { rotationId: intent.rotationId } });
  }

  // -------------------------------------------------------------------------
  // leitura
  // -------------------------------------------------------------------------

  async securityOverview(accountId: string) {
    const acc = await this.account(accountId);
    const state = await readMultisig(this.chain, new PublicKey(acc.multisig));
    let invariantOk = true;
    let invariantError: string | null = null;
    try {
      assertStrictTwoOfTwo(state, acc.roles);
    } catch (e) {
      invariantOk = false;
      invariantError = String(e);
    }
    return {
      account: acc,
      onchain: { ...state, transactionIndex: state.transactionIndex.toString(), staleTransactionIndex: state.staleTransactionIndex.toString() },
      mode: "STRICT_2_OF_2" as const,
      invariantOk,
      invariantError,
      vaultLamports: (await this.chain.getBalance(new PublicKey(acc.vault))).toString(),
      members: await this.store.listMembers(accountId),
    };
  }
}

/** createKey só semeia o PDA da multisig e assina a criação; não tem poder nenhum depois. */
function randomCreateKey(_cluster: Cluster): Signer {
  const kp = Keypair.generate();
  return {
    publicKey: async () => kp.publicKey,
    sign: async (m: Uint8Array) => ed25519.sign(m, kp.secretKey.subarray(0, 32)),
  };
}

/** Visão da mensagem antes de ela existir na chain (mesma leitura usada depois). */
function previewVaultView(vault: PublicKey, instructions: TransactionInstruction[]) {
  const parsed = instructions.map((ix) => parseInstruction({ programId: ix.programId, keys: ix.keys, data: new Uint8Array(ix.data) }));
  const programs = [...new Set(instructions.map((i) => i.programId.toBase58()))].sort();
  const t = parsed[0];
  return {
    kind: "VAULT" as const,
    vault: vault.toBase58(),
    instructions: parsed,
    programs,
    writable: [],
    operation:
      t && t.kind === "SYSTEM_TRANSFER" && parsed.length === 1 && t.from === vault.toBase58()
        ? { type: "TRANSFER_SOL" as const, amountLamports: t.lamports.toString(), destination: t.to }
        : null,
  };
}

function toInstruction(r: RawInstruction): TransactionInstruction {
  return new TransactionInstruction({ programId: r.programId, keys: r.keys, data: Buffer.from(r.data) });
}
