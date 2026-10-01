import { randomUUID } from "node:crypto";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedMessage, VersionedTransaction } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { type Cluster, deny, type IntentBody, SecurityError, sealIntent, type TransferSolIntent } from "@duplachave/shared";
import {
  loginMessage,
  MEMO_PROGRAM_ID,
  memoSignedBy,
  possessionMessage,
  type PossessionOperation,
  randomHex,
  type Signer,
  verifyEd25519,
  verifyWalletMessage,
  verifyWalletProof,
  type WalletProof,
} from "@duplachave/crypto";
import { ChainTxError, type Chain, parseInstruction, type RawInstruction, SYSTEM_PROGRAM, sendInstructions } from "@duplachave/solana";
import {
  approvalMemo,
  approveIx,
  assertStrictTwoOfTwo,
  cancelIx,
  CLIENT_MASK,
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
  SERVER_MASK,
  vaultPda,
  viewConfigTransaction,
  viewVaultTransaction,
} from "@duplachave/squads";
import { DEFAULT_POLICY, type PolicyEngine, type User } from "@duplachave/policy-engine";
import type { ApprovalRequest, SignMode } from "./client";
import type { ServerKeyProvider, ServiceKeys } from "./keys";
import type { NotificationService } from "./notifications";
import type { AuditInput, ChallengeStore, IntentRecord, RotationRecord, RotationStatus, SmartAccountRecord, Store } from "./store";
import { renderIntent } from "./display";

const utf8 = (s: string) => new TextEncoder().encode(s);

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
  OPERATIONS_FROZEN: ["AWAITING_SERVER_APPROVAL", "EXPIRED", "FAILED", "ROLLBACK_REQUIRED"],
  AWAITING_SERVER_APPROVAL: ["AWAITING_CLIENT_APPROVAL", "REJECTED", "EXPIRED", "FAILED"],
  AWAITING_CLIENT_APPROVAL: ["EXECUTING", "REJECTED", "EXPIRED", "FAILED"],
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

  /**
   * Voto do servidor. Rejeitar depois de ter aprovado troca o voto (o programa
   * remove a aprovação) e, em 2-de-2, um voto de rejeição já encerra a proposta.
   */
  private async serverVote(acc: SmartAccountRecord, index: bigint, vote: "approve" | "reject" | "cancel", memo: string) {
    const server = await this.serverSigner(acc);
    const ms = new PublicKey(acc.multisig);
    const pk = await server.publicKey();
    const ix = vote === "approve" ? approveIx(ms, index, pk, memo) : vote === "reject" ? rejectIx(ms, index, pk, memo) : cancelIx(ms, index, pk, memo);
    return this.send([ix], [server]);
  }

  // -------------------------------------------------------------------------
  // desafios, cadastro e sessão
  // -------------------------------------------------------------------------

  /** Desafio + o texto exato que a carteira vai assinar (e mostrar ao usuário). */
  async createChallenge(purpose: "ENROLL_CLIENT_KEY" | "AUTH", publicKey: string) {
    new PublicKey(publicKey);
    const c = { id: randomUUID(), purpose, subject: publicKey, challenge: randomHex(32), expiresAt: this.now() + 300 };
    await this.store.putChallenge(c);
    const message =
      purpose === "AUTH"
        ? loginMessage({ publicKey, cluster: this.cfg.cluster, challenge: c.challenge, expiresAt: c.expiresAt })
        : possessionMessage({ operation: "ENROLL_CLIENT_KEY", publicKey, account: "nova", cluster: this.cfg.cluster, challenge: c.challenge, expiresAt: c.expiresAt });
    return { ...c, message };
  }

  /** Prova de posse: o texto é remontado aqui a partir do que o servidor emitiu. */
  private async checkWalletProof(
    proof: WalletProof,
    expected: { operation: PossessionOperation; account: string; challenge: string; expiresAt: number; publicKey?: string },
  ) {
    if (!proof || typeof proof !== "object") deny("POSSESSION_MALFORMED", "prova ausente");
    if (proof.operation !== expected.operation) deny("POSSESSION_WRONG_OPERATION", String(proof.operation));
    if (proof.cluster !== this.cfg.cluster) deny("POSSESSION_WRONG_CLUSTER", String(proof.cluster));
    if (proof.account !== expected.account) deny("POSSESSION_WRONG_ACCOUNT", String(proof.account));
    if (proof.challenge !== expected.challenge) deny("POSSESSION_WRONG_CHALLENGE", "desafio diferente do emitido");
    if (proof.expiresAt !== expected.expiresAt) deny("POSSESSION_WRONG_EXPIRY", "validade diferente da emitida");
    if (expected.publicKey && proof.publicKey !== expected.publicKey) deny("POSSESSION_WRONG_KEY", String(proof.publicKey));
    try {
      new PublicKey(proof.publicKey);
    } catch {
      deny("POSSESSION_MALFORMED", "chave pública inválida");
    }
    if (this.now() > proof.expiresAt) deny("POSSESSION_EXPIRED", "prova fora da validade");
    if (!verifyWalletProof(proof)) deny("POSSESSION_BAD_SIGNATURE", "assinatura não é da carteira declarada");
    if (!(await this.store.consumeNonce("possession", proof.signature, proof.expiresAt))) deny("REPLAY", "prova de posse já usada");
    if (await this.store.isRevokedKey(proof.publicKey)) deny("REVOKED_KEY_REUSE", "chave revogada não volta");
    return proof;
  }

  /**
   * Cadastro: a carteira comum do usuário (posse provada por signMessage) +
   * uma chave nova do servidor, mais executor e proposer do serviço.
   */
  async enroll(args: { challengeId: string; publicKey: string; signature: string; walletName: string; userName?: string }) {
    const ch = await this.store.takeChallenge(args.challengeId);
    if (!ch || ch.purpose !== "ENROLL_CLIENT_KEY" || ch.subject !== args.publicKey) deny("CHALLENGE_INVALID", "desafio inexistente ou já usado");
    if (ch.expiresAt < this.now()) deny("CHALLENGE_EXPIRED", "desafio expirado");
    const proof = await this.checkWalletProof(
      { operation: "ENROLL_CLIENT_KEY", publicKey: args.publicKey, account: "nova", cluster: this.cfg.cluster, challenge: ch.challenge, expiresAt: ch.expiresAt, signature: args.signature },
      { operation: "ENROLL_CLIENT_KEY", account: "nova", challenge: ch.challenge, expiresAt: ch.expiresAt, publicKey: args.publicKey },
    );
    const plan = await this.enrollmentPlan(proof.publicKey);
    const sig = await this.send([plan.instruction], [plan.createKey]);
    return this.saveEnrollment(plan, args.walletName, sig, args.userName);
  }

  /** Monta a multisig 2-de-2 para uma carteira (ainda não envia). */
  private async enrollmentPlan(walletPublicKey: string) {
    if (await this.store.findAccountByClientKey(walletPublicKey)) deny("WALLET_ALREADY_ENROLLED", "esta carteira já tem uma conta");
    if (await this.cfg.serverKeys.get(walletPublicKey)) deny("CLIENT_KEY_IS_SERVER_KEY", "chave do servidor não pode ser a carteira do cliente");
    const userId = randomUUID();
    const server = await this.cfg.serverKeys.create(`server:${userId}`);
    const roles: ExpectedRoles = {
      client: walletPublicKey,
      server: (await server.publicKey()).toBase58(),
      executor: (await this.cfg.service.executor.publicKey()).toBase58(),
      proposer: (await this.cfg.service.proposer.publicKey()).toBase58(),
    };
    const createKey = randomCreateKey();
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
    return { userId, roles, createKey, instruction: created.instruction, multisig: created.multisig.toBase58(), vault: created.vault.toBase58() };
  }

  /** Grava a conta depois que a multisig existe na chain (e confere o modelo 2-de-2 nela). */
  private async saveEnrollment(plan: Awaited<ReturnType<CustodyService["enrollmentPlan"]>>, walletName: string, sig: string, userName?: string) {
    const { userId, roles } = plan;
    const now = this.now();
    await this.store.saveUser({ id: userId, name: userName ?? walletName, policy: DEFAULT_POLICY, createdAt: now });
    const deviceId = randomUUID();
    await this.store.saveDevice({ id: deviceId, userId, name: walletName, publicKey: roles.client, createdAt: now, revokedAt: null });
    const acc: SmartAccountRecord = { id: randomUUID(), userId, cluster: this.cfg.cluster, multisig: plan.multisig, vault: plan.vault, roles, frozenBy: null, createdAt: now };
    await this.store.saveAccount(acc);
    await this.verifiedState(acc);
    const member = (publicKey: string, role: "CLIENT" | "SERVER" | "EXECUTOR" | "PROPOSER", permissions: number, dev: string | null = null) =>
      this.store.saveMember({ accountId: acc.id, publicKey, role, permissions, status: "ACTIVE", deviceId: dev, createdAt: now, revokedAt: null });
    await member(roles.client, "CLIENT", CLIENT_MASK, deviceId);
    await member(roles.server, "SERVER", SERVER_MASK);
    await member(roles.executor, "EXECUTOR", 4);
    await member(roles.proposer, "PROPOSER", 1);
    await this.audit({ type: "SMART_ACCOUNT_CREATED", accountId: acc.id, userId, deviceId, multisig: acc.multisig, txSignature: sig, publicKey: roles.client, details: { wallet: walletName } });
    return { account: acc, deviceId };
  }

  /** Login: a carteira assina o texto de entrada. Sessão identifica; não autoriza nada. */
  async login(args: { challengeId: string; publicKey: string; signature: string }) {
    const ch = await this.store.takeChallenge(args.challengeId);
    if (!ch || ch.purpose !== "AUTH" || ch.subject !== args.publicKey || ch.expiresAt < this.now()) deny("CHALLENGE_INVALID", "desafio inválido");
    const text = loginMessage({ publicKey: args.publicKey, cluster: this.cfg.cluster, challenge: ch.challenge, expiresAt: ch.expiresAt });
    if (!verifyWalletMessage(text, args.signature, args.publicKey)) deny("BAD_SIGNATURE", "assinatura inválida");
    const acc = await this.store.findAccountByClientKey(args.publicKey);
    if (!acc) {
      if (await this.store.isRevokedKey(args.publicKey)) deny("KEY_REVOKED", "esta carteira foi substituída e não volta a valer");
      deny("NOT_A_CLIENT_KEY", "esta carteira não é a carteira atual de nenhuma conta");
    }
    return acc;
  }

  // -------------------------------------------------------------------------
  // operações (VaultTransaction)
  // -------------------------------------------------------------------------

  /**
   * Monta a transferência, roda política + simulação, cria a proposta e o
   * servidor já aprova. Falta só a carteira do cliente (que aprova e executa).
   */
  async createTransferSol(accountId: string, req: { destination: string; amountLamports: string }) {
    return this.withLock(accountId, async () => {
      const acc = await this.account(accountId);
      if (acc.frozenBy) deny("OPERATIONS_FROZEN", "troca de carteira em andamento");
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

      const preview = previewVaultView(vault, instructions);
      const vaultLamports = await this.chain.getBalance(vault);
      const pre = await this.cfg.policy.validate(user, intent, preview, { vaultLamports, verifiedNewKeys: [], revokedKeys: [] });
      const destInfo = await this.chain.getAccountInfo(destination);
      if (destInfo?.executable) {
        pre.allowed = false;
        pre.reasons.push("DESTINATION_IS_PROGRAM: o destino é um programa, não uma carteira");
      } else if (destInfo && !destInfo.owner.equals(SystemProgram.programId)) {
        pre.riskFlags.push("DESTINATION_NOT_WALLET");
      }
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
      const sig = await this.send(
        createVaultProposalIxs({
          multisig: ms,
          index,
          proposer: await proposer.publicKey(),
          rentPayer: await this.cfg.service.feePayer.publicKey(),
          instructions,
          recentBlockhash: await this.chain.getLatestBlockhash(),
          memo: `dk1:intent:${intent.intentHash.slice(0, 32)}`,
        }),
        [proposer],
      );

      // Relê da chain e confere antes de o servidor votar.
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

      const serverSig = await this.serverVote(acc, index, "approve", approvalMemo(intent.intentHash, onchain.hash));
      rec.signatures.serverApprove = serverSig;
      await this.store.saveIntent(rec);
      await this.store.saveApproval({ id: randomUUID(), intentId: intent.id, accountId, publicKey: acc.roles.server, role: "SERVER", decision: "APPROVE", statement: { policy: "allowed", riskFlags: pre.riskFlags }, txSignature: serverSig, createdAt: this.now() });
      await this.audit({ type: "SERVER_APPROVED", accountId, publicKey: acc.roles.server, multisig: acc.multisig, transactionIndex: index.toString(), intentId: intent.id, intentHash: intent.intentHash, txSignature: serverSig });
      await this.cfg.notifications.transactionApprovalRequested(
        { userId: acc.userId, accountId },
        { intentId: intent.id, summary: renderIntent(intent).rows.map((r) => `${r.label}: ${r.value}`).slice(0, 2).join(" · ") },
      );
      return rec;
    });
  }

  private modeFor(rec: IntentRecord): SignMode {
    if (rec.status === "APPROVED_PENDING_EXECUTION") return "CANCEL";
    return rec.intent.kind === "OPERATION" ? "APPROVE_AND_EXECUTE" : "APPROVE";
  }

  /** O que o app recebe para revisar e montar a transação da carteira. */
  async approvalRequest(intentId: string): Promise<ApprovalRequest> {
    const rec = await this.store.getIntent(intentId);
    if (!rec) deny("INTENT_NOT_FOUND", intentId);
    let possession: WalletProof | null = null;
    if (rec.intent.type === "ROTATE_MEMBER") {
      const rot = await this.store.getRotation(rec.intent.rotationId);
      possession = (rot?.possession as WalletProof | null) ?? null;
    }
    return {
      intent: rec.intent,
      riskFlags: rec.riskFlags,
      feePayer: (await this.cfg.service.feePayer.publicKey()).toBase58(),
      recentBlockhash: await this.chain.getLatestBlockhash(),
      mode: this.modeFor(rec),
      possession,
    };
  }

  /**
   * Recebe a transação assinada pela carteira do cliente, confere que ela é
   * exatamente a esperada para esta intenção, paga a taxa e envia.
   */
  async submitWalletTransaction(intentId: string, transactionB64: string) {
    const first = await this.store.getIntent(intentId);
    if (!first) deny("INTENT_NOT_FOUND", intentId);
    return this.withLock(first.accountId, async () => {
      const rec = (await this.store.getIntent(intentId))!;
      const acc = await this.account(rec.accountId);
      const intent = rec.intent;
      const index = BigInt(intent.transactionIndex);
      const ms = new PublicKey(acc.multisig);
      const mode = this.modeFor(rec);
      const refuse = async (code: string, msg: string): Promise<never> => {
        await this.audit({ type: "APPROVAL_REFUSED", accountId: acc.id, multisig: acc.multisig, transactionIndex: intent.transactionIndex, intentId, intentHash: intent.intentHash, details: { code, msg } });
        throw new SecurityError(code, msg);
      };

      if (mode !== "CANCEL" && rec.status !== "AWAITING_CLIENT") return refuse("INTENT_NOT_PENDING", `intenção em ${rec.status}`);
      if (mode !== "CANCEL" && this.now() > intent.expiresAt) {
        await this.expireIntent(rec, acc);
        return refuse("INTENT_EXPIRED", "intenção expirada; proposta rejeitada on-chain");
      }

      // Quem assina é a carteira atual segundo a chain; o conteúdo on-chain é o da intenção.
      const state = await this.verifiedState(acc);
      const onchain = await readTransaction(this.chain, ms, index);
      if (!onchain || onchain.hash !== rec.transactionHash) return refuse("TX_HASH_MISMATCH", "conteúdo on-chain difere do proposto");
      const view = onchain.kind === "VAULT" ? viewVaultTransaction(onchain, vaultPda(ms, 0)) : viewConfigTransaction(onchain, state, acc.roles);
      const diffs = compareIntent(intent, view);
      if (diffs.length) return refuse("INTENT_MISMATCH", diffs.join("; "));

      let sig: string;
      try {
        sig = await this.relayWalletTransaction(acc, rec, transactionB64, mode);
      } catch (e) {
        if (e instanceof SecurityError) return refuse(e.code, e.message);
        throw e;
      }
      const wallet = acc.roles.client;
      rec.signatures.clientApprove = sig;
      rec.updatedAt = this.now();
      await this.store.saveApproval({ id: randomUUID(), intentId, accountId: acc.id, publicKey: wallet, role: "CLIENT", decision: mode === "CANCEL" ? "CANCEL" : "APPROVE", statement: { mode }, txSignature: sig, createdAt: this.now() });

      if (mode === "CANCEL") {
        const serverSig = await this.serverVote(acc, index, "cancel", `dk1:cancel:${intent.intentHash.slice(0, 32)}`);
        const p = await readProposal(this.chain, ms, index);
        if (p?.status !== "Cancelled") deny("NOT_CANCELLED", `proposta em ${p?.status}`);
        rec.status = "CANCELLED";
        rec.signatures.reject = serverSig;
        await this.store.saveIntent(rec);
        await this.audit({ type: "TRANSACTION_CANCELLED", accountId: acc.id, multisig: acc.multisig, transactionIndex: intent.transactionIndex, intentId, intentHash: intent.intentHash, txSignature: serverSig });
        if (intent.type === "ROTATE_MEMBER") await this.finishRotation(intent.rotationId, "REJECTED", "aprovada e cancelada");
        return rec;
      }

      await this.audit({ type: "CLIENT_APPROVED", accountId: acc.id, publicKey: wallet, multisig: acc.multisig, transactionIndex: intent.transactionIndex, intentId, intentHash: intent.intentHash, txSignature: sig });
      if (mode === "APPROVE_AND_EXECUTE") {
        // Aprovação e execução foram na mesma transação: se chegou aqui, executou.
        rec.status = "EXECUTED";
        rec.signatures.execute = sig;
        await this.store.saveIntent(rec);
        await this.audit({ type: "TRANSACTION_EXECUTED", accountId: acc.id, multisig: acc.multisig, transactionIndex: intent.transactionIndex, intentId, intentHash: intent.intentHash, txSignature: sig });
        return rec;
      }

      // Mudança de segurança: o executor do serviço executa e confere na chain.
      await this.store.saveIntent(rec);
      await this.executeRotation(acc, rec);
      return (await this.store.getIntent(intentId))!;
    });
  }

  /** As instruções que a carteira do cliente assina para esta intenção (mesmas do app). */
  private async walletInstructions(acc: SmartAccountRecord, rec: IntentRecord, mode: SignMode) {
    const wallet = new PublicKey(acc.roles.client);
    const ms = new PublicKey(acc.multisig);
    const index = BigInt(rec.intent.transactionIndex);
    const memo = approvalMemo(rec.intent.intentHash, rec.transactionHash);
    if (mode === "CANCEL") return [cancelIx(ms, index, wallet, memo)];
    if (mode === "APPROVE") return [approveIx(ms, index, wallet, memo)];
    return [approveIx(ms, index, wallet, memo), (await executeVaultIx(this.chain, ms, index, wallet)).instruction];
  }

  /** Confere instrução por instrução a transação da carteira e a envia, pagando a taxa. */
  private async relayWalletTransaction(acc: SmartAccountRecord, rec: IntentRecord, b64: string, mode: SignMode): Promise<string> {
    if (!b64) deny("NO_TRANSACTION", "sem a transação assinada pela carteira");
    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
    } catch {
      deny("TX_MALFORMED", "transação ilegível");
    }
    const feePayer = await this.cfg.service.feePayer.publicKey();
    const wallet = new PublicKey(acc.roles.client);
    if (tx.message.addressTableLookups.length) deny("ALT_IN_TX", "transação com lookup table");
    if (!tx.message.staticAccountKeys[0]?.equals(feePayer)) deny("WRONG_PAYER", "pagador inesperado");
    const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
    if (signers.length !== 2 || !signers.some((k) => k.equals(wallet))) deny("UNEXPECTED_SIGNERS", "a transação deve ter só o pagador e a carteira como signatários");

    const expected = await this.walletInstructions(acc, rec, mode);
    // Bytes idênticos aos da mensagem esperada (mesmo pagador e blockhash que a carteira assinou):
    // nenhuma instrução, conta ou flag a mais ou a menos.
    const expectedMessage = new TransactionMessage({ payerKey: feePayer, recentBlockhash: tx.message.recentBlockhash, instructions: expected }).compileToV0Message();
    if (!Buffer.from(expectedMessage.serialize()).equals(Buffer.from(tx.message.serialize()))) deny("TX_NOT_EXPECTED", "a transação assinada não é a esperada para esta intenção");
    const wi = signers.findIndex((k) => k.equals(wallet));
    if (!verifyEd25519(tx.message.serialize(), tx.signatures[wi]!, wallet)) deny("WALLET_BAD_SIGNATURE", "assinatura da carteira inválida");
    tx.addSignature(feePayer, await this.cfg.service.feePayer.sign(tx.message.serialize()));
    try {
      return await this.chain.sendTransaction(tx);
    } catch (e) {
      if (e instanceof ChainTxError) deny("WALLET_TX_FAILED", e.programError ?? e.message);
      throw e;
    }
  }

  /** O cliente recusa no app: o servidor troca o voto para rejeição e a proposta morre. */
  async rejectByClient(intentId: string) {
    const first = await this.store.getIntent(intentId);
    if (!first) deny("INTENT_NOT_FOUND", intentId);
    return this.withLock(first.accountId, async () => {
      const rec = (await this.store.getIntent(intentId))!;
      const acc = await this.account(rec.accountId);
      if (rec.status !== "AWAITING_CLIENT") deny("INTENT_NOT_PENDING", rec.status);
      const index = BigInt(rec.intent.transactionIndex);
      const p = await readProposal(this.chain, new PublicKey(acc.multisig), index);
      if (p?.status === "Active") rec.signatures.reject = await this.serverVote(acc, index, "reject", `dk1:client-reject:${rec.intent.intentHash.slice(0, 32)}`);
      rec.status = "REJECTED";
      rec.reasons = ["recusada pelo cliente"];
      rec.updatedAt = this.now();
      await this.store.saveIntent(rec);
      await this.audit({ type: "CLIENT_REJECTED", accountId: acc.id, multisig: acc.multisig, transactionIndex: rec.intent.transactionIndex, intentId, intentHash: rec.intent.intentHash, txSignature: rec.signatures.reject ?? null });
      if (rec.intent.type === "ROTATE_MEMBER") await this.finishRotation(rec.intent.rotationId, "REJECTED", "cliente recusou");
      return rec;
    });
  }

  /** Tenta de novo a execução de uma aprovada (rotação cujo execute falhou). */
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

  private async executeVault(acc: SmartAccountRecord, rec: IntentRecord) {
    const intent = rec.intent;
    const ms = new PublicKey(acc.multisig);
    const executor = this.cfg.service.executor;
    try {
      const { instruction, lookupTableAccounts } = await executeVaultIx(this.chain, ms, BigInt(intent.transactionIndex), await executor.publicKey());
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
      await this.audit({ type: "EXECUTION_FAILED", accountId: acc.id, multisig: acc.multisig, transactionIndex: intent.transactionIndex, intentId: intent.id, details: { reasons: rec.reasons } });
    }
  }

  private async expireIntent(rec: IntentRecord, acc: SmartAccountRecord) {
    const index = BigInt(rec.intent.transactionIndex);
    const p = await readProposal(this.chain, new PublicKey(acc.multisig), index);
    // Já aprovada pelos dois: não é "vencida", é execução pendente.
    if (p?.status === "Approved") return;
    let sig: string | undefined;
    if (p?.status === "Active") sig = await this.serverVote(acc, index, "reject", `dk1:expired:${rec.intent.intentHash.slice(0, 32)}`);
    rec.status = "EXPIRED";
    if (sig) rec.signatures.reject = sig;
    rec.updatedAt = this.now();
    await this.store.saveIntent(rec);
    await this.audit({ type: "TRANSACTION_EXPIRED", accountId: acc.id, multisig: acc.multisig, transactionIndex: rec.intent.transactionIndex, intentId: rec.intent.id, intentHash: rec.intent.intentHash, txSignature: sig ?? null });
    if (rec.intent.type === "ROTATE_MEMBER") await this.finishRotation(rec.intent.rotationId, "EXPIRED", "aprovação não chegou a tempo");
  }

  /**
   * Encerra pendências vencidas: o servidor troca o voto para rejeição (em
   * 2-de-2 isso mata a proposta). Sob o mesmo lock das decisões.
   */
  async expireDue(accountId: string) {
    return this.withLock(accountId, async () => {
      const acc = await this.account(accountId);
      const now = this.now();
      for (const rec of await this.store.listIntents(accountId)) {
        if (rec.status === "AWAITING_CLIENT" && now > rec.intent.expiresAt) {
          try {
            await this.expireIntent(rec, acc);
          } catch (e) {
            this.cfg.log?.(`expirar ${rec.intent.id}: ${String(e)}`);
          }
        }
      }
      for (const rot of await this.store.listRotations(accountId)) {
        if (TERMINAL.includes(rot.status) || now <= rot.expiresAt) continue;
        if (["EXECUTING", "VERIFIED"].includes(rot.status)) continue;
        const rec = rot.intentId ? await this.store.getIntent(rot.intentId) : null;
        if (rec && ["AWAITING_CLIENT", "APPROVED_PENDING_EXECUTION"].includes(rec.status)) continue;
        try {
          await this.finishRotation(rot.id, "EXPIRED", "prazo da troca venceu");
        } catch (e) {
          this.cfg.log?.(`expirar rotação ${rot.id}: ${String(e)}`);
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  // troca de carteira / chave do servidor (ConfigTransaction)
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
      if (rec && !["REJECTED", "EXPIRED", "EXECUTED", "CANCELLED"].includes(rec.status)) {
        const p = await readProposal(this.chain, new PublicKey(acc.multisig), BigInt(rec.intent.transactionIndex));
        if (p?.status === "Active") rec.signatures.reject = await this.serverVote(acc, BigInt(rec.intent.transactionIndex), "reject", `dk1:rotation-${to.toLowerCase()}`);
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

  private newRotation(acc: SmartAccountRecord, role: "CLIENT" | "SERVER", note?: string): RotationRecord {
    const now = this.now();
    return {
      id: randomUUID(),
      accountId: acc.id,
      role,
      oldKey: role === "CLIENT" ? acc.roles.client : acc.roles.server,
      newKey: null,
      newDeviceName: null,
      status: "REQUESTED",
      challenge: randomHex(32),
      createdAt: now,
      expiresAt: now + this.rotationTtl,
      intentId: null,
      possession: null,
      history: [{ status: "REQUESTED", at: now, note }],
    };
  }

  /** Campos que a carteira nova assina (falta só a chave pública dela). */
  possessionFieldsFor(rot: RotationRecord, multisig: string) {
    return {
      operation: (rot.role === "CLIENT" ? "ROTATE_CLIENT_KEY" : "ROTATE_SERVER_KEY") as PossessionOperation,
      account: multisig,
      cluster: this.cfg.cluster,
      challenge: rot.challenge,
      expiresAt: rot.expiresAt,
    };
  }

  /** Passo 1: a carteira atual (com sessão) pede a troca. */
  async requestClientRotation(accountId: string, args: { newWalletName?: string } = {}) {
    return this.withLock(accountId, async () => {
      const acc = await this.account(accountId);
      const state = await this.verifiedState(acc);
      const open = (await this.store.listRotations(accountId)).find((r) => !TERMINAL.includes(r.status));
      if (open) deny("ROTATION_IN_PROGRESS", open.id);
      await this.assertNoApprovedPending(acc, state);
      const rot = { ...this.newRotation(acc, "CLIENT"), newDeviceName: args.newWalletName ?? null };
      await this.store.saveRotation(rot);
      await this.audit({ type: "CLIENT_KEY_ROTATION_REQUESTED", accountId, multisig: acc.multisig, publicKey: acc.roles.client, details: { rotationId: rot.id } });
      return { rotation: rot, fields: this.possessionFieldsFor(rot, acc.multisig) };
    });
  }

  /** Passo 2: a carteira nova assina o texto de posse; o backend congela, drena, propõe e o servidor aprova. */
  async proveClientRotationKey(rotationId: string, proof: WalletProof) {
    const rot0 = await this.store.getRotation(rotationId);
    if (!rot0) deny("ROTATION_NOT_FOUND", rotationId);
    return this.withLock(rot0.accountId, async () => {
      const rot = (await this.store.getRotation(rotationId))!;
      const acc = await this.account(rot.accountId);
      if (rot.role !== "CLIENT") deny("ROTATION_WRONG_ROLE", "esta rotação não é da carteira do cliente");
      if (rot.status !== "REQUESTED") deny("ROTATION_BAD_STATE", rot.status);
      if (this.now() > rot.expiresAt) {
        await this.finishRotation(rot.id, "EXPIRED", "prova chegou depois do prazo");
        deny("ROTATION_EXPIRED", "troca expirada");
      }
      try {
        await this.checkWalletProof(proof, { operation: "ROTATE_CLIENT_KEY", account: acc.multisig, challenge: rot.challenge, expiresAt: rot.expiresAt });
      } catch (e) {
        await this.audit({ type: "NEW_KEY_PROOF_REFUSED", accountId: acc.id, multisig: acc.multisig, details: { rotationId, error: String(e) } });
        throw e;
      }
      const state = await this.verifiedState(acc);
      if (state.members.some((m) => m.key === proof.publicKey)) deny("KEY_ALREADY_MEMBER", "essa carteira já é membro");
      if (await this.cfg.serverKeys.get(proof.publicKey)) deny("CLIENT_KEY_IS_SERVER_KEY", "chave do servidor não pode virar carteira do cliente");
      await this.advanceRotation(rotationId, "NEW_KEY_VERIFIED", undefined, { newKey: proof.publicKey, possession: proof });
      await this.audit({ type: "NEW_KEY_PROOF_VERIFIED", accountId: acc.id, multisig: acc.multisig, publicKey: proof.publicKey, details: { rotationId } });
      return this.freezeAndPropose(rotationId);
    });
  }

  /** Rotação da chave do servidor: o backend gera e prova a nova; a carteira do cliente precisa aprovar. */
  async requestServerRotation(accountId: string, reason: string) {
    return this.withLock(accountId, async () => {
      const acc = await this.account(accountId);
      const state = await this.verifiedState(acc);
      const open = (await this.store.listRotations(accountId)).find((r) => !TERMINAL.includes(r.status));
      if (open) deny("ROTATION_IN_PROGRESS", open.id);
      await this.assertNoApprovedPending(acc, state);
      const rot = this.newRotation(acc, "SERVER", reason);
      await this.store.saveRotation(rot);
      await this.audit({ type: "SERVER_KEY_ROTATION_REQUESTED", accountId, multisig: acc.multisig, publicKey: acc.roles.server, details: { rotationId: rot.id, reason } });
      try {
        const newKey = await this.cfg.serverKeys.create(`server:${acc.userId}:rot:${rot.id}`);
        const fields = { ...this.possessionFieldsFor(rot, acc.multisig), publicKey: (await newKey.publicKey()).toBase58() };
        const proof: WalletProof = { ...fields, signature: bs58.encode(await newKey.sign(utf8(possessionMessage(fields)))) };
        await this.checkWalletProof(proof, { operation: "ROTATE_SERVER_KEY", account: acc.multisig, challenge: rot.challenge, expiresAt: rot.expiresAt });
        await this.advanceRotation(rot.id, "NEW_KEY_VERIFIED", undefined, { newKey: proof.publicKey, possession: proof });
        await this.audit({ type: "NEW_KEY_PROOF_VERIFIED", accountId, multisig: acc.multisig, publicKey: proof.publicKey, details: { rotationId: rot.id } });
      } catch (e) {
        await this.finishRotation(rot.id, "FAILED", `pedido do servidor falhou: ${String(e)}`);
        throw e;
      }
      return this.freezeAndPropose(rot.id);
    });
  }

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
        if (p?.status === "Active") await this.serverVote(acc, created, "reject", "dk1:rotation-failed").catch(() => {});
      }
      await this.finishRotation(rotationId, "FAILED", String(e)).catch(() => {});
      throw e;
    }
  }

  /**
   * Congela, drena a fila (rejeita propostas ativas), cria a ConfigTransaction
   * atômica [AddMember, RemoveMember], roda a política e o servidor aprova.
   */
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
        const sig = await this.serverVote(acc, i, "reject", "dk1:rotation-drain");
        await this.audit({ type: "PENDING_PROPOSAL_REJECTED", accountId: acc.id, multisig: acc.multisig, transactionIndex: i.toString(), txSignature: sig, details: { rotationId } });
        const pending = (await this.store.listIntents(acc.id)).find((r) => r.intent.transactionIndex === i.toString());
        if (pending && pending.status !== "EXECUTED") await this.store.saveIntent({ ...pending, status: "REJECTED", reasons: ["troca de carteira"], updatedAt: this.now() });
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
        actions: rotationActions(new PublicKey(rot.oldKey), new PublicKey(rot.newKey!), rot.role),
        memo: `dk1:rotation:${intent.intentHash.slice(0, 32)}`,
      }),
      [proposer],
    );
    const onchain = await readTransaction(this.chain, ms, index);
    if (!onchain || onchain.kind !== "CONFIG") deny("TX_NOT_CREATED", "config transaction não apareceu");
    const view = viewConfigTransaction(onchain, state, acc.roles);
    const diffs = compareIntent(intent, view);
    if (diffs.length) deny("INTENT_MISMATCH", diffs.join("; "));

    const flags = ["SECURITY_CHANGE", rot.role === "CLIENT" ? "CLIENT_KEY_ROTATION" : "SERVER_KEY_ROTATION"];
    const rec: IntentRecord = { intent, accountId: acc.id, transactionHash: onchain.hash, status: "AWAITING_CLIENT", riskFlags: flags, reasons: [], signatures: { create: sig }, updatedAt: now };
    await this.store.saveIntent(rec);
    await this.store.saveSquadsTransaction({ accountId: acc.id, multisig: acc.multisig, transactionIndex: index.toString(), kind: "CONFIG", address: onchain.address, hash: onchain.hash, intentId: intent.id, createSignature: sig, createdAt: now });
    await this.audit({ type: "TRANSACTION_PROPOSED", accountId: acc.id, multisig: acc.multisig, transactionIndex: index.toString(), intentId: intent.id, intentHash: intent.intentHash, txSignature: sig, details: { rotationId } });
    await this.advanceRotation(rotationId, "AWAITING_SERVER_APPROVAL", undefined, { intentId: intent.id });

    // Política do servidor para mudança de segurança, antes do voto dele.
    const user = await this.user(acc.userId);
    const decision = await this.cfg.policy.validate(user, intent, view, {
      vaultLamports: 0n,
      verifiedNewKeys: [rot.newKey!],
      revokedKeys: (await this.store.isRevokedKey(rot.newKey!)) ? [rot.newKey!] : [],
    });
    const serverControls = Boolean(await this.cfg.serverKeys.get(rot.newKey!));
    if (rot.role === "SERVER" && !serverControls) decision.reasons.push("SERVER_KEY_NOT_CONTROLLED");
    if (rot.role === "CLIENT" && serverControls) decision.reasons.push("CLIENT_KEY_IS_SERVER_KEY");
    if (decision.reasons.length) deny("POLICY_DENIED", decision.reasons.join("; "));

    const serverSig = await this.serverVote(acc, index, "approve", approvalMemo(intent.intentHash, onchain.hash));
    rec.signatures.serverApprove = serverSig;
    await this.store.saveIntent(rec);
    await this.audit({ type: "SERVER_APPROVED", accountId: acc.id, publicKey: acc.roles.server, multisig: acc.multisig, transactionIndex: index.toString(), intentId: intent.id, intentHash: intent.intentHash, txSignature: serverSig });
    const updated = await this.advanceRotation(rotationId, "AWAITING_CLIENT_APPROVAL");
    await this.cfg.notifications.keyRotationRequested(
      { userId: acc.userId, accountId: acc.id },
      { rotationId, role: rot.role, summary: rot.role === "CLIENT" ? "Troca da carteira da conta" : "O serviço pede atualização da chave de segurança" },
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
      await this.store.saveDevice({ id: deviceId, userId: acc.userId, name: rot.newDeviceName ?? "carteira nova", publicKey: intent.newKey, createdAt: now, revokedAt: null });
      if (old?.deviceId) {
        const dev = await this.store.getDevice(old.deviceId);
        if (dev) await this.store.saveDevice({ ...dev, revokedAt: now });
      }
    } else {
      await this.cfg.serverKeys.retire(intent.oldKey);
    }
    await this.store.saveMember({ accountId: acc.id, publicKey: intent.newKey, role: intent.role, permissions: intent.role === "CLIENT" ? CLIENT_MASK : SERVER_MASK, status: "ACTIVE", deviceId, createdAt: now, revokedAt: null });
    await this.store.saveAccount({ ...acc, roles, frozenBy: null });
    await this.advanceRotation(intent.rotationId, "COMPLETED");
    await this.audit({ type: "ROTATION_COMPLETED", accountId: acc.id, multisig: acc.multisig, publicKey: intent.newKey, intentId: intent.id, txSignature: sig, details: { rotationId: intent.rotationId, role: intent.role } });
    await this.audit({ type: "OPERATIONS_UNFROZEN", accountId: acc.id, multisig: acc.multisig, details: { rotationId: intent.rotationId } });
  }

  // -------------------------------------------------------------------------
  // celular (Solana Pay "transaction request")
  //
  // O celular lê um QR, busca a transação aqui, assina e ENVIA ele mesmo. O
  // serviço assina antes como pagador da taxa — por isso o id da transação (a
  // primeira assinatura) já é conhecido, e o backend acompanha a confirmação
  // na chain. Não há signMessage no Solana Pay: cadastro, entrada e prova da
  // carteira nova são transações com um memo assinado pela carteira.
  // -------------------------------------------------------------------------

  /** Assina como pagador (primeira assinatura = id da transação) e devolve base64 + id. */
  private async feePayerSigned(instructions: TransactionInstruction[], extraSigners: Signer[] = []) {
    const feePayer = this.cfg.service.feePayer;
    const message = new TransactionMessage({ payerKey: await feePayer.publicKey(), recentBlockhash: await this.chain.getLatestBlockhash(), instructions }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    for (const signer of [feePayer, ...extraSigners]) tx.addSignature(await signer.publicKey(), await signer.sign(message.serialize()));
    return { transaction: Buffer.from(tx.serialize()).toString("base64"), txid: bs58.encode(tx.signatures[0]!) };
  }

  private memoIx(text: string, signer: PublicKey) {
    return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [{ pubkey: signer, isSigner: true, isWritable: false }], data: Buffer.from(text, "utf8") });
  }

  /** A transação enviada pelo celular confirmou, sem erro, com a assinatura desta carteira? */
  private async landedBy(txid: string, wallet: string) {
    if (!this.chain.getLandedTransaction) deny("UNSUPPORTED", "esta chain não acompanha transações enviadas por terceiros");
    const t = await this.chain.getLandedTransaction(txid);
    if (!t) return null;
    if (!t.ok) deny("PHONE_TX_FAILED", t.error ?? "transação falhou");
    const idx = t.signers.findIndex((k) => k.toBase58() === wallet);
    if (idx < 0) deny("PHONE_TX_WRONG_SIGNER", "a transação não foi assinada pela carteira esperada");
    return { ...t, walletSignature: t.signatures[idx]! };
  }

  /**
   * Entrar pelo celular: se a carteira já tem conta, memo de entrada; se não,
   * memo de vínculo + criação da multisig na MESMA transação (atômico: a conta só
   * existe se a carteira assinou).
   */
  async phoneConnectTransaction(walletPublicKey: string, challenge: string) {
    new PublicKey(walletPublicKey);
    const wallet = new PublicKey(walletPublicKey);
    const existing = await this.store.findAccountByClientKey(walletPublicKey);
    if (existing) {
      const text = `Dupla Chave\nEntrar na sua conta. Isto não aprova nenhuma transação.\nDesafio: ${challenge}`;
      const built = await this.feePayerSigned([this.memoIx(text, wallet)]);
      return { kind: "LOGIN" as const, ...built, message: "Entrar na sua conta Dupla Chave. Isto não aprova nenhuma transação.", memo: text, plan: null };
    }
    if (await this.store.isRevokedKey(walletPublicKey)) deny("KEY_REVOKED", "esta carteira foi substituída e não volta a valer");
    const plan = await this.enrollmentPlan(walletPublicKey);
    const text = `Dupla Chave: vincular esta carteira a uma conta 2 de 2. Desafio: ${challenge.slice(0, 16)}`;
    const built = await this.feePayerSigned([this.memoIx(text, wallet), plan.instruction], [plan.createKey]);
    return { kind: "ENROLL" as const, ...built, message: "Criar sua conta Dupla Chave: sua carteira + a chave do serviço (2 de 2).", memo: text, plan };
  }

  /** Conclui a entrada/cadastro pelo celular depois que a transação confirmou. null = ainda não. */
  async phoneConnectComplete(req: Awaited<ReturnType<CustodyService["phoneConnectTransaction"]>>, walletPublicKey: string, walletName: string) {
    const landed = await this.landedBy(req.txid, walletPublicKey);
    if (!landed) return null;
    if (!memoSignedBy(VersionedMessage.deserialize(landed.message), req.memo, new PublicKey(walletPublicKey))) deny("PHONE_TX_MISMATCH", "memo diferente do emitido");
    if (req.kind === "LOGIN") {
      const acc = await this.store.findAccountByClientKey(walletPublicKey);
      if (!acc) deny("NOT_A_CLIENT_KEY", "esta carteira não é a carteira atual de nenhuma conta");
      return { account: acc, created: false };
    }
    const { account } = await this.saveEnrollment(req.plan!, walletName, req.txid);
    return { account, created: true };
  }

  /** Transação da carteira para uma intenção (mesmas instruções do app), já assinada como pagador. */
  async phoneSignTransaction(intentId: string, walletPublicKey: string) {
    const rec = await this.store.getIntent(intentId);
    if (!rec) deny("INTENT_NOT_FOUND", intentId);
    const acc = await this.account(rec.accountId);
    if (walletPublicKey !== acc.roles.client) deny("WRONG_WALLET", "esta não é a carteira da conta");
    const mode = this.modeFor(rec);
    if (mode !== "CANCEL" && rec.status !== "AWAITING_CLIENT") deny("INTENT_NOT_PENDING", rec.status);
    if (mode !== "CANCEL" && this.now() > rec.intent.expiresAt) deny("INTENT_EXPIRED", "intenção expirada");
    await this.verifiedState(acc);
    const built = await this.feePayerSigned(await this.walletInstructions(acc, rec, mode));
    const summary = renderIntent(rec.intent);
    const what = rec.intent.type === "ROTATE_MEMBER" ? summary.subtitle : summary.rows.slice(0, 2).map((r) => `${r.label} ${r.value}`).join(" · ");
    const message = `${mode === "CANCEL" ? "Cancelar" : mode === "APPROVE" ? "Aprovar" : "Aprovar e executar"} #${rec.intent.transactionIndex}: ${what}`;
    return { ...built, mode, message };
  }

  /**
   * Depois que o celular enviou: confere na chain e conclui (executada, rotação
   * executada pelo executor, ou cancelamento com o voto do servidor).
   */
  async phoneSignComplete(intentId: string, txid: string) {
    const first = await this.store.getIntent(intentId);
    if (!first) deny("INTENT_NOT_FOUND", intentId);
    return this.withLock(first.accountId, async () => {
      const rec = (await this.store.getIntent(intentId))!;
      const acc = await this.account(rec.accountId);
      const landed = await this.landedBy(txid, acc.roles.client);
      if (!landed) return null;
      const mode = this.modeFor(rec);
      // A mensagem confirmada tem que ser exatamente a esperada (mesmo blockhash que o celular assinou).
      const expected = new TransactionMessage({
        payerKey: await this.cfg.service.feePayer.publicKey(),
        recentBlockhash: VersionedMessage.deserialize(landed.message).recentBlockhash,
        instructions: await this.walletInstructions(acc, rec, mode),
      }).compileToV0Message();
      if (!Buffer.from(expected.serialize()).equals(Buffer.from(landed.message))) deny("PHONE_TX_MISMATCH", "a transação confirmada não é a esperada");
      rec.signatures.clientApprove = txid;
      rec.updatedAt = this.now();
      const intent = rec.intent;
      const ms = new PublicKey(acc.multisig);
      const index = BigInt(intent.transactionIndex);
      await this.store.saveApproval({ id: randomUUID(), intentId, accountId: acc.id, publicKey: acc.roles.client, role: "CLIENT", decision: mode === "CANCEL" ? "CANCEL" : "APPROVE", statement: { mode, via: "phone" }, txSignature: txid, createdAt: this.now() });
      if (mode === "CANCEL") {
        rec.signatures.reject = await this.serverVote(acc, index, "cancel", `dk1:cancel:${intent.intentHash.slice(0, 32)}`);
        rec.status = "CANCELLED";
        await this.store.saveIntent(rec);
        await this.audit({ type: "TRANSACTION_CANCELLED", accountId: acc.id, multisig: acc.multisig, transactionIndex: intent.transactionIndex, intentId, txSignature: rec.signatures.reject });
        if (intent.type === "ROTATE_MEMBER") await this.finishRotation(intent.rotationId, "REJECTED", "aprovada e cancelada");
        return rec;
      }
      await this.audit({ type: "CLIENT_APPROVED", accountId: acc.id, publicKey: acc.roles.client, multisig: acc.multisig, transactionIndex: intent.transactionIndex, intentId, intentHash: intent.intentHash, txSignature: txid, details: { via: "phone" } });
      if (mode === "APPROVE_AND_EXECUTE") {
        const p = await readProposal(this.chain, ms, index);
        if (p?.status !== "Executed") deny("NOT_EXECUTED", `proposta em ${p?.status}`);
        rec.status = "EXECUTED";
        rec.signatures.execute = txid;
        await this.store.saveIntent(rec);
        await this.audit({ type: "TRANSACTION_EXECUTED", accountId: acc.id, multisig: acc.multisig, transactionIndex: intent.transactionIndex, intentId, intentHash: intent.intentHash, txSignature: txid });
        return rec;
      }
      await this.store.saveIntent(rec);
      await this.executeRotation(acc, rec);
      return (await this.store.getIntent(intentId))!;
    });
  }

  /** Prova de posse da carteira nova pelo celular: memo com o texto de posse. */
  async phoneRotationProofTransaction(rotationId: string, newWallet: string) {
    const rot = await this.store.getRotation(rotationId);
    if (!rot) deny("ROTATION_NOT_FOUND", rotationId);
    if (rot.role !== "CLIENT" || rot.status !== "REQUESTED") deny("ROTATION_BAD_STATE", rot.status);
    const acc = await this.account(rot.accountId);
    if (newWallet === acc.roles.client) deny("SAME_WALLET", "essa é a carteira atual; escolha outra conta na carteira");
    const fields = { ...this.possessionFieldsFor(rot, acc.multisig), publicKey: newWallet };
    const built = await this.feePayerSigned([this.memoIx(possessionMessage(fields), new PublicKey(newWallet))]);
    return { ...built, fields, message: "Provar que esta carteira é sua para trocar a carteira da conta Dupla Chave." };
  }

  async phoneRotationProofComplete(rotationId: string, req: Awaited<ReturnType<CustodyService["phoneRotationProofTransaction"]>>) {
    const landed = await this.landedBy(req.txid, req.fields.publicKey);
    if (!landed) return null;
    const proof: WalletProof = { ...req.fields, via: "transaction", transactionMessage: Buffer.from(landed.message).toString("base64"), signature: bs58.encode(landed.walletSignature) };
    return this.proveClientRotationKey(rotationId, proof);
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
      vaultLamports: (await this.chain.getBalance(new PublicKey(acc.vault)).catch(() => 0n)).toString(),
      members: await this.store.listMembers(accountId),
    };
  }
}

/** createKey só semeia o PDA da multisig e assina a criação; não tem poder nenhum depois. */
function randomCreateKey(): Signer {
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

export function toInstruction(r: RawInstruction): TransactionInstruction {
  return new TransactionInstruction({ programId: r.programId, keys: r.keys, data: Buffer.from(r.data) });
}
