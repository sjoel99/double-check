import { createHash, randomUUID } from "node:crypto";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { type Cluster, deny, type IntentBody, intentBody, SecurityError, sealIntent, type TransactionIntent, type TransferSolIntent } from "@duplachave/shared";
import {
  loginMessage,
  MEMO_PROGRAM_ID,
  possessionMessage,
  type PossessionOperation,
  randomHex,
  type Signer,
  verifyEd25519,
  verifyWalletMessage,
  verifyWalletProof,
  type WalletProof,
} from "@duplachave/crypto";
import { ChainTxError, type Chain, parseInstruction, programErrorFromLogs, type RawInstruction, SYSTEM_PROGRAM } from "@duplachave/solana";
import {
  assertStrictTwoOfTwo,
  CLIENT_MASK,
  configView,
  createStrictMultisigIx,
  type ExpectedRoles,
  readMultisig,
  rotationActions,
  type MultisigState,
  SERVER_MASK,
  transactionPda,
  vaultPda,
} from "@duplachave/squads";
import { DEFAULT_POLICY, type PolicyEngine, type User } from "@duplachave/policy-engine";
import { type ApprovalRequest, atomicInstructionsFor, compileAtomic } from "./client";
import type { ServerKeyProvider, ServiceKeys } from "./keys";
import type { NotificationService } from "./notifications";
import type { AuditInput, ChallengeStore, IntentRecord, PreparedEntry, RotationRecord, RotationStatus, SmartAccountRecord, Store } from "./store";
import { renderIntent } from "./display";

const utf8 = (s: string) => new TextEncoder().encode(s);
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const sha256 = (u: Uint8Array) => createHash("sha256").update(u).digest("hex");

/**
 * Por quanto tempo uma transação preparada ainda pode entrar na chain. O
 * blockhash vale 150 blocos (~60–90 s); a margem cobre slots lentos. Depois
 * disso, se não entrou, não entra mais.
 */
export const PREPARED_WINDOW = 180;

/** Taxa de uma assinatura na Solana. */
const SIGNATURE_FEE = 5000n;

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

/**
 * Transições da rotação. Sem congelamento: no modelo atômico nada fica pendente
 * na chain, então não há fila para drenar antes de trocar uma chave.
 */
const ROTATION_TRANSITIONS: Record<RotationStatus, RotationStatus[]> = {
  REQUESTED: ["NEW_KEY_VERIFIED", "REJECTED", "EXPIRED", "FAILED"],
  NEW_KEY_VERIFIED: ["AWAITING_CLIENT_APPROVAL", "EXPIRED", "FAILED"],
  AWAITING_CLIENT_APPROVAL: ["VERIFIED", "REJECTED", "EXPIRED", "FAILED", "ROLLBACK_REQUIRED"],
  VERIFIED: ["COMPLETED", "ROLLBACK_REQUIRED"],
  // Estados do modelo anterior (proposta pendente na chain); não são mais alcançados.
  OPERATIONS_FROZEN: [],
  AWAITING_SERVER_APPROVAL: [],
  EXECUTING: [],
  COMPLETED: [],
  REJECTED: [],
  EXPIRED: [],
  FAILED: [],
  ROLLBACK_REQUIRED: [],
};

const TERMINAL: RotationStatus[] = ["COMPLETED", "REJECTED", "EXPIRED", "FAILED", "ROLLBACK_REQUIRED"];

/** Cadastro preparado: a carteira assina e paga a criação da multisig. */
type PendingEnrollment = {
  id: string;
  wallet: string;
  walletName: string;
  plan: EnrollmentPlan;
  message: string;
  createdAt: number;
};

type EnrollmentPlan = {
  userId: string;
  roles: ExpectedRoles;
  multisig: string;
  vault: string;
};

export type PreparedEnrollment = {
  enrollmentId: string;
  /** Transação (base64) já assinada pela createKey; falta a carteira, que paga. */
  transaction: string;
  multisig: string;
  vault: string;
  /** Texto do memo que a carteira mostra. */
  memo: string;
};

type Landed = { signature: string; ok: boolean; error: string | null; message: string; signatures: Uint8Array[]; signers: PublicKey[] };

export class CustodyService {
  readonly chain: Chain;
  private readonly store: Store & ChallengeStore;
  private readonly now: () => number;
  private readonly intentTtl: number;
  private readonly rotationTtl: number;
  private locks = new Map<string, Promise<unknown>>();
  /** Cadastros preparados e ainda não confirmados. Duram minutos; em memória basta. */
  private enrollments = new Map<string, PendingEnrollment>();

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

  private async intentRecord(id: string): Promise<IntentRecord> {
    const rec = await this.store.getIntent(id);
    if (!rec) deny("INTENT_NOT_FOUND", id);
    return rec;
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

  /**
   * Transação paga pela carteira: compila com ela como pagadora e as outras
   * chaves (servidor, proponente, createKey) assinam antes. A carteira assina
   * por último, na janela dela.
   */
  private async walletPaid(wallet: PublicKey, instructions: TransactionInstruction[], preSigners: Signer[] = []) {
    const message = compileAtomic(instructions, wallet, await this.chain.getLatestBlockhash());
    const tx = new VersionedTransaction(message);
    for (const s of preSigners) tx.addSignature(await s.publicKey(), await s.sign(message.serialize()));
    return { tx, message: b64(message.serialize()), transaction: b64(tx.serialize()) };
  }

  /**
   * Simula a transação inteira (sem assinaturas) antes de o servidor assinar:
   * pega saldo insuficiente da carteira e execução que falharia.
   */
  private async simulateWalletPaid(wallet: PublicKey, instructions: TransactionInstruction[], need: string) {
    if (!this.chain.simulate) return;
    const sim = await this.chain.simulate(wallet, instructions);
    if (sim.ok) return;
    const balance = await this.chain.getBalance(wallet);
    const noFunds = /insufficient|AccountNotFound|0x1\b|Custom":1\b/i.test(`${sim.error} ${sim.logs.join(" ")}`);
    if (balance === 0n || noFunds) deny("WALLET_NO_SOL", `sua carteira precisa de SOL para esta transação (${need})`);
    deny("SIMULATION_FAILED", programErrorFromLogs(sim.logs) ?? sim.error ?? "simulação falhou");
  }

  /** Confere que a transação assinada é a preparada (bytes da mensagem) e que a carteira assinou. */
  private parseSigned(transactionB64: string, messages: string[], wallet: string): { tx: VersionedTransaction; message: string } {
    if (!transactionB64) deny("NO_TRANSACTION", "sem a transação assinada pela carteira");
    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(Buffer.from(transactionB64, "base64"));
    } catch {
      deny("TX_MALFORMED", "transação ilegível");
    }
    const message = b64(tx.message.serialize());
    if (!messages.includes(message)) deny("TX_NOT_EXPECTED", "a transação assinada não é a preparada");
    const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
    const wi = signers.findIndex((k) => k.toBase58() === wallet);
    if (wi < 0 || !verifyEd25519(tx.message.serialize(), tx.signatures[wi]!, new PublicKey(wallet))) deny("WALLET_BAD_SIGNATURE", "assinatura da carteira inválida");
    return { tx, message };
  }

  private async sendSigned(tx: VersionedTransaction): Promise<string> {
    try {
      return await this.chain.sendTransaction(tx);
    } catch (e) {
      if (e instanceof ChainTxError) deny("WALLET_TX_FAILED", e.programError ?? e.message);
      throw e;
    }
  }

  /**
   * Procura na chain uma transação confirmada cuja mensagem é uma das
   * preparadas. Serve para o celular (que envia sozinho) e para conciliar.
   */
  private async findLanded(anchor: PublicKey, messages: string[], limit = 20): Promise<Landed | null> {
    if (!this.chain.signaturesFor || !this.chain.getLandedTransaction) deny("UNSUPPORTED", "esta chain não acompanha transações enviadas pela carteira");
    for (const signature of await this.chain.signaturesFor(anchor, limit)) {
      const t = await this.chain.getLandedTransaction(signature);
      if (!t) continue;
      const message = b64(t.message);
      if (messages.includes(message)) return { signature, ...t, message };
    }
    return null;
  }

  private memoIx(text: string, signer: PublicKey) {
    return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [{ pubkey: signer, isSigner: true, isWritable: false }], data: Buffer.from(text, "utf8") });
  }

  private async requireFee(wallet: PublicKey, code: string, msg: string) {
    if ((await this.chain.getBalance(wallet)) < SIGNATURE_FEE) deny(code, msg);
  }

  // -------------------------------------------------------------------------
  // desafios, cadastro e sessão
  // -------------------------------------------------------------------------

  /** Desafio de entrada + o texto exato que a carteira vai assinar (e mostrar). */
  async createChallenge(purpose: "AUTH", publicKey: string) {
    new PublicKey(publicKey);
    const c = { id: randomUUID(), purpose, subject: publicKey, challenge: randomHex(32), expiresAt: this.now() + 300 };
    await this.store.putChallenge(c);
    return { ...c, message: loginMessage({ publicKey, cluster: this.cfg.cluster, challenge: c.challenge, expiresAt: c.expiresAt }) };
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
   * Cadastro, passo 1: monta a criação da multisig 2-de-2 (carteira + chave nova
   * do servidor; executor e proponente do serviço) PAGA PELA CARTEIRA, com um
   * memo de vínculo assinado por ela. A assinatura da carteira nessa transação
   * é a prova de posse: sem ela a conta não existe.
   */
  async prepareEnrollment(args: { publicKey: string; walletName: string }): Promise<PreparedEnrollment> {
    const wallet = new PublicKey(args.publicKey);
    if (await this.store.isRevokedKey(args.publicKey)) deny("KEY_REVOKED", "esta carteira foi substituída e não volta a valer");
    if (await this.store.findAccountByClientKey(args.publicKey)) deny("WALLET_ALREADY_ENROLLED", "esta carteira já tem uma conta");
    if (await this.cfg.serverKeys.get(args.publicKey)) deny("CLIENT_KEY_IS_SERVER_KEY", "chave do servidor não pode ser a carteira do cliente");
    await this.pruneEnrollments();

    const userId = randomUUID();
    const server = await this.cfg.serverKeys.create(`server:${userId}`);
    const roles: ExpectedRoles = {
      client: args.publicKey,
      server: (await server.publicKey()).toBase58(),
      executor: (await this.cfg.service.executor.publicKey()).toBase58(),
      proposer: (await this.cfg.service.proposer.publicKey()).toBase58(),
    };
    const createKey = randomCreateKey();
    const created = createStrictMultisigIx({
      createKey: await createKey.publicKey(),
      creator: wallet,
      treasury: this.cfg.squadsTreasury,
      layout: { client: wallet, server: new PublicKey(roles.server), executor: new PublicKey(roles.executor), proposer: new PublicKey(roles.proposer) },
      rentCollector: wallet,
    });
    const id = randomUUID();
    const memo = `Dupla Chave: criar sua conta 2 de 2 (esta carteira + a chave do serviço). Ref ${id.slice(0, 8)}`;
    const instructions = [this.memoIx(memo, wallet), created.instruction];
    await this.simulateWalletPaid(wallet, instructions, "~0,003 SOL para criar a conta");
    const built = await this.walletPaid(wallet, instructions, [createKey]);
    const plan: EnrollmentPlan = { userId, roles, multisig: created.multisig.toBase58(), vault: created.vault.toBase58() };
    this.enrollments.set(id, { id, wallet: args.publicKey, walletName: args.walletName, plan, message: built.message, createdAt: this.now() });
    return { enrollmentId: id, transaction: built.transaction, multisig: plan.multisig, vault: plan.vault, memo };
  }

  /** Cadastro, passo 2 (extensão): recebe a transação assinada, envia e grava a conta. */
  async submitEnrollment(enrollmentId: string, transactionB64: string) {
    const p = this.enrollments.get(enrollmentId);
    if (!p) deny("ENROLLMENT_NOT_FOUND", "cadastro não existe ou expirou; comece de novo");
    const { tx } = this.parseSigned(transactionB64, [p.message], p.wallet);
    const sig = await this.sendSigned(tx);
    return this.finishEnrollment(p, sig);
  }

  /** Cadastro, passo 2 (celular): a carteira enviou sozinha; procura na chain. null = ainda não. */
  async completeEnrollmentFromChain(enrollmentId: string) {
    const p = this.enrollments.get(enrollmentId);
    if (!p) {
      deny("ENROLLMENT_NOT_FOUND", "cadastro não existe ou expirou");
    }
    const landed = await this.findLanded(new PublicKey(p.plan.multisig), [p.message]);
    if (!landed) return null;
    if (!landed.ok) deny("WALLET_TX_FAILED", landed.error ?? "a transação falhou");
    return this.finishEnrollment(p, landed.signature);
  }

  private async finishEnrollment(p: PendingEnrollment, sig: string) {
    this.enrollments.delete(p.id);
    const { userId, roles } = p.plan;
    const now = this.now();
    await this.store.saveUser({ id: userId, name: p.walletName, policy: DEFAULT_POLICY, createdAt: now });
    const deviceId = randomUUID();
    await this.store.saveDevice({ id: deviceId, userId, name: p.walletName, publicKey: roles.client, createdAt: now, revokedAt: null });
    const acc: SmartAccountRecord = { id: randomUUID(), userId, cluster: this.cfg.cluster, multisig: p.plan.multisig, vault: p.plan.vault, roles, frozenBy: null, createdAt: now };
    await this.store.saveAccount(acc);
    await this.verifiedState(acc);
    const member = (publicKey: string, role: "CLIENT" | "SERVER" | "EXECUTOR" | "PROPOSER", permissions: number, dev: string | null = null) =>
      this.store.saveMember({ accountId: acc.id, publicKey, role, permissions, status: "ACTIVE", deviceId: dev, createdAt: now, revokedAt: null });
    await member(roles.client, "CLIENT", CLIENT_MASK, deviceId);
    await member(roles.server, "SERVER", SERVER_MASK);
    await member(roles.executor, "EXECUTOR", 4);
    await member(roles.proposer, "PROPOSER", 1);
    await this.audit({ type: "SMART_ACCOUNT_CREATED", accountId: acc.id, userId, deviceId, multisig: acc.multisig, txSignature: sig, publicKey: roles.client, details: { wallet: p.walletName, paidBy: "wallet" } });
    return { account: acc, deviceId, created: true as const };
  }

  /**
   * Cadastros que a carteira não assinou a tempo: a chave do servidor gerada
   * para eles é descartada. Se a criação entrou na chain e ninguém concluiu,
   * conclui agora.
   */
  private async pruneEnrollments() {
    const cutoff = this.now() - PREPARED_WINDOW;
    for (const p of [...this.enrollments.values()]) {
      if (p.createdAt > cutoff) continue;
      try {
        if (await this.chain.getAccountInfo(new PublicKey(p.plan.multisig))) {
          const landed = await this.findLanded(new PublicKey(p.plan.multisig), [p.message]);
          if (landed?.ok) {
            await this.finishEnrollment(p, landed.signature);
            continue;
          }
        }
        this.enrollments.delete(p.id);
        await this.cfg.serverKeys.retire(p.plan.roles.server);
      } catch (e) {
        this.cfg.log?.(`cadastro ${p.id}: ${String(e)}`);
      }
    }
  }

  /** Entrada pela extensão: a carteira assina o texto de entrada (signMessage, sem custo). */
  async login(args: { challengeId: string; publicKey: string; signature: string }) {
    const ch = await this.store.takeChallenge(args.challengeId);
    if (!ch || ch.purpose !== "AUTH" || ch.subject !== args.publicKey || ch.expiresAt < this.now()) deny("CHALLENGE_INVALID", "desafio inválido");
    const text = loginMessage({ publicKey: args.publicKey, cluster: this.cfg.cluster, challenge: ch.challenge, expiresAt: ch.expiresAt });
    if (!verifyWalletMessage(text, args.signature, args.publicKey)) deny("BAD_SIGNATURE", "assinatura inválida");
    return this.accountOfWallet(args.publicKey);
  }

  private async accountOfWallet(publicKey: string) {
    const acc = await this.store.findAccountByClientKey(publicKey);
    if (!acc) {
      if (await this.store.isRevokedKey(publicKey)) deny("KEY_REVOKED", "esta carteira foi substituída e não volta a valer");
      deny("NOT_A_CLIENT_KEY", "esta carteira não é a carteira atual de nenhuma conta");
    }
    return acc;
  }

  // -------------------------------------------------------------------------
  // operações
  //
  // Nada vai para a chain até a carteira assinar. A intenção é um rascunho
  // (política + simulação); ao preparar, o servidor monta a transação atômica
  // [criar, proposta, voto do servidor, voto da carteira, executar, fechar],
  // assina como servidor e proponente, e a carteira assina por último e paga.
  // -------------------------------------------------------------------------

  /** Política + destino + simulação da transferência. Devolve os alertas ou recusa. */
  private async checkTransfer(acc: SmartAccountRecord, user: User, intent: TransferSolIntent & { intentHash: string }): Promise<string[]> {
    const vault = new PublicKey(intent.vault);
    const destination = new PublicKey(intent.destination);
    const instructions = [SystemProgram.transfer({ fromPubkey: vault, toPubkey: destination, lamports: BigInt(intent.amountLamports) })];
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
      await this.audit({ type: "TRANSACTION_POLICY_DENIED", accountId: acc.id, multisig: acc.multisig, intentId: intent.id, intentHash: intent.intentHash, details: { reasons: pre.reasons } });
      throw new SecurityError("POLICY_DENIED", pre.reasons.join("; "));
    }
    return pre.riskFlags;
  }

  /** Rascunho da transferência: política e simulação. Nada vai para a chain. */
  async createTransferSol(accountId: string, req: { destination: string; amountLamports: string }) {
    return this.withLock(accountId, async () => {
      const acc = await this.account(accountId);
      const user = await this.user(acc.userId);
      const state = await this.verifiedState(acc);
      const vault = vaultPda(new PublicKey(acc.multisig), 0);
      const destination = new PublicKey(req.destination);
      const amount = BigInt(req.amountLamports);
      if (amount <= 0n) deny("INVALID_AMOUNT", "valor deve ser positivo");
      const now = this.now();
      const body: TransferSolIntent = {
        version: 1,
        id: randomUUID(),
        cluster: this.cfg.cluster,
        multisig: acc.multisig,
        // Provisório: o índice definitivo é fixado ao preparar.
        transactionIndex: (state.transactionIndex + 1n).toString(),
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
      const intent = sealIntent(body) as TransferSolIntent & { intentHash: string };
      const riskFlags = await this.checkTransfer(acc, user, intent);
      const rec: IntentRecord = { intent, accountId, transactionHash: "", status: "AWAITING_CLIENT", riskFlags, reasons: [], signatures: {}, updatedAt: now, prepared: null };
      await this.store.saveIntent(rec);
      await this.audit({ type: "TRANSACTION_PROPOSED", accountId, multisig: acc.multisig, intentId: intent.id, intentHash: intent.intentHash, details: { stage: "draft" } });
      await this.cfg.notifications.transactionApprovalRequested(
        { userId: acc.userId, accountId },
        { intentId: intent.id, summary: renderIntent(intent).rows.map((r) => `${r.label}: ${r.value}`).slice(0, 2).join(" · ") },
      );
      return rec;
    });
  }

  /** Política da troca de chave, contra o estado de agora. */
  private async checkRotation(acc: SmartAccountRecord, state: MultisigState, intent: TransactionIntent) {
    if (intent.type !== "ROTATE_MEMBER") return;
    const rot = await this.store.getRotation(intent.rotationId);
    if (!rot || rot.status !== "AWAITING_CLIENT_APPROVAL" || rot.newKey !== intent.newKey || rot.oldKey !== intent.oldKey || rot.role !== intent.role)
      deny("ROTATION_BAD_STATE", "a troca não está aguardando aprovação");
    const view = configView(rotationActions(new PublicKey(intent.oldKey), new PublicKey(intent.newKey), intent.role), state, acc.roles);
    const user = await this.user(acc.userId);
    const decision = await this.cfg.policy.validate(user, intent, view, {
      vaultLamports: 0n,
      verifiedNewKeys: [rot.newKey!],
      revokedKeys: (await this.store.isRevokedKey(rot.newKey!)) ? [rot.newKey!] : [],
    });
    if (state.members.some((m) => m.key === intent.newKey)) decision.reasons.push("KEY_ALREADY_MEMBER");
    const serverControls = Boolean(await this.cfg.serverKeys.get(intent.newKey));
    if (intent.role === "SERVER" && !serverControls) decision.reasons.push("SERVER_KEY_NOT_CONTROLLED");
    if (intent.role === "CLIENT" && serverControls) decision.reasons.push("CLIENT_KEY_IS_SERVER_KEY");
    if (decision.reasons.length) deny("POLICY_DENIED", decision.reasons.join("; "));
  }

  /**
   * Prepara a transação atômica que a carteira vai assinar: índice de agora,
   * política e simulação de novo, assinatura do servidor (o voto dele) e do
   * proponente. A carteira paga taxa e rent; o rent volta na mesma transação.
   */
  async prepareIntent(intentId: string, walletPublicKey?: string): Promise<ApprovalRequest> {
    const first = await this.intentRecord(intentId);
    return this.withLock(first.accountId, async () => {
      let acc = await this.account(first.accountId);
      await this.reconcile(acc);
      acc = await this.account(first.accountId);
      let rec = await this.intentRecord(intentId);
      if (walletPublicKey && walletPublicKey !== acc.roles.client) deny("WRONG_WALLET", "esta não é a carteira da conta");
      if (rec.status !== "AWAITING_CLIENT") deny("INTENT_NOT_PENDING", `intenção em ${rec.status}`);
      if (this.now() > rec.intent.expiresAt) {
        await this.expireIntent(rec);
        deny("INTENT_EXPIRED", "intenção expirada");
      }
      const state = await this.verifiedState(acc);
      const index = state.transactionIndex + 1n;
      let intent = rec.intent;
      if (intent.transactionIndex !== index.toString()) intent = sealIntent({ ...intentBody(intent), transactionIndex: index.toString() } as IntentBody);

      let riskFlags = rec.riskFlags;
      if (intent.type === "TRANSFER_SOL") riskFlags = await this.checkTransfer(acc, await this.user(acc.userId), intent);
      else await this.checkRotation(acc, state, intent);

      const wallet = new PublicKey(acc.roles.client);
      const server = await this.serverSigner(acc);
      const proposer = this.cfg.service.proposer;
      const roles = { proposer: await proposer.publicKey(), server: await server.publicKey(), wallet };
      const instructions = atomicInstructionsFor(intent, roles, state);
      await this.simulateWalletPaid(wallet, instructions, "tenha ~0,007 SOL: o depósito das contas volta na mesma transação e o custo real é ~0,000015 SOL");
      const built = await this.walletPaid(wallet, instructions, [proposer, server]);

      const now = this.now();
      const live = (rec.prepared ?? []).filter((e) => e.preparedAt > now - PREPARED_WINDOW);
      rec = { ...rec, intent, riskFlags, transactionHash: sha256(Buffer.from(built.message, "base64")), prepared: [...live, { index: index.toString(), message: built.message, preparedAt: now }], updatedAt: now };
      await this.store.saveIntent(rec);
      await this.audit({ type: "SERVER_APPROVED", accountId: acc.id, publicKey: acc.roles.server, multisig: acc.multisig, transactionIndex: index.toString(), intentId, intentHash: intent.intentHash, details: { stage: "prepared", riskFlags } });

      let possession: WalletProof | null = null;
      if (intent.type === "ROTATE_MEMBER") possession = ((await this.store.getRotation(intent.rotationId))?.possession as WalletProof | null) ?? null;
      return { intent, riskFlags, transaction: built.transaction, possession };
    });
  }

  /** Extensão: recebe a transação assinada pela carteira, confere que é a preparada e envia. */
  async submitIntent(intentId: string, transactionB64: string) {
    const first = await this.intentRecord(intentId);
    return this.withLock(first.accountId, async () => {
      const rec = await this.intentRecord(intentId);
      const acc = await this.account(rec.accountId);
      const refuse = async (code: string, msg: string): Promise<never> => {
        await this.audit({ type: "APPROVAL_REFUSED", accountId: acc.id, multisig: acc.multisig, transactionIndex: rec.intent.transactionIndex, intentId, intentHash: rec.intent.intentHash, details: { code, msg } });
        throw new SecurityError(code, msg);
      };
      if (rec.status !== "AWAITING_CLIENT") return refuse("INTENT_NOT_PENDING", `intenção em ${rec.status}`);
      const entries = rec.prepared ?? [];
      let parsed: { tx: VersionedTransaction; message: string };
      let sig: string;
      try {
        parsed = this.parseSigned(transactionB64, entries.map((e) => e.message), acc.roles.client);
        sig = await this.sendSigned(parsed.tx);
      } catch (e) {
        if (e instanceof SecurityError) return refuse(e.code, e.message);
        throw e;
      }
      const entry = entries.find((e) => e.message === parsed.message)!;
      return this.finalizeIntent(acc, rec, entry, sig);
    });
  }

  /** Celular: a carteira enviou sozinha. Procura na chain e conclui. null = ainda não confirmou. */
  async completeIntentFromChain(intentId: string) {
    const first = await this.intentRecord(intentId);
    return this.withLock(first.accountId, async () => {
      const rec = await this.intentRecord(intentId);
      if (rec.status === "EXECUTED") return rec;
      const acc = await this.account(rec.accountId);
      const found = await this.landedEntry(acc, rec);
      if (!found) return null;
      if (!found.landed.ok) deny("WALLET_TX_FAILED", found.landed.error ?? "a transação falhou");
      return this.finalizeIntent(acc, rec, found.entry, found.landed.signature);
    });
  }

  /** Alguma das transações preparadas desta intenção entrou na chain? */
  private async landedEntry(acc: SmartAccountRecord, rec: IntentRecord) {
    const entries = rec.prepared ?? [];
    for (const index of new Set(entries.map((e) => e.index))) {
      const messages = entries.filter((e) => e.index === index).map((e) => e.message);
      const landed = await this.findLanded(transactionPda(new PublicKey(acc.multisig), BigInt(index)), messages);
      if (landed) return { landed, entry: entries.find((e) => e.message === landed.message)! };
    }
    return null;
  }

  /** A transação atômica entrou: aprovada pelos dois e executada, num passo só. */
  private async finalizeIntent(acc: SmartAccountRecord, rec: IntentRecord, entry: PreparedEntry, txid: string) {
    const intent = entry.index === rec.intent.transactionIndex ? rec.intent : sealIntent({ ...intentBody(rec.intent), transactionIndex: entry.index } as IntentBody);
    const late = rec.status !== "AWAITING_CLIENT";
    const now = this.now();
    const hash = sha256(Buffer.from(entry.message, "base64"));
    const done: IntentRecord = {
      ...rec,
      intent,
      status: "EXECUTED",
      reasons: late ? [`executada na chain depois de marcada ${rec.status}`] : [],
      transactionHash: hash,
      prepared: null,
      signatures: { ...rec.signatures, serverApprove: txid, clientApprove: txid, execute: txid },
      updatedAt: now,
    };
    await this.store.saveIntent(done);
    const ms = new PublicKey(acc.multisig);
    await this.store.saveSquadsTransaction({
      accountId: acc.id,
      multisig: acc.multisig,
      transactionIndex: entry.index,
      kind: intent.kind === "CONFIG" ? "CONFIG" : "VAULT",
      address: transactionPda(ms, BigInt(entry.index)).toBase58(),
      hash,
      intentId: intent.id,
      createSignature: txid,
      createdAt: now,
    });
    for (const [role, publicKey] of [["SERVER", acc.roles.server], ["CLIENT", acc.roles.client]] as const)
      await this.store.saveApproval({ id: randomUUID(), intentId: intent.id, accountId: acc.id, publicKey, role, decision: "APPROVE", statement: { atomic: true }, txSignature: txid, createdAt: now });
    const common = { accountId: acc.id, multisig: acc.multisig, transactionIndex: entry.index, intentId: intent.id, intentHash: intent.intentHash, txSignature: txid };
    await this.audit({ type: "CLIENT_APPROVED", publicKey: acc.roles.client, ...common });
    await this.audit({ type: "TRANSACTION_EXECUTED", ...common, details: { atomic: true, paidBy: "wallet", late } });
    if (intent.type === "ROTATE_MEMBER") await this.finalizeRotation(acc.id, done, txid);
    return (await this.store.getIntent(intent.id))!;
  }

  /**
   * Concilia com a chain: transações preparadas que entraram viram EXECUTED
   * (mesmo se aqui a intenção já tinha sido recusada ou vencida — a chain manda);
   * as que não podem mais entrar saem da lista.
   */
  private async reconcile(acc: SmartAccountRecord) {
    const recs = (await this.store.listIntents(acc.id)).filter((r) => r.prepared?.length && r.status !== "EXECUTED");
    if (!recs.length) return;
    const now = this.now();
    let state = await readMultisig(this.chain, new PublicKey(acc.multisig));
    for (const rec of recs) {
      const current = await this.account(acc.id);
      const entries = rec.prepared!;
      // Índice já usado: decide olhando a chain. Ainda livre: só a validade decide.
      const decidable = entries.filter((e) => BigInt(e.index) <= state.transactionIndex);
      if (decidable.length) {
        const found = await this.landedEntry(current, { ...rec, prepared: decidable });
        if (found?.landed.ok) {
          await this.finalizeIntent(current, rec, found.entry, found.landed.signature);
          state = await readMultisig(this.chain, new PublicKey(acc.multisig));
          continue;
        }
      }
      const live = entries.filter((e) => BigInt(e.index) > state.transactionIndex && e.preparedAt > now - PREPARED_WINDOW);
      if (live.length !== entries.length) await this.store.saveIntent({ ...rec, prepared: live });
    }
  }

  /** Ainda pode entrar na chain alguma transação preparada desta intenção? */
  private hasLivePrepared(rec: IntentRecord) {
    return (rec.prepared ?? []).some((e) => e.preparedAt > this.now() - PREPARED_WINDOW);
  }

  /** O cliente recusa no app. Nada a desfazer na chain: nada foi para lá. */
  async rejectByClient(intentId: string) {
    const first = await this.intentRecord(intentId);
    return this.withLock(first.accountId, async () => {
      const rec = await this.intentRecord(intentId);
      const acc = await this.account(rec.accountId);
      if (rec.status !== "AWAITING_CLIENT") deny("INTENT_NOT_PENDING", rec.status);
      const out: IntentRecord = { ...rec, status: "REJECTED", reasons: ["recusada pelo cliente"], updatedAt: this.now() };
      await this.store.saveIntent(out);
      await this.audit({ type: "CLIENT_REJECTED", accountId: acc.id, multisig: acc.multisig, intentId, intentHash: rec.intent.intentHash });
      if (rec.intent.type === "ROTATE_MEMBER") await this.finishRotation(rec.intent.rotationId, "REJECTED", "cliente recusou");
      return out;
    });
  }

  private async expireIntent(rec: IntentRecord) {
    const out: IntentRecord = { ...rec, status: "EXPIRED", updatedAt: this.now() };
    await this.store.saveIntent(out);
    await this.audit({ type: "TRANSACTION_EXPIRED", accountId: rec.accountId, multisig: rec.intent.multisig, intentId: rec.intent.id, intentHash: rec.intent.intentHash });
    if (rec.intent.type === "ROTATE_MEMBER") await this.finishRotation(rec.intent.rotationId, "EXPIRED", "aprovação não chegou a tempo");
  }

  /**
   * Encerra pendências vencidas, depois de conciliar com a chain. Uma intenção
   * com transação preparada ainda válida espera: ela ainda pode entrar.
   */
  async expireDue(accountId: string) {
    return this.withLock(accountId, async () => {
      const acc = await this.account(accountId);
      try {
        await this.reconcile(acc);
      } catch (e) {
        this.cfg.log?.(`conciliar ${accountId}: ${String(e)}`);
        return;
      }
      const now = this.now();
      for (const rec of await this.store.listIntents(accountId)) {
        if (rec.status === "AWAITING_CLIENT" && now > rec.intent.expiresAt && !this.hasLivePrepared(rec)) await this.expireIntent(rec);
      }
      for (const rot of await this.store.listRotations(accountId)) {
        if (TERMINAL.includes(rot.status) || now <= rot.expiresAt) continue;
        const rec = rot.intentId ? await this.store.getIntent(rot.intentId) : null;
        if (rec && rec.status === "AWAITING_CLIENT" && this.hasLivePrepared(rec)) continue;
        await this.finishRotation(rot.id, "EXPIRED", "prazo da troca venceu");
      }
    });
  }

  // -------------------------------------------------------------------------
  // troca de carteira / chave do servidor (ConfigTransaction atômica)
  // -------------------------------------------------------------------------

  private async advanceRotation(id: string, to: RotationStatus, note?: string, patch: Partial<RotationRecord> = {}) {
    const rot = await this.store.getRotation(id);
    if (!rot) deny("ROTATION_NOT_FOUND", id);
    if (!ROTATION_TRANSITIONS[rot.status].includes(to)) deny("ROTATION_BAD_TRANSITION", `${rot.status} → ${to}`);
    const next: RotationRecord = { ...rot, ...patch, status: to, history: [...rot.history, { status: to, at: this.now(), note }] };
    await this.store.saveRotation(next);
    return next;
  }

  /** Encerra uma rotação sem sucesso. Nada na chain: a transação só existe se a carteira assinar. */
  private async finishRotation(id: string, to: "REJECTED" | "EXPIRED" | "FAILED", note: string) {
    const rot = await this.store.getRotation(id);
    if (!rot || TERMINAL.includes(rot.status)) return;
    if (rot.intentId) {
      const rec = await this.store.getIntent(rot.intentId);
      if (rec?.status === "AWAITING_CLIENT") await this.store.saveIntent({ ...rec, status: to, updatedAt: this.now() });
    }
    if (ROTATION_TRANSITIONS[rot.status].includes(to)) await this.advanceRotation(id, to, note);
    else await this.store.saveRotation({ ...rot, status: "FAILED", history: [...rot.history, { status: "FAILED", at: this.now(), note: `${note} (de ${rot.status})` }] });
    const type = to === "REJECTED" ? "ROTATION_REJECTED" : to === "EXPIRED" ? "ROTATION_EXPIRED" : "ROTATION_FAILED";
    await this.audit({ type, accountId: rot.accountId, details: { rotationId: id, note } });
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

  private async openRotation(accountId: string) {
    return (await this.store.listRotations(accountId)).find((r) => !TERMINAL.includes(r.status));
  }

  /** Passo 1: a carteira atual (com sessão) pede a troca. */
  async requestClientRotation(accountId: string, args: { newWalletName?: string } = {}) {
    return this.withLock(accountId, async () => {
      const acc = await this.account(accountId);
      await this.verifiedState(acc);
      const open = await this.openRotation(accountId);
      if (open) deny("ROTATION_IN_PROGRESS", open.id);
      const rot = { ...this.newRotation(acc, "CLIENT"), newDeviceName: args.newWalletName ?? null };
      await this.store.saveRotation(rot);
      await this.audit({ type: "CLIENT_KEY_ROTATION_REQUESTED", accountId, multisig: acc.multisig, publicKey: acc.roles.client, details: { rotationId: rot.id } });
      return { rotation: rot, fields: this.possessionFieldsFor(rot, acc.multisig) };
    });
  }

  /** Passo 2: a carteira nova prova posse; vira uma intenção que a carteira atual assina. */
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
      return this.proposeRotation(rotationId);
    });
  }

  /** Rotação da chave do servidor: o backend gera e prova a nova; a carteira do cliente precisa assinar. */
  async requestServerRotation(accountId: string, reason: string) {
    return this.withLock(accountId, async () => {
      const acc = await this.account(accountId);
      await this.verifiedState(acc);
      const open = await this.openRotation(accountId);
      if (open) deny("ROTATION_IN_PROGRESS", open.id);
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
      return this.proposeRotation(rot.id);
    });
  }

  /** Cria a intenção da troca (rascunho) e confere a política. A chain só muda quando a carteira assinar. */
  private async proposeRotation(rotationId: string) {
    try {
      const rot = (await this.store.getRotation(rotationId))!;
      const acc = await this.account(rot.accountId);
      const state = await this.verifiedState(acc);
      const now = this.now();
      const body: IntentBody = {
        version: 1,
        id: randomUUID(),
        cluster: this.cfg.cluster,
        multisig: acc.multisig,
        transactionIndex: (state.transactionIndex + 1n).toString(),
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
      const rotation = await this.advanceRotation(rotationId, "AWAITING_CLIENT_APPROVAL", undefined, { intentId: intent.id });
      await this.checkRotation(acc, state, intent);
      const flags = ["SECURITY_CHANGE", rot.role === "CLIENT" ? "CLIENT_KEY_ROTATION" : "SERVER_KEY_ROTATION"];
      await this.store.saveIntent({ intent, accountId: acc.id, transactionHash: "", status: "AWAITING_CLIENT", riskFlags: flags, reasons: [], signatures: {}, updatedAt: now, prepared: null });
      await this.audit({ type: "TRANSACTION_PROPOSED", accountId: acc.id, multisig: acc.multisig, intentId: intent.id, intentHash: intent.intentHash, details: { stage: "draft", rotationId } });
      await this.cfg.notifications.keyRotationRequested(
        { userId: acc.userId, accountId: acc.id },
        { rotationId, role: rot.role, summary: rot.role === "CLIENT" ? "Troca da carteira da conta" : "O serviço pede atualização da chave de segurança" },
      );
      return { rotation, intent };
    } catch (e) {
      await this.finishRotation(rotationId, "FAILED", String(e)).catch(() => {});
      throw e;
    }
  }

  /** A troca entrou na chain: confere o 2-de-2 com a chave nova e atualiza os registros. */
  private async finalizeRotation(accountId: string, rec: IntentRecord, sig: string) {
    const intent = rec.intent;
    if (intent.type !== "ROTATE_MEMBER") return;
    const acc = await this.account(accountId);
    const roles: ExpectedRoles = { ...acc.roles, [intent.role === "CLIENT" ? "client" : "server"]: intent.newKey };
    const state = await readMultisig(this.chain, new PublicKey(acc.multisig));
    const rot0 = (await this.store.getRotation(intent.rotationId))!;
    const force = async (status: RotationStatus, note?: string) => {
      const r = (await this.store.getRotation(intent.rotationId))!;
      await this.store.saveRotation({ ...r, status, history: [...r.history, { status, at: this.now(), note }] });
    };
    try {
      assertStrictTwoOfTwo(state, roles);
    } catch (e) {
      await force("ROLLBACK_REQUIRED", String(e));
      await this.audit({ type: "INVARIANT_VIOLATION", accountId: acc.id, multisig: acc.multisig, details: { error: String(e) } });
      throw e;
    }
    // A chain manda: se aqui a troca já tinha sido encerrada, ela aconteceu mesmo assim.
    await force("VERIFIED", TERMINAL.includes(rot0.status) ? `executada na chain depois de ${rot0.status}` : undefined);
    await this.audit({ type: "NEW_MEMBER_ADDED", accountId: acc.id, multisig: acc.multisig, publicKey: intent.newKey, transactionIndex: intent.transactionIndex, intentId: intent.id, intentHash: intent.intentHash, txSignature: sig });
    await this.audit({ type: "OLD_MEMBER_REMOVED", accountId: acc.id, multisig: acc.multisig, publicKey: intent.oldKey, transactionIndex: intent.transactionIndex, intentId: intent.id, intentHash: intent.intentHash, txSignature: sig });

    const now = this.now();
    const members = await this.store.listMembers(acc.id);
    const old = members.find((m) => m.publicKey === intent.oldKey);
    if (old) await this.store.saveMember({ ...old, status: "REVOKED", revokedAt: now });
    let deviceId: string | null = null;
    if (intent.role === "CLIENT") {
      deviceId = randomUUID();
      await this.store.saveDevice({ id: deviceId, userId: acc.userId, name: rot0.newDeviceName ?? "carteira nova", publicKey: intent.newKey, createdAt: now, revokedAt: null });
      if (old?.deviceId) {
        const dev = await this.store.getDevice(old.deviceId);
        if (dev) await this.store.saveDevice({ ...dev, revokedAt: now });
      }
    } else {
      await this.cfg.serverKeys.retire(intent.oldKey);
    }
    await this.store.saveMember({ accountId: acc.id, publicKey: intent.newKey, role: intent.role, permissions: intent.role === "CLIENT" ? CLIENT_MASK : SERVER_MASK, status: "ACTIVE", deviceId, createdAt: now, revokedAt: null });
    await this.store.saveAccount({ ...acc, roles, frozenBy: null });
    await force("COMPLETED");
    await this.audit({ type: "ROTATION_COMPLETED", accountId: acc.id, multisig: acc.multisig, publicKey: intent.newKey, intentId: intent.id, txSignature: sig, details: { rotationId: intent.rotationId, role: intent.role } });
  }

  // -------------------------------------------------------------------------
  // celular (Solana Pay "transaction request")
  //
  // O celular lê um QR, busca a transação aqui, assina e ENVIA ele mesmo,
  // pagando a taxa. O backend acha a transação na chain pela conta que ela
  // toca (multisig, transação da Squads ou a própria carteira) e compara os
  // bytes da mensagem com a preparada. Não há signMessage no Solana Pay:
  // entrada e prova da carteira nova são transações com um memo assinado.
  // -------------------------------------------------------------------------

  /**
   * Entrar pelo celular: se a carteira já tem conta, memo de entrada (custa a
   * taxa de uma assinatura); se não, o cadastro (memo + criação da multisig).
   */
  async phoneConnectTransaction(walletPublicKey: string, challenge: string) {
    const wallet = new PublicKey(walletPublicKey);
    const existing = await this.store.findAccountByClientKey(walletPublicKey);
    if (existing) {
      await this.requireFee(wallet, "WALLET_NO_SOL", "sua carteira precisa de 0,000005 SOL para a taxa de entrada");
      const memo = `Dupla Chave\nEntrar na sua conta. Isto não aprova nenhuma transação.\nDesafio: ${challenge}`;
      const built = await this.walletPaid(wallet, [this.memoIx(memo, wallet)]);
      return { kind: "LOGIN" as const, transaction: built.transaction, wire: built.message, enrollmentId: null, message: "Entrar na sua conta Dupla Chave. Isto não aprova nenhuma transação." };
    }
    const p = await this.prepareEnrollment({ publicKey: walletPublicKey, walletName: "Carteira do celular" });
    return { kind: "ENROLL" as const, transaction: p.transaction, wire: null, enrollmentId: p.enrollmentId, message: "Criar sua conta Dupla Chave: sua carteira + a chave do serviço (2 de 2). Custa ~0,003 SOL." };
  }

  /** Conclui a entrada/cadastro pelo celular depois que a transação confirmou. null = ainda não. */
  async phoneConnectComplete(req: Awaited<ReturnType<CustodyService["phoneConnectTransaction"]>>, walletPublicKey: string) {
    if (req.kind === "ENROLL") return this.completeEnrollmentFromChain(req.enrollmentId!);
    const landed = await this.findLanded(new PublicKey(walletPublicKey), [req.wire!]);
    if (!landed) return null;
    if (!landed.ok) deny("WALLET_TX_FAILED", landed.error ?? "a transação falhou");
    return { account: await this.accountOfWallet(walletPublicKey), created: false as const };
  }

  /** Transação atômica de uma intenção, para o celular assinar e enviar. */
  async phoneSignTransaction(intentId: string, walletPublicKey: string) {
    const req = await this.prepareIntent(intentId, walletPublicKey);
    const summary = renderIntent(req.intent);
    const what = req.intent.type === "ROTATE_MEMBER" ? summary.subtitle : summary.rows.slice(0, 2).map((r) => `${r.label} ${r.value}`).join(" · ");
    return { transaction: req.transaction, message: `Aprovar e executar: ${what}` };
  }

  async phoneSignComplete(intentId: string) {
    return this.completeIntentFromChain(intentId);
  }

  /** Prova de posse da carteira nova pelo celular: memo com o texto de posse, pago por ela. */
  async phoneRotationProofTransaction(rotationId: string, newWallet: string) {
    const rot = await this.store.getRotation(rotationId);
    if (!rot) deny("ROTATION_NOT_FOUND", rotationId);
    if (rot.role !== "CLIENT" || rot.status !== "REQUESTED") deny("ROTATION_BAD_STATE", rot.status);
    const acc = await this.account(rot.accountId);
    if (newWallet === acc.roles.client) deny("SAME_WALLET", "essa é a carteira atual; escolha outra conta na carteira");
    const wallet = new PublicKey(newWallet);
    await this.requireFee(wallet, "NEW_WALLET_NO_SOL", "a carteira nova precisa de 0,000005 SOL para a taxa da prova");
    const fields = { ...this.possessionFieldsFor(rot, acc.multisig), publicKey: newWallet };
    const built = await this.walletPaid(wallet, [this.memoIx(possessionMessage(fields), wallet)]);
    return { transaction: built.transaction, wire: built.message, fields, message: "Provar que esta carteira é sua para trocar a carteira da conta Dupla Chave." };
  }

  async phoneRotationProofComplete(rotationId: string, req: Awaited<ReturnType<CustodyService["phoneRotationProofTransaction"]>>) {
    const landed = await this.findLanded(new PublicKey(req.fields.publicKey), [req.wire]);
    if (!landed) return null;
    if (!landed.ok) deny("WALLET_TX_FAILED", landed.error ?? "a transação falhou");
    const idx = landed.signers.findIndex((k) => k.toBase58() === req.fields.publicKey);
    const proof: WalletProof = { ...req.fields, via: "transaction", transactionMessage: landed.message, signature: bs58.encode(landed.signatures[idx]!) };
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
      walletLamports: (await this.chain.getBalance(new PublicKey(acc.roles.client)).catch(() => 0n)).toString(),
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
