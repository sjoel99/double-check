import { hashCanonical, type Cluster, type MemberRole, type TransactionIntent } from "@duplachave/shared";
import type { ExpectedRoles } from "@duplachave/squads";
import type { UserPolicy } from "@duplachave/policy-engine";

export type UserRecord = { id: string; name: string; policy: UserPolicy; createdAt: number };

export type DeviceRecord = { id: string; userId: string; name: string; publicKey: string; createdAt: number; revokedAt: number | null };

export type SmartAccountRecord = {
  id: string;
  userId: string;
  cluster: Cluster;
  multisig: string;
  vault: string;
  /** Papéis esperados. Cache: toda decisão confere com a chain antes. */
  roles: ExpectedRoles;
  /** Rotação em andamento que congelou as operações, se houver. */
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

export type IntentStatus = "AWAITING_CLIENT" | "AWAITING_SERVER" | "EXECUTING" | "EXECUTED" | "REJECTED" | "EXPIRED" | "FAILED";

export type IntentRecord = {
  intent: TransactionIntent;
  accountId: string;
  transactionHash: string;
  status: IntentStatus;
  riskFlags: string[];
  reasons: string[];
  signatures: Partial<Record<"create" | "clientApprove" | "serverApprove" | "execute" | "reject", string>>;
  updatedAt: number;
};

export const ROTATION_STATUSES = [
  "REQUESTED",
  "NEW_KEY_VERIFIED",
  "OPERATIONS_FROZEN",
  "AWAITING_CLIENT_APPROVAL",
  "AWAITING_SERVER_APPROVAL",
  "EXECUTING",
  "VERIFIED",
  "COMPLETED",
  "REJECTED",
  "EXPIRED",
  "FAILED",
  "ROLLBACK_REQUIRED",
] as const;
export type RotationStatus = (typeof ROTATION_STATUSES)[number];

export type RotationRecord = {
  id: string;
  accountId: string;
  role: "CLIENT" | "SERVER";
  oldKey: string;
  newKey: string | null;
  newDeviceName: string | null;
  status: RotationStatus;
  challenge: string;
  createdAt: number;
  expiresAt: number;
  intentId: string | null;
  history: { status: RotationStatus; at: number; note?: string }[];
};

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
  | "TRANSACTION_REJECTED"
  | "TRANSACTION_EXPIRED"
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
  | "INVARIANT_VIOLATION";

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
  role: "CLIENT" | "SERVER";
  decision: "APPROVE" | "REJECT";
  /** Declaração assinada (só material público: dados + assinatura). */
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

export type SecurityEventRecord = {
  id: string;
  accountId: string | null;
  code: string;
  message: string;
  at: number;
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
  listAccounts(userId: string): Promise<SmartAccountRecord[]>;
  listAccountIds(): Promise<string[]>;
  /** Conta cuja CLIENT atual (esperada) é esta chave. */
  findAccountByClientKey(publicKey: string): Promise<SmartAccountRecord | null>;

  saveMember(m: MemberRecord): Promise<void>;
  listMembers(accountId: string): Promise<MemberRecord[]>;
  /** Chave que já foi revogada em qualquer conta. */
  isRevokedKey(publicKey: string): Promise<boolean>;

  saveIntent(r: IntentRecord): Promise<void>;
  getIntent(id: string): Promise<IntentRecord | null>;
  listIntents(accountId: string): Promise<IntentRecord[]>;

  saveRotation(r: RotationRecord): Promise<void>;
  getRotation(id: string): Promise<RotationRecord | null>;
  listRotations(accountId: string): Promise<RotationRecord[]>;

  /** Marca o nonce como usado. Devolve false se já tinha sido usado (replay). Atômico. */
  consumeNonce(scope: string, nonce: string, expiresAt: number): Promise<boolean>;

  appendAudit(e: AuditInput, at: number): Promise<AuditEvent>;
  listAudit(accountId?: string): Promise<AuditEvent[]>;
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
  private rotations = new Map<string, RotationRecord>();
  private nonces = new Map<string, number>();
  private audit: AuditEvent[] = [];

  async saveUser(u: UserRecord) { this.users.set(u.id, clone(u)); }
  async getUser(id: string) { const u = this.users.get(id); return u ? clone(u) : null; }
  async saveDevice(d: DeviceRecord) { this.devices.set(d.id, clone(d)); }
  async getDevice(id: string) { const d = this.devices.get(id); return d ? clone(d) : null; }
  async saveAccount(a: SmartAccountRecord) { this.accounts.set(a.id, clone(a)); }
  async getAccount(id: string) { const a = this.accounts.get(id); return a ? clone(a) : null; }
  async listAccounts(userId: string) { return [...this.accounts.values()].filter((a) => a.userId === userId).map(clone); }
  async listAccountIds() { return [...this.accounts.keys()]; }
  async findAccountByClientKey(publicKey: string) { const a = [...this.accounts.values()].find((x) => x.roles.client === publicKey); return a ? clone(a) : null; }

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

  async saveRotation(r: RotationRecord) { this.rotations.set(r.id, clone(r)); }
  async getRotation(id: string) { const r = this.rotations.get(id); return r ? clone(r) : null; }
  async listRotations(accountId: string) { return [...this.rotations.values()].filter((r) => r.accountId === accountId).map(clone); }

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
}

export type ChallengeRecord = {
  id: string;
  purpose: "ENROLL_CLIENT_KEY" | "AUTH";
  subject: string;
  challenge: string;
  expiresAt: number;
};

export interface ChallengeStore {
  putChallenge(c: ChallengeRecord): Promise<void>;
  /** Lê e apaga: um desafio serve uma vez. */
  takeChallenge(id: string): Promise<ChallengeRecord | null>;
}
