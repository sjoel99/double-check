import { hashCanonical, type Cluster, type MemberRole, type TransactionIntent } from "@duplachave/shared";
import type { ExpectedRoles } from "@duplachave/squads";
import type { UserPolicy } from "@duplachave/policy-engine";

export type UserRecord = {
  id: string;
  name: string;
  policy: UserPolicy;
  createdAt: number;
  /** E-mail de alerta, só depois de confirmado (código + chave do webapp). */
  email?: string | null;
  emailVerifiedAt?: number | null;
};

export type DeviceRecord = { id: string; userId: string; name: string; publicKey: string; createdAt: number; revokedAt: number | null };

export type SmartAccountRecord = {
  id: string;
  userId: string;
  cluster: Cluster;
  multisig: string;
  vault: string;
  /** Papéis esperados. Cache: toda decisão confere com a chain antes. */
  roles: ExpectedRoles;
  /** Do modelo 2 de 2 (rotação que congelava as operações). Contas novas: sempre null. */
  frozenBy: string | null;
  createdAt: number;
};

export type MemberRecord = {
  accountId: string;
  publicKey: string;
  role: MemberRole;
  permissions: number;
  status: "ACTIVE" | "REVOKED";
  deviceId: string | null;
  createdAt: number;
  revokedAt: number | null;
};

/**
 * O fluxo atômico só usa AWAITING_CLIENT → EXECUTED | REJECTED | EXPIRED. Os
 * outros estados vêm do modelo 2 de 2 e só aparecem em linhas antigas do banco.
 */
export type IntentStatus =
  | "AWAITING_CLIENT"
  | "AWAITING_SERVER"
  | "EXECUTING"
  | "APPROVED_PENDING_EXECUTION"
  | "EXECUTED"
  | "CANCELLED"
  | "REJECTED"
  | "EXPIRED"
  | "FAILED";

export type IntentRecord = {
  intent: TransactionIntent;
  accountId: string;
  transactionHash: string;
  status: IntentStatus;
  riskFlags: string[];
  reasons: string[];
  signatures: Partial<Record<"create" | "clientApprove" | "serverApprove" | "execute" | "reject", string>>;
  updatedAt: number;
  /**
   * Transações atômicas preparadas que ainda podem entrar na chain: valem até
   * o blockhash expirar. `authorizedAt` marca as que o operador assinou. A
   * conciliação com a chain decide cada uma (entrou ou morreu).
   */
  prepared?: PreparedEntry[] | null;
};

/** Uma transação preparada: mensagem (base64) e o índice da multisig que ela usa. */
export type PreparedEntry = { index: string; message: string; preparedAt: number; authorizedAt?: number | null };

/** Inclui tipos do modelo 2 de 2, que só aparecem em eventos antigos da auditoria (encadeada: não se reescreve). */
export type AuditEventType =
  | "SMART_ACCOUNT_CREATED"
  | "TRANSACTION_PROPOSED"
  | "TRANSACTION_POLICY_DENIED"
  | "CLIENT_APPROVED"
  | "CLIENT_REJECTED"
  | "SERVER_APPROVED"
  | "SERVER_REJECTED"
  | "TRANSACTION_APPROVED"
  | "TRANSACTION_EXECUTED"
  | "ALERT_EMAIL_CHANGED"
  | "TRANSACTION_REJECTED"
  | "TRANSACTION_EXPIRED"
  | "TRANSACTION_CANCELLED"
  | "EXECUTION_FAILED"
  | "APPROVAL_REFUSED"
  | "CLIENT_KEY_ROTATION_REQUESTED"
  | "SERVER_KEY_ROTATION_REQUESTED"
  | "NEW_KEY_PROOF_VERIFIED"
  | "NEW_KEY_PROOF_REFUSED"
  | "OPERATIONS_FROZEN"
  | "OPERATIONS_UNFROZEN"
  | "PENDING_PROPOSAL_REJECTED"
  | "NEW_MEMBER_ADDED"
  | "OLD_MEMBER_REMOVED"
  | "ROTATION_COMPLETED"
  | "ROTATION_REJECTED"
  | "ROTATION_EXPIRED"
  | "ROTATION_FAILED"
  | "INVARIANT_VIOLATION"
  | "PASSKEY_ADDED"
  | "PASSKEY_PENDING"
  | "PASSKEY_REFUSED"
  | "SECURITY_CHANGE_REQUESTED"
  | "SECURITY_CHANGE_VETOED"
  | "SECURITY_CHANGE_EXECUTED";

export type AuditEvent = {
  seq: number;
  at: number;
  type: AuditEventType;
  accountId: string | null;
  userId: string | null;
  deviceId: string | null;
  publicKey: string | null;
  multisig: string | null;
  transactionIndex: string | null;
  proposal: string | null;
  intentId: string | null;
  intentHash: string | null;
  txSignature: string | null;
  details: Record<string, unknown>;
  /** Encadeamento: hash do evento anterior. Apagar ou editar um evento quebra a cadeia. */
  prevHash: string;
  hash: string;
};

export type AuditInput = Partial<Omit<AuditEvent, "seq" | "at" | "type" | "prevHash" | "hash">> & { type: AuditEventType };

export type ApprovalRecord = {
  id: string;
  intentId: string;
  accountId: string;
  publicKey: string;
  role: "CLIENT" | "WEBAPP" | "SERVER";
  decision: "APPROVE" | "REJECT" | "CANCEL";
  /** Evidência, só material público. No fluxo atômico: `{ atomic: true }` (o voto está na própria transação). */
  statement: unknown;
  txSignature: string | null;
  createdAt: number;
};

export type SquadsTransactionRecord = {
  accountId: string;
  multisig: string;
  transactionIndex: string;
  kind: "VAULT" | "CONFIG";
  address: string;
  hash: string;
  intentId: string;
  createSignature: string;
  createdAt: number;
};

/**
 * Chave do webapp cifrada para uma passkey (biometria) de um aparelho. O
 * serviço guarda só o texto cifrado: a chave AES sai da extensão PRF da
 * passkey, que só o aparelho (com a digital/rosto) calcula.
 */
export type WebappKeyBlob = { credentialId: string; salt: string; iv: string; ciphertext: string };
export type WebappKeyRecord = {
  accountId: string;
  /** Chave pública do webapp (membro da multisig). */
  publicKey: string;
  blob: WebappKeyBlob;
  deviceName: string;
  createdAt: number;
  revokedAt: number | null;
};

/**
 * Troca de um votante (Phantom, webapp ou serviço) em dois passos: o pedido
 * entra na chain aprovado por dois votantes; o operador (único executor) só
 * executa depois de `executeAfter`. "Não fui eu" (VETOED) para tudo.
 */
export type SecurityChangeStatus = "PREPARED" | "PENDING" | "EXECUTED" | "VETOED" | "FAILED";
export type SecurityChangeRecord = {
  id: string;
  accountId: string;
  role: "CLIENT" | "WEBAPP" | "SERVER";
  oldKey: string;
  newKey: string;
  status: SecurityChangeStatus;
  /** Índice da ConfigTransaction na multisig (fixado ao preparar o pedido). */
  index: string | null;
  createdAt: number;
  executeAfter: number | null;
  /** Transações preparadas (pedido ou execução) que ainda podem entrar. */
  prepared: PreparedEntry[] | null;
  /** Recuperação do webapp: a chave nova cifrada, ativada quando a troca executar. */
  newKeyBlob: (WebappKeyBlob & { deviceName: string }) | null;
  signatures: Partial<Record<"request" | "execute", string>>;
  history: { status: SecurityChangeStatus; at: number; note?: string }[];
};

export type SecurityEventRecord = {
  id: string;
  accountId: string | null;
  code: string;
  message: string;
  at: number;
};

/**
 * "Continuar no celular": o pedido que o QR do computador abre no celular.
 * `token` vai no link do QR; `poll` é o segredo separado com que o computador
 * acompanha (quem só viu o QR não lê o resultado, que no CONNECT traz a sessão).
 */
export type HandoffRecord = {
  token: string;
  poll: string;
  kind: "CONNECT" | "SIGN_INTENT";
  label: string;
  /** intentId (SIGN_INTENT) */
  subject: string | null;
  accountId: string | null;
  createdAt: number;
  expiresAt: number;
  status: "WAITING" | "DONE" | "FAILED" | "EXPIRED";
  error: string | null;
  result: Record<string, unknown> | null;
};

/** Plano de um cadastro preparado: o que a conta vai ser quando a carteira assinar. */
export type EnrollmentPlan = {
  userId: string;
  roles: ExpectedRoles;
  multisig: string;
  vault: string;
};

/**
 * Cadastro preparado e ainda não confirmado: a carteira assina e paga a criação
 * da multisig. Dura minutos, mas fica no banco para sobreviver a um restart da API.
 */
export type PendingEnrollmentRecord = {
  id: string;
  wallet: string;
  webapp: string;
  walletName: string;
  plan: EnrollmentPlan;
  message: string;
  createdAt: number;
};

export interface Store {
  saveApproval(a: ApprovalRecord): Promise<void>;
  listApprovals(intentId: string): Promise<ApprovalRecord[]>;
  saveSquadsTransaction(t: SquadsTransactionRecord): Promise<void>;
  saveSecurityEvent(e: SecurityEventRecord): Promise<void>;
  listSecurityEvents(accountId: string): Promise<SecurityEventRecord[]>;

  saveUser(u: UserRecord): Promise<void>;
  getUser(id: string): Promise<UserRecord | null>;

  saveDevice(d: DeviceRecord): Promise<void>;
  getDevice(id: string): Promise<DeviceRecord | null>;

  saveAccount(a: SmartAccountRecord): Promise<void>;
  getAccount(id: string): Promise<SmartAccountRecord | null>;
  listAccountIds(): Promise<string[]>;
  /** Conta cuja CLIENT atual (esperada) é esta chave. */
  findAccountByClientKey(publicKey: string): Promise<SmartAccountRecord | null>;
  /** Conta cuja chave do webapp atual (esperada) é esta. */
  findAccountByWebappKey(publicKey: string): Promise<SmartAccountRecord | null>;

  saveMember(m: MemberRecord): Promise<void>;
  listMembers(accountId: string): Promise<MemberRecord[]>;
  /** Chave que já foi revogada em qualquer conta. */
  isRevokedKey(publicKey: string): Promise<boolean>;

  saveIntent(r: IntentRecord): Promise<void>;
  getIntent(id: string): Promise<IntentRecord | null>;
  listIntents(accountId: string): Promise<IntentRecord[]>;

  saveWebappKey(k: WebappKeyRecord): Promise<void>;
  listWebappKeys(accountId: string): Promise<WebappKeyRecord[]>;
  /** A cópia cifrada (não revogada) da chave ATUAL do webapp guardada para esta passkey, com a conta. */
  findWebappKeyByCredential(credentialId: string): Promise<{ account: SmartAccountRecord; key: WebappKeyRecord } | null>;

  saveHandoff(h: HandoffRecord): Promise<void>;
  getHandoff(token: string): Promise<HandoffRecord | null>;
  getHandoffByPoll(poll: string): Promise<HandoffRecord | null>;
  /** Apaga os pedidos do QR vencidos antes de `before`. */
  purgeHandoffs(before: number): Promise<void>;

  savePendingEnrollment(p: PendingEnrollmentRecord): Promise<void>;
  getPendingEnrollment(id: string): Promise<PendingEnrollmentRecord | null>;
  deletePendingEnrollment(id: string): Promise<void>;
  listPendingEnrollments(): Promise<PendingEnrollmentRecord[]>;

  /** Contas com algo em aberto (intenção à espera da carteira; troca preparada ou pendente): só elas precisam da varredura. */
  listAccountIdsWithOpenWork(): Promise<string[]>;
  /** Lixo com prazo vencido: desafios, nonces, pedidos do QR (10 min depois) e cadastros preparados (1 h depois). */
  purgeExpired(now: number): Promise<void>;

  saveSecurityChange(c: SecurityChangeRecord): Promise<void>;
  getSecurityChange(id: string): Promise<SecurityChangeRecord | null>;
  listSecurityChanges(accountId: string): Promise<SecurityChangeRecord[]>;

  /** Marca o nonce como usado. Devolve false se já tinha sido usado (replay). Atômico. */
  consumeNonce(scope: string, nonce: string, expiresAt: number): Promise<boolean>;

  appendAudit(e: AuditInput, at: number): Promise<AuditEvent>;
  listAudit(accountId?: string): Promise<AuditEvent[]>;

  /**
   * Várias escritas que valem juntas ou não valem (ex.: usuário + conta +
   * membros + chave cifrada no fim do cadastro). `fn` escreve pelo store que
   * recebe; se lançar, nada fica. Dentro dela, chamar `transaction` de novo
   * só reaproveita a mesma.
   */
  transaction<T>(fn: (s: Store) => Promise<T>): Promise<T>;
}

export const AUDIT_GENESIS = "0".repeat(64);

export function auditHash(e: Omit<AuditEvent, "hash">): string {
  return hashCanonical({ ...e, details: e.details });
}

export function verifyAuditChain(events: AuditEvent[]): boolean {
  let prev = AUDIT_GENESIS;
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const { hash, ...rest } = e;
    if (e.prevHash !== prev || auditHash(rest) !== hash) return false;
    prev = hash;
  }
  return true;
}

const clone = <T>(v: T): T => structuredClone(v);

/** Store em memória (testes e demo sem banco). */
export class MemoryStore implements Store, ChallengeStore {
  private challenges = new Map<string, ChallengeRecord>();
  async putChallenge(c: ChallengeRecord) { this.challenges.set(c.id, clone(c)); }
  async takeChallenge(id: string) { const c = this.challenges.get(id) ?? null; this.challenges.delete(id); return c; }
  private approvals: ApprovalRecord[] = [];
  private squadsTxs: SquadsTransactionRecord[] = [];
  private secEvents: SecurityEventRecord[] = [];
  async saveApproval(a: ApprovalRecord) { this.approvals.push(clone(a)); }
  async listApprovals(intentId: string) { return this.approvals.filter((a) => a.intentId === intentId).map(clone); }
  async saveSquadsTransaction(t: SquadsTransactionRecord) { this.squadsTxs.push(clone(t)); }
  async saveSecurityEvent(e: SecurityEventRecord) { this.secEvents.push(clone(e)); }
  async listSecurityEvents(accountId: string) { return this.secEvents.filter((e) => e.accountId === accountId).map(clone); }
  private users = new Map<string, UserRecord>();
  private devices = new Map<string, DeviceRecord>();
  private accounts = new Map<string, SmartAccountRecord>();
  private members: MemberRecord[] = [];
  private intents = new Map<string, IntentRecord>();
  private nonces = new Map<string, number>();
  private audit: AuditEvent[] = [];

  async saveUser(u: UserRecord) { this.users.set(u.id, clone(u)); }
  async getUser(id: string) { const u = this.users.get(id); return u ? clone(u) : null; }
  async saveDevice(d: DeviceRecord) { this.devices.set(d.id, clone(d)); }
  async getDevice(id: string) { const d = this.devices.get(id); return d ? clone(d) : null; }
  async saveAccount(a: SmartAccountRecord) { this.accounts.set(a.id, clone(a)); }
  async getAccount(id: string) { const a = this.accounts.get(id); return a ? clone(a) : null; }
  async listAccountIds() { return [...this.accounts.keys()]; }
  async findAccountByClientKey(publicKey: string) { const a = [...this.accounts.values()].find((x) => x.roles.client === publicKey); return a ? clone(a) : null; }
  async findAccountByWebappKey(publicKey: string) { const a = [...this.accounts.values()].find((x) => x.roles.webapp === publicKey); return a ? clone(a) : null; }

  async saveMember(m: MemberRecord) {
    const i = this.members.findIndex((x) => x.accountId === m.accountId && x.publicKey === m.publicKey);
    if (i >= 0) {
      if (this.members[i]!.status === "REVOKED" && m.status !== "REVOKED") throw new Error("chave revogada não volta a ser ativa");
      this.members[i] = clone(m);
    } else this.members.push(clone(m));
  }
  async listMembers(accountId: string) { return this.members.filter((m) => m.accountId === accountId).map(clone); }
  async isRevokedKey(publicKey: string) { return this.members.some((m) => m.publicKey === publicKey && m.status === "REVOKED"); }

  async saveIntent(r: IntentRecord) { this.intents.set(r.intent.id, clone(r)); }
  async getIntent(id: string) { const r = this.intents.get(id); return r ? clone(r) : null; }
  async listIntents(accountId: string) { return [...this.intents.values()].filter((r) => r.accountId === accountId).map(clone); }

  private webappKeys: WebappKeyRecord[] = [];
  async saveWebappKey(k: WebappKeyRecord) {
    const i = this.webappKeys.findIndex((x) => x.accountId === k.accountId && x.blob.credentialId === k.blob.credentialId && x.publicKey === k.publicKey);
    if (i >= 0) this.webappKeys[i] = clone(k);
    else this.webappKeys.push(clone(k));
  }
  async listWebappKeys(accountId: string) { return this.webappKeys.filter((k) => k.accountId === accountId).map(clone); }
  async findWebappKeyByCredential(credentialId: string) {
    for (const k of this.webappKeys) {
      if (k.blob.credentialId !== credentialId || k.revokedAt) continue;
      const acc = this.accounts.get(k.accountId);
      if (acc && acc.roles.webapp === k.publicKey) return { account: clone(acc), key: clone(k) };
    }
    return null;
  }
  private handoffs = new Map<string, HandoffRecord>();
  async saveHandoff(h: HandoffRecord) { this.handoffs.set(h.token, clone(h)); }
  async getHandoff(token: string) { const h = this.handoffs.get(token); return h ? clone(h) : null; }
  async getHandoffByPoll(poll: string) { const h = [...this.handoffs.values()].find((x) => x.poll === poll); return h ? clone(h) : null; }
  async purgeHandoffs(before: number) { for (const [k, h] of this.handoffs) if (h.expiresAt < before) this.handoffs.delete(k); }
  private pendingEnrollments = new Map<string, PendingEnrollmentRecord>();
  async savePendingEnrollment(p: PendingEnrollmentRecord) { this.pendingEnrollments.set(p.id, clone(p)); }
  async getPendingEnrollment(id: string) { const p = this.pendingEnrollments.get(id); return p ? clone(p) : null; }
  async deletePendingEnrollment(id: string) { this.pendingEnrollments.delete(id); }
  async listPendingEnrollments() { return [...this.pendingEnrollments.values()].map(clone); }
  async listAccountIdsWithOpenWork() {
    const ids = new Set<string>();
    for (const r of this.intents.values()) if (r.status === "AWAITING_CLIENT") ids.add(r.accountId);
    for (const c of this.changes.values()) if (c.status === "PREPARED" || c.status === "PENDING") ids.add(c.accountId);
    return [...ids];
  }
  async purgeExpired(now: number) {
    for (const [id, c] of this.challenges) if (c.expiresAt < now) this.challenges.delete(id);
    for (const [k, exp] of this.nonces) if (exp < now) this.nonces.delete(k);
    await this.purgeHandoffs(now - 600);
    for (const [id, p] of this.pendingEnrollments) if (p.createdAt < now - 3600) this.pendingEnrollments.delete(id);
  }
  private changes = new Map<string, SecurityChangeRecord>();
  async saveSecurityChange(c: SecurityChangeRecord) { this.changes.set(c.id, clone(c)); }
  async getSecurityChange(id: string) { const c = this.changes.get(id); return c ? clone(c) : null; }
  async listSecurityChanges(accountId: string) { return [...this.changes.values()].filter((c) => c.accountId === accountId).sort((a, b) => b.createdAt - a.createdAt).map(clone); }

  async consumeNonce(scope: string, nonce: string, expiresAt: number) {
    const k = `${scope}:${nonce}`;
    if (this.nonces.has(k)) return false;
    this.nonces.set(k, expiresAt);
    return true;
  }

  async appendAudit(input: AuditInput, at: number) {
    const prev = this.audit[this.audit.length - 1];
    const base: Omit<AuditEvent, "hash"> = {
      seq: (prev?.seq ?? 0) + 1,
      at,
      type: input.type,
      accountId: input.accountId ?? null,
      userId: input.userId ?? null,
      deviceId: input.deviceId ?? null,
      publicKey: input.publicKey ?? null,
      multisig: input.multisig ?? null,
      transactionIndex: input.transactionIndex ?? null,
      proposal: input.proposal ?? null,
      intentId: input.intentId ?? null,
      intentHash: input.intentHash ?? null,
      txSignature: input.txSignature ?? null,
      details: input.details ?? {},
      prevHash: prev?.hash ?? AUDIT_GENESIS,
    };
    const ev = Object.freeze({ ...base, hash: auditHash(base) });
    this.audit.push(ev);
    return clone(ev);
  }
  async listAudit(accountId?: string) {
    return this.audit.filter((e) => !accountId || e.accountId === accountId).map(clone);
  }

  /** Em memória: tira uma foto de tudo e, se `fn` falhar, volta para ela. */
  async transaction<T>(fn: (s: Store) => Promise<T>): Promise<T> {
    const snapshot = clone({
      challenges: this.challenges, approvals: this.approvals, squadsTxs: this.squadsTxs, secEvents: this.secEvents, users: this.users, devices: this.devices,
      accounts: this.accounts, members: this.members, intents: this.intents, nonces: this.nonces, audit: this.audit, webappKeys: this.webappKeys, changes: this.changes,
      handoffs: this.handoffs, pendingEnrollments: this.pendingEnrollments,
    });
    try {
      return await fn(this);
    } catch (e) {
      Object.assign(this, snapshot);
      throw e;
    }
  }
}

export type ChallengeRecord = {
  id: string;
  purpose: "AUTH" | "EMAIL_VERIFY";
  subject: string;
  challenge: string;
  expiresAt: number;
};

export interface ChallengeStore {
  putChallenge(c: ChallengeRecord): Promise<void>;
  /** Lê e apaga: um desafio serve uma vez. */
  takeChallenge(id: string): Promise<ChallengeRecord | null>;
}
