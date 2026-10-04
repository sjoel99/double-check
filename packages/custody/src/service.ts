import { createHash, randomUUID } from "node:crypto";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, VersionedMessage, VersionedTransaction } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { type Cluster, deny, type IntentBody, intentBody, SecurityError, sealIntent, type TransferSolIntent } from "@duplachave/shared";
import { loginMessage, randomHex, type Signer, verifyEd25519, verifyWalletMessage } from "@duplachave/crypto";
import { ChainTxError, type Chain, parseInstruction, programErrorFromLogs, type RawInstruction, SYSTEM_PROGRAM } from "@duplachave/solana";
import {
  assertAccountModel,
  configExecuteInstructions,
  configView,
  createStrictMultisigIx,
  type ExpectedRoles,
  OPERATOR_MASK,
  readMultisig,
  readProposal,
  rotationActions,
  type MultisigState,
  transactionPda,
  vaultPda,
  VOTER_MASK,
} from "@duplachave/squads";
import { DEFAULT_POLICY, type PolicyEngine, type User } from "@duplachave/policy-engine";
import {
  type AccountRoles,
  type ApprovalRequest,
  atomicInstructionsFor,
  compileAtomic,
  memoIx,
  securityChangeParties,
  type SecurityChangeDesc,
  type SecurityChangeRole,
  securityRequestInstructionsFor,
  vetoMessage,
  emailBindingMessage,
  emailInput,
} from "./client";
import type { ServerKeyProvider, ServiceKeys } from "./keys";
import type { NotificationService } from "./notifications";
import type { AuditInput, ChallengeStore, IntentRecord, PreparedEntry, SecurityChangeRecord, SecurityChangeStatus, SmartAccountRecord, Store, WebappKeyBlob, WebappKeyRecord } from "./store";
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

/** Prazo padrão das trocas de chave: 72 h. */
export const SECURITY_DELAY = 72 * 3600;

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
  /** Prazo entre o pedido de uma troca de chave e a execução (padrão 72 h). */
  securityDelay?: number;
  log?: (msg: string) => void;
};

/** Cadastro preparado: a carteira assina e paga a criação da multisig. */
type PendingEnrollment = {
  id: string;
  wallet: string;
  webapp: string;
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
  private readonly securityDelay: number;
  private locks = new Map<string, Promise<unknown>>();
  /** Cadastros preparados e ainda não confirmados. Duram minutos; em memória basta. */
  private enrollments = new Map<string, PendingEnrollment>();

  constructor(private readonly cfg: CustodyConfig) {
    this.chain = cfg.chain;
    this.store = cfg.store;
    this.now = cfg.now ?? (() => Math.floor(Date.now() / 1000));
    this.intentTtl = cfg.intentTtl ?? 10 * 60;
    this.securityDelay = cfg.securityDelay ?? SECURITY_DELAY;
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
      assertAccountModel(state, acc.roles);
    } catch (e) {
      await this.audit({ type: "INVARIANT_VIOLATION", accountId: acc.id, multisig: acc.multisig, details: { error: String(e) } });
      await this.store.saveSecurityEvent({ id: randomUUID(), accountId: acc.id, code: "INVARIANT_VIOLATION", message: String(e), at: this.now() });
      await this.cfg.notifications.event({ userId: acc.userId, accountId: acc.id }, { kind: "INVARIANT_VIOLATION", message: String(e) });
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
      // O blockhash vale ~1 minuto: a pessoa demorou na carteira. Nada entrou na chain.
      if (/BlockhashNotFound|block height exceeded/i.test(String((e as Error)?.message ?? e)))
        deny("TX_EXPIRED", "a transação venceu enquanto esperava a assinatura na carteira (ela vale cerca de 1 minuto). Nada saiu da sua conta; assine de novo.");
      if (e instanceof ChainTxError) deny("WALLET_TX_FAILED", e.programError ?? e.message);
      throw e;
    }
  }

  private intentExpiredText() {
    return `o prazo de ${Math.round(this.intentTtl / 60)} minutos para assinar este envio acabou. Nada saiu da sua conta; crie o envio de novo.`;
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

  /** A transação traz uma assinatura válida desta chave. */
  private requireSignature(tx: VersionedTransaction, key: string, code: string, msg: string) {
    const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
    const i = signers.findIndex((k) => k.toBase58() === key);
    if (i < 0 || !verifyEd25519(tx.message.serialize(), tx.signatures[i]!, new PublicKey(key))) deny(code, msg);
  }

  /** Papéis da conta como chaves públicas (o serviço sabe todos). */
  private rolesOf(acc: SmartAccountRecord): AccountRoles {
    return { client: new PublicKey(acc.roles.client), webapp: new PublicKey(acc.roles.webapp), server: new PublicKey(acc.roles.server), operator: new PublicKey(acc.roles.operator) };
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

  /**
   * Cadastro, passo 1: monta a criação da multisig 2 de 3 — a Phantom e a
   * chave do webapp (gerada no aparelho e cifrada pela biometria) votam, mais
   * uma chave nova do serviço; o operador do serviço cria e executa. Paga pela
   * Phantom. O memo é assinado pela Phantom E pela chave do webapp: prova de
   * posse das duas, na própria transação que cria a conta.
   */
  async prepareEnrollment(args: { publicKey: string; walletName: string; webappPublicKey: string }): Promise<PreparedEnrollment> {
    const wallet = new PublicKey(args.publicKey);
    const webapp = new PublicKey(args.webappPublicKey);
    if (wallet.equals(webapp)) deny("WEBAPP_IS_WALLET", "a chave do webapp não pode ser a carteira");
    for (const k of [args.publicKey, args.webappPublicKey]) {
      if (await this.store.isRevokedKey(k)) deny("KEY_REVOKED", "chave substituída não volta a valer");
      if (await this.cfg.serverKeys.get(k)) deny("CLIENT_KEY_IS_SERVER_KEY", "chave do servidor não pode ser do usuário");
    }
    if (await this.store.findAccountByClientKey(args.publicKey)) deny("WALLET_ALREADY_ENROLLED", "esta carteira já tem uma conta");
    await this.pruneEnrollments();

    const userId = randomUUID();
    const server = await this.cfg.serverKeys.create(`server:${userId}`);
    const operator = await this.cfg.service.operator.publicKey();
    const roles: ExpectedRoles = { client: args.publicKey, webapp: args.webappPublicKey, server: (await server.publicKey()).toBase58(), operator: operator.toBase58() };
    const createKey = randomCreateKey();
    const created = createStrictMultisigIx({
      createKey: await createKey.publicKey(),
      creator: wallet,
      treasury: this.cfg.squadsTreasury,
      layout: { client: wallet, webapp, server: new PublicKey(roles.server), operator },
      rentCollector: wallet,
    });
    const id = randomUUID();
    const memo = `Dupla Chave: criar sua conta 2 de 3 (sua carteira + a chave do webapp + o serviço). Ref ${id.slice(0, 8)}`;
    const instructions = [memoIx(memo, [wallet, webapp]), created.instruction];
    await this.simulateWalletPaid(wallet, instructions, "~0,003 SOL para criar a conta");
    const built = await this.walletPaid(wallet, instructions, [createKey]);
    const plan: EnrollmentPlan = { userId, roles, multisig: created.multisig.toBase58(), vault: created.vault.toBase58() };
    this.enrollments.set(id, { id, wallet: args.publicKey, webapp: args.webappPublicKey, walletName: args.walletName, plan, message: built.message, createdAt: this.now() });
    return { enrollmentId: id, transaction: built.transaction, multisig: plan.multisig, vault: plan.vault, memo };
  }

  /**
   * Cadastro, passo 2: a transação assinada pela chave do webapp e pela
   * Phantom, mais a chave do webapp cifrada (só o aparelho, com a biometria,
   * consegue abrir). Envia e grava a conta.
   */
  async submitEnrollment(enrollmentId: string, transactionB64: string, keyBlob: WebappKeyBlob & { deviceName: string }) {
    const p = this.enrollments.get(enrollmentId);
    if (!p) deny("ENROLLMENT_NOT_FOUND", "cadastro não existe ou expirou; comece de novo");
    const { tx } = this.parseSigned(transactionB64, [p.message], p.wallet);
    this.requireSignature(tx, p.webapp, "WEBAPP_BAD_SIGNATURE", "falta a assinatura da chave do webapp");
    if (!keyBlob?.credentialId || !keyBlob.ciphertext || !keyBlob.iv || !keyBlob.salt) deny("WEBAPP_KEY_MISSING", "falta a chave do webapp cifrada");
    const sig = await this.sendSigned(tx);
    return this.finishEnrollment(p, sig, keyBlob);
  }

  private async finishEnrollment(p: PendingEnrollment, sig: string, keyBlob: (WebappKeyBlob & { deviceName: string }) | null) {
    this.enrollments.delete(p.id);
    const { userId, roles } = p.plan;
    const now = this.now();
    await this.store.saveUser({ id: userId, name: p.walletName, policy: DEFAULT_POLICY, createdAt: now });
    const deviceId = randomUUID();
    await this.store.saveDevice({ id: deviceId, userId, name: p.walletName, publicKey: roles.client, createdAt: now, revokedAt: null });
    const acc: SmartAccountRecord = { id: randomUUID(), userId, cluster: this.cfg.cluster, multisig: p.plan.multisig, vault: p.plan.vault, roles, frozenBy: null, createdAt: now };
    await this.store.saveAccount(acc);
    await this.verifiedState(acc);
    const member = (publicKey: string, role: "CLIENT" | "WEBAPP" | "SERVER" | "OPERATOR", permissions: number, dev: string | null = null) =>
      this.store.saveMember({ accountId: acc.id, publicKey, role, permissions, status: "ACTIVE", deviceId: dev, createdAt: now, revokedAt: null });
    await member(roles.client, "CLIENT", VOTER_MASK, deviceId);
    await member(roles.webapp, "WEBAPP", VOTER_MASK);
    await member(roles.server, "SERVER", VOTER_MASK);
    await member(roles.operator, "OPERATOR", OPERATOR_MASK);
    if (keyBlob) {
      const { deviceName, ...blob } = keyBlob;
      await this.store.saveWebappKey({ accountId: acc.id, publicKey: roles.webapp, blob, deviceName, createdAt: now, revokedAt: null });
    }
    await this.audit({ type: "SMART_ACCOUNT_CREATED", accountId: acc.id, userId, deviceId, multisig: acc.multisig, txSignature: sig, publicKey: roles.client, details: { wallet: p.walletName, webapp: roles.webapp, paidBy: "wallet", model: "2-de-3" } });
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
            await this.finishEnrollment(p, landed.signature, null);
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

  /**
   * Entrada com a chave do webapp (destravada pela biometria), para quem perdeu
   * a Phantom e precisa pedir a troca dela. Também só identifica.
   */
  async loginWithWebapp(args: { challengeId: string; publicKey: string; signature: string }) {
    const ch = await this.store.takeChallenge(args.challengeId);
    if (!ch || ch.purpose !== "AUTH" || ch.subject !== args.publicKey || ch.expiresAt < this.now()) deny("CHALLENGE_INVALID", "desafio inválido");
    const text = loginMessage({ publicKey: args.publicKey, cluster: this.cfg.cluster, challenge: ch.challenge, expiresAt: ch.expiresAt });
    if (!verifyWalletMessage(text, args.signature, args.publicKey)) deny("BAD_SIGNATURE", "assinatura inválida");
    const acc = await this.store.findAccountByWebappKey(args.publicKey);
    if (!acc) deny("NOT_A_WEBAPP_KEY", "esta chave não é a chave do webapp de nenhuma conta");
    return acc;
  }

  /** Cópia cifrada da chave do webapp pela passkey (só texto cifrado; a passkey é quem abre). */
  async webappKeyByCredential(credentialId: string) {
    for (const id of await this.store.listAccountIds()) {
      const acc = await this.store.getAccount(id);
      const k = (await this.store.listWebappKeys(id)).find((x) => x.blob.credentialId === credentialId && !x.revokedAt && x.publicKey === acc?.roles.webapp);
      if (k && acc) return { accountId: acc.id, publicKey: k.publicKey, blob: k.blob, client: acc.roles.client, multisig: acc.multisig };
    }
    deny("WEBAPP_KEY_NOT_FOUND", "nenhuma conta com esta biometria");
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
        deny("INTENT_EXPIRED", this.intentExpiredText());
      }
      const state = await this.verifiedState(acc);
      const index = state.transactionIndex + 1n;
      let intent = rec.intent;
      if (intent.transactionIndex !== index.toString()) intent = sealIntent({ ...intentBody(intent), transactionIndex: index.toString() } as IntentBody);

      if (intent.type !== "TRANSFER_SOL") deny("UNSUPPORTED", `tipo ${intent.type} não é operação`);
      const riskFlags = await this.checkTransfer(acc, await this.user(acc.userId), intent);

      const roles = this.rolesOf(acc);
      const instructions = atomicInstructionsFor(intent, roles, state);
      await this.simulateWalletPaid(roles.client, instructions, "tenha ~0,007 SOL: o depósito das contas volta na mesma transação e o custo real é ~0,000015 SOL");
      // Sem assinatura nenhuma: o operador só assina depois da chave do webapp (authorizeIntent).
      const built = await this.walletPaid(roles.client, instructions);

      const now = this.now();
      const live = (rec.prepared ?? []).filter((e) => e.preparedAt > now - PREPARED_WINDOW);
      rec = { ...rec, intent, riskFlags, transactionHash: sha256(Buffer.from(built.message, "base64")), prepared: [...live, { index: index.toString(), message: built.message, preparedAt: now }], updatedAt: now };
      await this.store.saveIntent(rec);

      return { intent, riskFlags, transaction: built.transaction };
    });
  }

  /**
   * A chave do webapp assinou exatamente esta transação — e ela só abre com a
   * biometria do aparelho. O operador (o único executor) assina a criação e a
   * execução. Só para mensagens que o próprio serviço preparou, ainda válidas.
   * O voto do serviço NÃO entra em operações: só Phantom + webapp votam.
   */
  async authorizeIntent(intentId: string, args: { message: string; webappSignature: string }) {
    const first = await this.intentRecord(intentId);
    return this.withLock(first.accountId, async () => {
      const rec = await this.intentRecord(intentId);
      const acc = await this.account(rec.accountId);
      if (rec.status !== "AWAITING_CLIENT") deny("INTENT_NOT_PENDING", `intenção em ${rec.status}`);
      if (this.now() > rec.intent.expiresAt) deny("INTENT_EXPIRED", this.intentExpiredText());
      const now = this.now();
      const entries = rec.prepared ?? [];
      const entry = entries.find((e) => e.message === args.message);
      if (!entry) deny("TX_NOT_EXPECTED", "esta transação não foi preparada pelo serviço");
      if (entry.preparedAt <= now - PREPARED_WINDOW) deny("PREPARED_EXPIRED", "a transação preparada venceu; prepare de novo");
      const tx = new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(args.message, "base64")));
      const webappSig = decodeSignature(args.webappSignature);
      if (!verifyEd25519(tx.message.serialize(), webappSig, new PublicKey(acc.roles.webapp))) deny("WEBAPP_BAD_SIGNATURE", "a assinatura não é da chave do webapp desta conta");
      tx.addSignature(new PublicKey(acc.roles.webapp), webappSig);
      tx.addSignature(await this.cfg.service.operator.publicKey(), await this.cfg.service.operator.sign(tx.message.serialize()));
      await this.store.saveIntent({ ...rec, prepared: entries.map((e) => (e === entry ? { ...e, authorizedAt: now } : e)), updatedAt: now });
      await this.audit({ type: "SERVER_APPROVED", accountId: acc.id, publicKey: acc.roles.operator, multisig: acc.multisig, transactionIndex: entry.index, intentId, intentHash: rec.intent.intentHash, details: { by: "operator", webapp: acc.roles.webapp, riskFlags: rec.riskFlags } });
      return { transaction: b64(tx.serialize()) };
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
    // Só as que o serviço assinou podem ter entrado.
    const entries = (rec.prepared ?? []).filter((e) => e.authorizedAt);
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
    for (const [role, publicKey] of [["WEBAPP", acc.roles.webapp], ["CLIENT", acc.roles.client]] as const)
      await this.store.saveApproval({ id: randomUUID(), intentId: intent.id, accountId: acc.id, publicKey, role, decision: "APPROVE", statement: { atomic: true }, txSignature: txid, createdAt: now });
    const common = { accountId: acc.id, multisig: acc.multisig, transactionIndex: entry.index, intentId: intent.id, intentHash: intent.intentHash, txSignature: txid };
    await this.audit({ type: "CLIENT_APPROVED", publicKey: acc.roles.client, ...common });
    await this.audit({ type: "TRANSACTION_EXECUTED", ...common, details: { atomic: true, paidBy: "wallet", late } });
    if (intent.type === "TRANSFER_SOL")
      await this.cfg.notifications.event({ userId: acc.userId, accountId: acc.id }, { kind: "TRANSFER_EXECUTED", amountLamports: intent.amountLamports, destination: intent.destination, signature: txid });
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
    return (rec.prepared ?? []).some((e) => e.authorizedAt && e.preparedAt > this.now() - PREPARED_WINDOW);
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
      return out;
    });
  }

  private async expireIntent(rec: IntentRecord) {
    const out: IntentRecord = { ...rec, status: "EXPIRED", updatedAt: this.now() };
    await this.store.saveIntent(out);
    await this.audit({ type: "TRANSACTION_EXPIRED", accountId: rec.accountId, multisig: rec.intent.multisig, intentId: rec.intent.id, intentHash: rec.intent.intentHash });
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
      // Pedido de troca preparado e não enviado: depois da janela, não entra mais.
      for (const c of await this.store.listSecurityChanges(accountId)) {
        if (c.status === "PREPARED" && (c.prepared ?? []).every((e) => e.preparedAt <= now - PREPARED_WINDOW)) await this.setChange(c, "FAILED", "pedido não foi assinado a tempo");
      }
    });
  }

  // -------------------------------------------------------------------------
  // troca de votante em dois passos: pedido agora (dois votos na chain), execução
  // pelo operador só depois do prazo. "Não fui eu" para tudo antes disso.
  // -------------------------------------------------------------------------

  private async setChange(c: SecurityChangeRecord, status: SecurityChangeStatus, note?: string, patch: Partial<SecurityChangeRecord> = {}) {
    const next: SecurityChangeRecord = { ...c, ...patch, status, history: [...c.history, { status, at: this.now(), note }] };
    await this.store.saveSecurityChange(next);
    return next;
  }

  private async changeRecord(id: string) {
    const c = await this.store.getSecurityChange(id);
    if (!c) deny("CHANGE_NOT_FOUND", id);
    return c;
  }

  changeDesc(c: SecurityChangeRecord, acc: SmartAccountRecord): SecurityChangeDesc {
    return { id: c.id, role: c.role, oldKey: c.oldKey, newKey: c.newKey, multisig: acc.multisig, index: c.index!, cluster: this.cfg.cluster, delaySeconds: this.securityDelay };
  }

  /**
   * Pede uma troca:
   * - CLIENT (trocar a Phantom): webapp + serviço votam; a Phantom nova paga;
   * - WEBAPP (recuperar o webapp, ex. perdeu o aparelho): Phantom + serviço votam;
   *   a chave nova vem cifrada para a biometria do aparelho novo;
   * - SERVER (chave do serviço): o serviço gera a nova; Phantom + serviço votam.
   * Uma troca aberta por vez.
   */
  async requestSecurityChange(accountId: string, args: { role: SecurityChangeRole; newKey?: string; newKeyBlob?: (WebappKeyBlob & { deviceName: string }) | null }) {
    return this.withLock(accountId, async () => {
      const acc = await this.account(accountId);
      const state = await this.verifiedState(acc);
      const open = (await this.store.listSecurityChanges(accountId)).find((c) => c.status === "PENDING" || (c.status === "PREPARED" && (c.prepared ?? []).some((e) => e.preparedAt > this.now() - PREPARED_WINDOW)));
      if (open) deny("CHANGE_IN_PROGRESS", "já existe uma troca de chave em andamento");
      let newKey = args.newKey;
      if (args.role === "SERVER") newKey = (await (await this.cfg.serverKeys.create(`server:${acc.userId}:troca:${randomUUID()}`)).publicKey()).toBase58();
      if (!newKey) deny("NEW_KEY_MISSING", "falta a chave nova");
      new PublicKey(newKey);
      if (state.members.some((m) => m.key === newKey)) deny("KEY_ALREADY_MEMBER", "essa chave já é membro");
      if (await this.store.isRevokedKey(newKey)) deny("REVOKED_KEY_REUSE", "chave revogada não volta");
      if (args.role !== "SERVER" && (await this.cfg.serverKeys.get(newKey))) deny("CLIENT_KEY_IS_SERVER_KEY", "chave do servidor não pode ser do usuário");
      if (args.role === "WEBAPP" && !args.newKeyBlob?.ciphertext) deny("WEBAPP_KEY_MISSING", "falta a chave nova do webapp cifrada");

      const oldKey = args.role === "CLIENT" ? acc.roles.client : args.role === "WEBAPP" ? acc.roles.webapp : acc.roles.server;
      const now = this.now();
      const id = randomUUID();
      // A política confere a troca como uma intenção de rotação: só [Add(nova, Vote), Remove(atual)(, SetRentCollector)].
      const view = configView(rotationActions(new PublicKey(oldKey), new PublicKey(newKey), args.role), state, acc.roles);
      const asIntent = sealIntent({
        version: 1, id, cluster: this.cfg.cluster, multisig: acc.multisig, transactionIndex: (state.transactionIndex + 1n).toString(),
        createdAt: now, expiresAt: now + 600, kind: "CONFIG", type: "ROTATE_MEMBER", role: args.role, oldKey, newKey, rotationId: id,
      } as IntentBody);
      const decision = await this.cfg.policy.validate(await this.user(acc.userId), asIntent, view, { vaultLamports: 0n, verifiedNewKeys: [newKey], revokedKeys: [] });
      if (decision.reasons.length) deny("POLICY_DENIED", decision.reasons.join("; "));

      const c: SecurityChangeRecord = {
        id,
        accountId,
        role: args.role,
        oldKey,
        newKey,
        status: "PREPARED",
        index: (state.transactionIndex + 1n).toString(),
        createdAt: now,
        executeAfter: null,
        prepared: null,
        newKeyBlob: args.role === "WEBAPP" ? args.newKeyBlob! : null,
        signatures: {},
        history: [{ status: "PREPARED", at: now }],
      };
      const roles = this.rolesOf(acc);
      const desc = this.changeDesc(c, acc);
      const { payer } = securityChangeParties(c.role, roles, new PublicKey(newKey));
      const instructions = securityRequestInstructionsFor(desc, roles);
      await this.simulateWalletPaid(payer, instructions, "a carteira que paga precisa de ~0,006 SOL (volta quando a troca executar)");
      const built = await this.walletPaid(payer, instructions);
      c.prepared = [{ index: c.index!, message: built.message, preparedAt: now }];
      await this.store.saveSecurityChange(c);
      return { change: c, desc, transaction: built.transaction };
    });
  }

  /**
   * O serviço assina o pedido: voto do serviço + criação pelo operador (+ o memo,
   * quando a chave nova é do serviço). Na troca da Phantom, só depois de a chave
   * do webapp (biometria) ter assinado — é ela o outro voto.
   */
  async authorizeSecurityRequest(changeId: string, args: { message: string; webappSignature?: string }) {
    const c0 = await this.changeRecord(changeId);
    return this.withLock(c0.accountId, async () => {
      const c = await this.changeRecord(changeId);
      const acc = await this.account(c.accountId);
      if (c.status !== "PREPARED") deny("CHANGE_NOT_PREPARED", `troca em ${c.status}`);
      const entry = (c.prepared ?? []).find((e) => e.message === args.message);
      if (!entry) deny("TX_NOT_EXPECTED", "esta transação não foi preparada pelo serviço");
      if (entry.preparedAt <= this.now() - PREPARED_WINDOW) deny("PREPARED_EXPIRED", "o pedido venceu; peça de novo");
      const tx = new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(args.message, "base64")));
      if (c.role === "CLIENT") {
        if (!args.webappSignature) deny("WEBAPP_SIGNATURE_MISSING", "trocar a carteira exige a chave do webapp (biometria)");
        const sig = decodeSignature(args.webappSignature);
        if (!verifyEd25519(tx.message.serialize(), sig, new PublicKey(acc.roles.webapp))) deny("WEBAPP_BAD_SIGNATURE", "a assinatura não é da chave do webapp desta conta");
        tx.addSignature(new PublicKey(acc.roles.webapp), sig);
      }
      const server = await this.serverSigner(acc);
      const signers: Signer[] = [this.cfg.service.operator, server];
      if (c.role === "SERVER") {
        const fresh = await this.cfg.serverKeys.get(c.newKey);
        if (!fresh) deny("SERVER_KEY_UNAVAILABLE", "chave nova do serviço indisponível");
        signers.push(fresh);
      }
      for (const s of signers) tx.addSignature(await s.publicKey(), await s.sign(tx.message.serialize()));
      return { transaction: b64(tx.serialize()) };
    });
  }

  /** O pedido assinado (pela carteira que paga) entra na chain: começa o prazo. */
  async submitSecurityRequest(changeId: string, transactionB64: string) {
    const c0 = await this.changeRecord(changeId);
    return this.withLock(c0.accountId, async () => {
      const c = await this.changeRecord(changeId);
      const acc = await this.account(c.accountId);
      if (c.status !== "PREPARED") deny("CHANGE_NOT_PREPARED", `troca em ${c.status}`);
      const { payer } = securityChangeParties(c.role, this.rolesOf(acc), new PublicKey(c.newKey));
      const { tx } = this.parseSigned(transactionB64, (c.prepared ?? []).map((e) => e.message), payer.toBase58());
      const sig = await this.sendSigned(tx);
      const p = await readProposal(this.chain, new PublicKey(acc.multisig), BigInt(c.index!));
      if (p?.status !== "Approved") deny("CHANGE_NOT_APPROVED", `pedido na chain em ${p?.status ?? "inexistente"}`);
      const executeAfter = this.now() + this.securityDelay;
      const out = await this.setChange(c, "PENDING", undefined, { executeAfter, prepared: null, signatures: { ...c.signatures, request: sig } });
      await this.audit({ type: "SECURITY_CHANGE_REQUESTED", accountId: acc.id, multisig: acc.multisig, transactionIndex: c.index, txSignature: sig, publicKey: c.newKey, details: { changeId: c.id, role: c.role, oldKey: c.oldKey, executeAfter } });
      await this.cfg.notifications.event({ userId: acc.userId, accountId: acc.id }, { kind: "CHANGE_REQUESTED", changeId: c.id, role: c.role, newKey: c.newKey, executeAfter });
      return out;
    });
  }

  /**
   * "Não fui eu": quem ainda tem a chave que estaria sendo trocada prova isso
   * assinando o veto — então ela não está perdida e a troca morre. Na chave do
   * serviço, qualquer votante do usuário veta. Como só o operador executa, o
   * veto vale na hora (e a proposta aprovada fica stale na próxima troca).
   */
  async vetoSecurityChange(changeId: string, args: { publicKey: string; signature: string }) {
    const c0 = await this.changeRecord(changeId);
    return this.withLock(c0.accountId, async () => {
      const c = await this.changeRecord(changeId);
      const acc = await this.account(c.accountId);
      if (c.status !== "PENDING" && c.status !== "PREPARED") deny("CHANGE_NOT_OPEN", `troca em ${c.status}`);
      const allowed = c.role === "SERVER" ? [acc.roles.client, acc.roles.webapp] : [c.oldKey];
      if (!allowed.includes(args.publicKey)) deny("VETO_NOT_ALLOWED", c.role === "CLIENT" ? "só a carteira atual veta a troca dela" : c.role === "WEBAPP" ? "só a chave atual do webapp veta a troca dela" : "só uma chave do usuário veta");
      const text = vetoMessage({ id: c.id, multisig: acc.multisig, role: c.role, newKey: c.newKey });
      if (!verifyEd25519(utf8(text), decodeSignature(args.signature), new PublicKey(args.publicKey))) deny("BAD_SIGNATURE", "veto não assinado por essa chave");
      const out = await this.setChange(c, "VETOED", `vetada por ${args.publicKey}`);
      if (c.role === "SERVER") await this.cfg.serverKeys.retire(c.newKey);
      await this.audit({ type: "SECURITY_CHANGE_VETOED", accountId: acc.id, multisig: acc.multisig, transactionIndex: c.index, publicKey: args.publicKey, details: { changeId: c.id, role: c.role, newKey: c.newKey } });
      await this.cfg.notifications.event({ userId: acc.userId, accountId: acc.id }, { kind: "CHANGE_VETOED", changeId: c.id, role: c.role, newKey: c.newKey });
      return out;
    });
  }

  /** Passado o prazo: o operador assina a execução; quem paga assina por último. */
  async prepareSecurityExecute(changeId: string) {
    const c0 = await this.changeRecord(changeId);
    return this.withLock(c0.accountId, async () => {
      const c = await this.changeRecord(changeId);
      const acc = await this.account(c.accountId);
      if (c.status !== "PENDING") deny("CHANGE_NOT_PENDING", `troca em ${c.status}`);
      if (this.now() < c.executeAfter!) deny("CHANGE_NOT_DUE", `a troca só pode executar a partir de ${new Date(c.executeAfter! * 1000).toISOString()}`);
      const ms = new PublicKey(acc.multisig);
      const p = await readProposal(this.chain, ms, BigInt(c.index!));
      if (p?.status !== "Approved") {
        await this.setChange(c, "FAILED", `pedido na chain em ${p?.status ?? "inexistente"}`);
        deny("CHANGE_NOT_APPROVED", "o pedido não está mais aprovado na chain");
      }
      const state = await readMultisig(this.chain, ms);
      const payer = c.role === "CLIENT" ? new PublicKey(c.newKey) : new PublicKey(acc.roles.client);
      // O rent volta para a Phantom (na troca dela, para a nova: SetRentCollector roda antes do fechamento).
      const rentCollector = c.role === "CLIENT" ? new PublicKey(c.newKey) : state.rentCollector === acc.roles.client ? new PublicKey(acc.roles.client) : null;
      const instructions = configExecuteInstructions({ multisig: ms, index: BigInt(c.index!), operator: await this.cfg.service.operator.publicKey(), payer, rentCollector });
      const built = await this.walletPaid(payer, instructions, [this.cfg.service.operator]);
      await this.store.saveSecurityChange({ ...c, prepared: [{ index: c.index!, message: built.message, preparedAt: this.now() }] });
      return { transaction: built.transaction, payer: payer.toBase58() };
    });
  }

  async submitSecurityExecute(changeId: string, transactionB64: string) {
    const c0 = await this.changeRecord(changeId);
    return this.withLock(c0.accountId, async () => {
      const c = await this.changeRecord(changeId);
      const acc = await this.account(c.accountId);
      if (c.status !== "PENDING") deny("CHANGE_NOT_PENDING", `troca em ${c.status}`);
      const payer = c.role === "CLIENT" ? c.newKey : acc.roles.client;
      const { tx } = this.parseSigned(transactionB64, (c.prepared ?? []).map((e) => e.message), payer);
      const sig = await this.sendSigned(tx);
      return this.finalizeSecurityChange(acc, c, sig);
    });
  }

  /** A troca executou: confere o 2 de 3 com a chave nova na chain e atualiza os registros. */
  private async finalizeSecurityChange(acc: SmartAccountRecord, c: SecurityChangeRecord, sig: string) {
    const key = c.role === "CLIENT" ? "client" : c.role === "WEBAPP" ? "webapp" : "server";
    const roles: ExpectedRoles = { ...acc.roles, [key]: c.newKey };
    const state = await readMultisig(this.chain, new PublicKey(acc.multisig));
    try {
      assertAccountModel(state, roles);
    } catch (e) {
      await this.setChange(c, "FAILED", String(e));
      await this.audit({ type: "INVARIANT_VIOLATION", accountId: acc.id, multisig: acc.multisig, details: { error: String(e) } });
      throw e;
    }
    const now = this.now();
    const members = await this.store.listMembers(acc.id);
    const old = members.find((m) => m.publicKey === c.oldKey);
    if (old) await this.store.saveMember({ ...old, status: "REVOKED", revokedAt: now });
    let deviceId: string | null = null;
    if (c.role === "CLIENT") {
      deviceId = randomUUID();
      await this.store.saveDevice({ id: deviceId, userId: acc.userId, name: "Carteira nova", publicKey: c.newKey, createdAt: now, revokedAt: null });
      if (old?.deviceId) {
        const dev = await this.store.getDevice(old.deviceId);
        if (dev) await this.store.saveDevice({ ...dev, revokedAt: now });
      }
    } else if (c.role === "WEBAPP") {
      for (const k of await this.store.listWebappKeys(acc.id)) if (k.publicKey === c.oldKey && !k.revokedAt) await this.store.saveWebappKey({ ...k, revokedAt: now });
      if (c.newKeyBlob) {
        const { deviceName, ...blob } = c.newKeyBlob;
        await this.store.saveWebappKey({ accountId: acc.id, publicKey: c.newKey, blob, deviceName, createdAt: now, revokedAt: null });
      }
    } else {
      await this.cfg.serverKeys.retire(c.oldKey);
    }
    await this.store.saveMember({ accountId: acc.id, publicKey: c.newKey, role: c.role, permissions: VOTER_MASK, status: "ACTIVE", deviceId, createdAt: now, revokedAt: null });
    await this.store.saveAccount({ ...acc, roles, frozenBy: null });
    const out = await this.setChange(c, "EXECUTED", undefined, { prepared: null, signatures: { ...c.signatures, execute: sig } });
    await this.audit({ type: "SECURITY_CHANGE_EXECUTED", accountId: acc.id, multisig: acc.multisig, transactionIndex: c.index, txSignature: sig, publicKey: c.newKey, details: { changeId: c.id, role: c.role, oldKey: c.oldKey } });
    await this.cfg.notifications.event({ userId: acc.userId, accountId: acc.id }, { kind: "CHANGE_EXECUTED", changeId: c.id, role: c.role, newKey: c.newKey });
    return out;
  }

  async listSecurityChanges(accountId: string) {
    return this.store.listSecurityChanges(accountId);
  }

  async listSecurityChangesById(id: string) {
    return this.store.getSecurityChange(id);
  }

  get securityDelaySeconds() {
    return this.securityDelay;
  }

  // -------------------------------------------------------------------------
  // chave do webapp cifrada (o serviço só guarda o texto cifrado)
  // -------------------------------------------------------------------------

  /** As cópias cifradas da chave atual do webapp (uma por passkey/aparelho). */
  async webappKeys(accountId: string): Promise<WebappKeyRecord[]> {
    const acc = await this.account(accountId);
    return (await this.store.listWebappKeys(accountId)).filter((k) => k.publicKey === acc.roles.webapp && !k.revokedAt);
  }

  /**
   * Mais uma cópia da chave do webapp, cifrada para outra passkey: só quem já
   * abriu a chave (com a biometria) consegue assinar este pedido.
   */
  async addWebappKeyCopy(accountId: string, args: { blob: WebappKeyBlob; deviceName: string; signature: string }) {
    const acc = await this.account(accountId);
    const text = webappCopyMessage(acc.multisig, args.blob.credentialId);
    if (!verifyEd25519(utf8(text), decodeSignature(args.signature), new PublicKey(acc.roles.webapp))) deny("WEBAPP_BAD_SIGNATURE", "a cópia não foi assinada pela chave do webapp");
    await this.store.saveWebappKey({ accountId, publicKey: acc.roles.webapp, blob: args.blob, deviceName: args.deviceName, createdAt: this.now(), revokedAt: null });
    await this.audit({ type: "PASSKEY_ADDED", accountId, publicKey: acc.roles.webapp, details: { device: args.deviceName } });
  }

  // -------------------------------------------------------------------------
  // e-mail de alerta
  // -------------------------------------------------------------------------

  /**
   * Cadastrar/trocar o e-mail de alerta, passo 1. Exige a assinatura da chave
   * do webapp (biometria): quem só tem a seed da Phantom — e por isso uma
   * sessão — não consegue desviar os alertas. Manda um código ao endereço novo.
   */
  async startEmailChange(accountId: string, args: { email: string; signature: string }) {
    const acc = await this.account(accountId);
    const email = normalizeEmail(args.email);
    const text = emailBindingMessage(acc.multisig, email);
    if (!verifyEd25519(utf8(text), decodeSignature(args.signature), new PublicKey(acc.roles.webapp))) deny("WEBAPP_BAD_SIGNATURE", "o e-mail não foi confirmado pela chave do webapp");
    const id = randomUUID();
    const code = sixDigitCode();
    const expiresAt = this.now() + EMAIL_CODE_TTL;
    await this.store.putChallenge({ id, purpose: "EMAIL_VERIFY", subject: `${accountId}:${email}`, challenge: emailCodeHash(id, code), expiresAt });
    await this.cfg.notifications.sendCode(email, code);
    return { challengeId: id, email, expiresAt };
  }

  /** Passo 2: o código que chegou no endereço novo. Uma tentativa por código. */
  async confirmEmailChange(accountId: string, args: { challengeId: string; code: string }) {
    const acc = await this.account(accountId);
    const ch = await this.store.takeChallenge(args.challengeId);
    if (!ch || ch.purpose !== "EMAIL_VERIFY" || !ch.subject.startsWith(`${accountId}:`) || ch.expiresAt < this.now()) deny("CHALLENGE_INVALID", "código vencido ou já usado; peça outro");
    if (ch.challenge !== emailCodeHash(ch.id, String(args.code).trim())) deny("EMAIL_CODE_WRONG", "código errado; peça outro");
    const email = ch.subject.slice(accountId.length + 1);
    const user = await this.store.getUser(acc.userId);
    if (!user) deny("USER_NOT_FOUND", acc.userId);
    const previous = user.email ?? null;
    await this.store.saveUser({ ...user, email, emailVerifiedAt: this.now() });
    await this.audit({ type: "ALERT_EMAIL_CHANGED", accountId, publicKey: acc.roles.webapp, details: { email: maskEmail(email), previous: previous && maskEmail(previous) } });
    // O endereço antigo também fica sabendo.
    await this.cfg.notifications.event({ userId: acc.userId, accountId }, { kind: "EMAIL_CHANGED", newEmail: maskEmail(email) }, { alsoTo: previous });
    return { email: maskEmail(email) };
  }

  /** E-mail confirmado do usuário (para o envio dos alertas). */
  async alertEmailOf(userId: string): Promise<string | null> {
    return (await this.store.getUser(userId))?.email ?? null;
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
      assertAccountModel(state, acc.roles);
    } catch (e) {
      invariantOk = false;
      invariantError = String(e);
    }
    return {
      account: acc,
      onchain: { ...state, transactionIndex: state.transactionIndex.toString(), staleTransactionIndex: state.staleTransactionIndex.toString() },
      mode: "2_DE_3_OPERADOR" as const,
      invariantOk,
      invariantError,
      vaultLamports: (await this.chain.getBalance(new PublicKey(acc.vault)).catch(() => 0n)).toString(),
      walletLamports: (await this.chain.getBalance(new PublicKey(acc.roles.client)).catch(() => 0n)).toString(),
      members: await this.store.listMembers(accountId),
      securityChanges: (await this.store.listSecurityChanges(accountId)).slice(0, 10).map(({ prepared: _p, newKeyBlob: _b, ...c }) => c),
      alertEmail: await this.store.getUser(acc.userId).then((u) => (u?.email ? maskEmail(u.email) : null)),
      webappDevices: (await this.store.listWebappKeys(accountId)).filter((k) => !k.revokedAt && k.publicKey === acc.roles.webapp).map((k) => ({ deviceName: k.deviceName, createdAt: k.createdAt })),
    };
  }
}

/** Texto que a chave do webapp assina para guardar mais uma cópia cifrada. */
export function webappCopyMessage(multisig: string, credentialId: string) {
  return `Dupla Chave: guardar a chave do webapp cifrada para outra biometria. Conta ${multisig}. Credencial ${credentialId}`;
}

const EMAIL_CODE_TTL = 600;

function normalizeEmail(raw: string) {
  const e = emailInput(String(raw ?? ""));
  if (e.length > 254 || !/^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/.test(e)) deny("EMAIL_INVALID", "e-mail inválido");
  return e;
}

export function maskEmail(e: string) {
  const [u, d] = e.split("@");
  return `${u!.slice(0, 1)}${"*".repeat(Math.max(2, u!.length - 1))}@${d}`;
}

/**
 * Código de 6 dígitos sem viés: 20 bits do CSPRNG, descarta >= 10^6 (~5%).
 * Só inteiros de 32 bits: com o LiteSVM carregado (testes), o resto de double
 * (`x % 1e6` com x > 2^31, e o randomInt do Node) volta NaN.
 */
function sixDigitCode(): string {
  for (;;) {
    const n = parseInt(randomHex(3), 16) >>> 4;
    if (n < 1_000_000) return String(n).padStart(6, "0");
  }
}

const emailCodeHash = (id: string, code: string) => createHash("sha256").update(`${id}:${code}`).digest("hex");

/** Assinatura em base64 ou base58. */
function decodeSignature(s: string): Uint8Array {
  // O alfabeto base58 também é base64 válido: tenta base58 primeiro (64 bytes), depois base64.
  if (typeof s !== "string") deny("BAD_SIGNATURE", "assinatura ausente");
  try {
    const b = bs58.decode(s);
    if (b.length === 64) return b;
  } catch {
    /* não é base58 */
  }
  const b = Buffer.from(s, "base64");
  if (b.length !== 64) deny("BAD_SIGNATURE", "assinatura com tamanho inválido");
  return new Uint8Array(b);
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
