import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  ApprovalRecord,
  AuditEvent,
  AuditInput,
  ChallengeRecord,
  PasskeyRecord,
  SecurityChangeRecord,
  WebappKeyRecord,
  ChallengeStore,
  DeviceRecord,
  IntentRecord,
  MemberRecord,
  RotationRecord,
  SecurityEventRecord,
  SmartAccountRecord,
  SquadsTransactionRecord,
  Store,
  UserRecord,
} from "@duplachave/custody";
import { AUDIT_GENESIS, auditHash } from "@duplachave/custody";

/** O mínimo comum entre `pg` e PGlite. */
export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
}

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

export async function migrate(db: Db) {
  await db.exec(readFileSync(`${MIGRATIONS_DIR}001_init.sql`, "utf8"));
}

/** PGlite: Postgres em processo (dev e testes). `dataDir` vazio = memória. */
export async function openPglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  return {
    query: (text, params) => pg.query(text, params) as never,
    exec: async (sql) => {
      await pg.exec(sql);
    },
    transaction: (fn) => pg.transaction((tx) => fn({ query: (t, p) => tx.query(t, p) as never })),
  };
}

/** Postgres de verdade (produção). */
export async function openPostgres(connectionString: string): Promise<Db> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString });
  return {
    query: (text, params) => pool.query(text, params as unknown[]) as never,
    exec: async (sql) => {
      await pool.query(sql);
    },
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn({ query: (t, p) => client.query(t, p as unknown[]) as never });
        await client.query("COMMIT");
        return out;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export class PgStore implements Store, ChallengeStore {
  constructor(private readonly db: Db) {}

  // users / devices -----------------------------------------------------------
  async saveUser(u: UserRecord) {
    await this.db.query(
      `INSERT INTO users (id, name, policy, created_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, policy = EXCLUDED.policy`,
      [u.id, u.name, JSON.stringify(u.policy, bigintReplacer), u.createdAt],
    );
  }
  async getUser(id: string) {
    const { rows } = await this.db.query<{ id: string; name: string; policy: unknown; created_at: string }>(`SELECT * FROM users WHERE id = $1`, [id]);
    const r = rows[0];
    return r ? { id: r.id, name: r.name, policy: reviveBigints(r.policy) as UserRecord["policy"], createdAt: Number(r.created_at) } : null;
  }
  async saveDevice(d: DeviceRecord) {
    await this.db.query(
      `INSERT INTO devices (id, user_id, name, public_key, created_at, revoked_at) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET revoked_at = EXCLUDED.revoked_at, name = EXCLUDED.name`,
      [d.id, d.userId, d.name, d.publicKey, d.createdAt, d.revokedAt],
    );
  }
  async getDevice(id: string) {
    const { rows } = await this.db.query<Record<string, unknown>>(`SELECT * FROM devices WHERE id = $1`, [id]);
    const r = rows[0];
    return r
      ? { id: r.id as string, userId: r.user_id as string, name: r.name as string, publicKey: r.public_key as string, createdAt: Number(r.created_at), revokedAt: n(r.revoked_at) }
      : null;
  }

  // accounts / members --------------------------------------------------------
  async saveAccount(a: SmartAccountRecord) {
    await this.db.query(
      `INSERT INTO smart_accounts (id, user_id, cluster, multisig, vault, roles, frozen_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET roles = EXCLUDED.roles, frozen_by = EXCLUDED.frozen_by`,
      [a.id, a.userId, a.cluster, a.multisig, a.vault, JSON.stringify(a.roles), a.frozenBy, a.createdAt],
    );
  }
  private account(r: Record<string, unknown>): SmartAccountRecord {
    return {
      id: r.id as string,
      userId: r.user_id as string,
      cluster: r.cluster as SmartAccountRecord["cluster"],
      multisig: r.multisig as string,
      vault: r.vault as string,
      roles: r.roles as SmartAccountRecord["roles"],
      frozenBy: (r.frozen_by as string | null) ?? null,
      createdAt: Number(r.created_at),
    };
  }
  async getAccount(id: string) {
    const { rows } = await this.db.query<Record<string, unknown>>(`SELECT * FROM smart_accounts WHERE id = $1`, [id]);
    return rows[0] ? this.account(rows[0]) : null;
  }
  async listAccounts(userId: string) {
    const { rows } = await this.db.query<Record<string, unknown>>(`SELECT * FROM smart_accounts WHERE user_id = $1 ORDER BY created_at`, [userId]);
    return rows.map((r) => this.account(r));
  }
  async listAccountIds() {
    const { rows } = await this.db.query<{ id: string }>(`SELECT id FROM smart_accounts`);
    return rows.map((r) => r.id);
  }
  async findAccountByClientKey(publicKey: string) {
    const { rows } = await this.db.query<Record<string, unknown>>(`SELECT * FROM smart_accounts WHERE roles->>'client' = $1 LIMIT 1`, [publicKey]);
    return rows[0] ? this.account(rows[0]) : null;
  }
  async findAccountByWebappKey(publicKey: string) {
    const { rows } = await this.db.query<Record<string, unknown>>(`SELECT * FROM smart_accounts WHERE roles->>'webapp' = $1 LIMIT 1`, [publicKey]);
    return rows[0] ? this.account(rows[0]) : null;
  }
  async saveMember(m: MemberRecord) {
    await this.db.query(
      `INSERT INTO members (account_id, public_key, role, permissions, status, device_id, created_at, revoked_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (account_id, public_key) DO UPDATE SET status = EXCLUDED.status, revoked_at = EXCLUDED.revoked_at, device_id = EXCLUDED.device_id`,
      [m.accountId, m.publicKey, m.role, m.permissions, m.status, m.deviceId, m.createdAt, m.revokedAt],
    );
  }
  async listMembers(accountId: string) {
    const { rows } = await this.db.query<Record<string, unknown>>(`SELECT * FROM members WHERE account_id = $1 ORDER BY created_at, role`, [accountId]);
    return rows.map((r) => ({
      accountId: r.account_id as string,
      publicKey: r.public_key as string,
      role: r.role as MemberRecord["role"],
      permissions: Number(r.permissions),
      status: r.status as MemberRecord["status"],
      deviceId: (r.device_id as string | null) ?? null,
      createdAt: Number(r.created_at),
      revokedAt: n(r.revoked_at),
    }));
  }
  async isRevokedKey(publicKey: string) {
    const { rows } = await this.db.query(`SELECT 1 FROM members WHERE public_key = $1 AND status = 'REVOKED' LIMIT 1`, [publicKey]);
    return rows.length > 0;
  }

  // intents -------------------------------------------------------------------
  async saveIntent(r: IntentRecord) {
    await this.db.query(
      `INSERT INTO transaction_intents (id, account_id, kind, type, transaction_index, intent, intent_hash, transaction_hash, status, risk_flags, reasons, signatures, updated_at, prepared)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO UPDATE SET intent = EXCLUDED.intent, intent_hash = EXCLUDED.intent_hash, transaction_index = EXCLUDED.transaction_index,
         transaction_hash = EXCLUDED.transaction_hash, status = EXCLUDED.status, risk_flags = EXCLUDED.risk_flags, reasons = EXCLUDED.reasons,
         signatures = EXCLUDED.signatures, updated_at = EXCLUDED.updated_at, prepared = EXCLUDED.prepared`,
      [
        r.intent.id, r.accountId, r.intent.kind, r.intent.type, r.intent.transactionIndex, JSON.stringify(r.intent), r.intent.intentHash,
        r.transactionHash, r.status, JSON.stringify(r.riskFlags), JSON.stringify(r.reasons), JSON.stringify(r.signatures), r.updatedAt,
        r.prepared ? JSON.stringify(r.prepared) : null,
      ],
    );
  }
  private intent(r: Record<string, unknown>): IntentRecord {
    return {
      intent: r.intent as IntentRecord["intent"],
      accountId: r.account_id as string,
      transactionHash: r.transaction_hash as string,
      status: r.status as IntentRecord["status"],
      riskFlags: r.risk_flags as string[],
      reasons: r.reasons as string[],
      signatures: r.signatures as IntentRecord["signatures"],
      updatedAt: Number(r.updated_at),
      prepared: (r.prepared as IntentRecord["prepared"]) ?? null,
    };
  }
  async getIntent(id: string) {
    const { rows } = await this.db.query<Record<string, unknown>>(`SELECT * FROM transaction_intents WHERE id = $1`, [id]);
    return rows[0] ? this.intent(rows[0]) : null;
  }
  async listIntents(accountId: string) {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM transaction_intents WHERE account_id = $1 ORDER BY updated_at DESC`,
      [accountId],
    );
    return rows.map((r) => this.intent(r));
  }

  // rotations -----------------------------------------------------------------
  async saveRotation(r: RotationRecord) {
    await this.db.query(
      `INSERT INTO key_rotations (id, account_id, role, old_key, new_key, new_device_name, status, challenge, created_at, expires_at, intent_id, possession, history)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO UPDATE SET new_key = EXCLUDED.new_key, status = EXCLUDED.status, intent_id = EXCLUDED.intent_id, possession = EXCLUDED.possession, history = EXCLUDED.history`,
      [r.id, r.accountId, r.role, r.oldKey, r.newKey, r.newDeviceName, r.status, r.challenge, r.createdAt, r.expiresAt, r.intentId, r.possession === null ? null : JSON.stringify(r.possession), JSON.stringify(r.history)],
    );
  }
  private rotation(r: Record<string, unknown>): RotationRecord {
    return {
      id: r.id as string,
      accountId: r.account_id as string,
      role: r.role as RotationRecord["role"],
      oldKey: r.old_key as string,
      newKey: (r.new_key as string | null) ?? null,
      newDeviceName: (r.new_device_name as string | null) ?? null,
      status: r.status as RotationRecord["status"],
      challenge: r.challenge as string,
      createdAt: Number(r.created_at),
      expiresAt: Number(r.expires_at),
      intentId: (r.intent_id as string | null) ?? null,
      possession: r.possession ?? null,
      history: r.history as RotationRecord["history"],
    };
  }
  async getRotation(id: string) {
    const { rows } = await this.db.query<Record<string, unknown>>(`SELECT * FROM key_rotations WHERE id = $1`, [id]);
    return rows[0] ? this.rotation(rows[0]) : null;
  }
  async listRotations(accountId: string) {
    const { rows } = await this.db.query<Record<string, unknown>>(`SELECT * FROM key_rotations WHERE account_id = $1 ORDER BY created_at DESC`, [accountId]);
    return rows.map((r) => this.rotation(r));
  }

  // nonces / challenges -------------------------------------------------------
  async consumeNonce(scope: string, nonce: string, expiresAt: number) {
    const { rows } = await this.db.query(
      `INSERT INTO consumed_nonces (scope, nonce, expires_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING nonce`,
      [scope, nonce, expiresAt],
    );
    return rows.length === 1;
  }
  async putChallenge(c: ChallengeRecord) {
    await this.db.query(`INSERT INTO challenges (id, purpose, subject, challenge, expires_at) VALUES ($1,$2,$3,$4,$5)`, [c.id, c.purpose, c.subject, c.challenge, c.expiresAt]);
  }
  async takeChallenge(id: string) {
    const { rows } = await this.db.query<Record<string, unknown>>(`DELETE FROM challenges WHERE id = $1 RETURNING *`, [id]);
    const r = rows[0];
    return r ? { id: r.id as string, purpose: r.purpose as ChallengeRecord["purpose"], subject: r.subject as string, challenge: r.challenge as string, expiresAt: Number(r.expires_at) } : null;
  }

  // biometria -----------------------------------------------------------------
  async savePasskey(p: PasskeyRecord) {
    await this.db.query(
      `INSERT INTO passkeys (id, account_id, public_key, counter, rp_id, device_name, created_at, active_at, revoked_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET counter = EXCLUDED.counter, active_at = EXCLUDED.active_at, revoked_at = EXCLUDED.revoked_at`,
      [p.id, p.accountId, p.publicKey, p.counter, p.rpId, p.deviceName, p.createdAt, p.activeAt, p.revokedAt],
    );
  }
  async listPasskeys(accountId: string) {
    const { rows } = await this.db.query<Record<string, unknown>>(`SELECT * FROM passkeys WHERE account_id = $1 ORDER BY created_at`, [accountId]);
    return rows.map((r) => ({
      id: r.id as string,
      accountId: r.account_id as string,
      publicKey: r.public_key as string,
      counter: Number(r.counter),
      rpId: r.rp_id as string,
      deviceName: r.device_name as string,
      createdAt: Number(r.created_at),
      activeAt: Number(r.active_at),
      revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
    }));
  }

  // chave do webapp e trocas de votante ---------------------------------------
  async saveWebappKey(k: WebappKeyRecord) {
    await this.db.query(
      `INSERT INTO webapp_keys (account_id, public_key, credential_id, blob, device_name, created_at, revoked_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (account_id, public_key, credential_id) DO UPDATE SET revoked_at = EXCLUDED.revoked_at`,
      [k.accountId, k.publicKey, k.blob.credentialId, JSON.stringify(k.blob), k.deviceName, k.createdAt, k.revokedAt],
    );
  }
  async listWebappKeys(accountId: string) {
    const { rows } = await this.db.query<Record<string, unknown>>(`SELECT * FROM webapp_keys WHERE account_id = $1 ORDER BY created_at`, [accountId]);
    return rows.map((r) => ({
      accountId: r.account_id as string,
      publicKey: r.public_key as string,
      blob: r.blob as WebappKeyRecord["blob"],
      deviceName: r.device_name as string,
      createdAt: Number(r.created_at),
      revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
    }));
  }
  async saveSecurityChange(c: SecurityChangeRecord) {
    await this.db.query(
      `INSERT INTO security_changes (id, account_id, record, status, created_at) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET record = EXCLUDED.record, status = EXCLUDED.status`,
      [c.id, c.accountId, JSON.stringify(c), c.status, c.createdAt],
    );
  }
  async getSecurityChange(id: string) {
    const { rows } = await this.db.query<Record<string, unknown>>(`SELECT record FROM security_changes WHERE id = $1`, [id]);
    return rows[0] ? (rows[0].record as SecurityChangeRecord) : null;
  }
  async listSecurityChanges(accountId: string) {
    const { rows } = await this.db.query<Record<string, unknown>>(`SELECT record FROM security_changes WHERE account_id = $1 ORDER BY created_at DESC`, [accountId]);
    return rows.map((r) => r.record as SecurityChangeRecord);
  }

  // evidências ----------------------------------------------------------------
  async saveApproval(a: ApprovalRecord) {
    await this.db.query(
      `INSERT INTO approvals (id, intent_id, account_id, public_key, role, decision, statement, tx_signature, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [a.id, a.intentId, a.accountId, a.publicKey, a.role, a.decision, JSON.stringify(a.statement), a.txSignature, a.createdAt],
    );
  }
  async listApprovals(intentId: string) {
    const { rows } = await this.db.query<Record<string, unknown>>(`SELECT * FROM approvals WHERE intent_id = $1 ORDER BY created_at`, [intentId]);
    return rows.map((r) => ({
      id: r.id as string,
      intentId: r.intent_id as string,
      accountId: r.account_id as string,
      publicKey: r.public_key as string,
      role: r.role as ApprovalRecord["role"],
      decision: r.decision as ApprovalRecord["decision"],
      statement: r.statement,
      txSignature: (r.tx_signature as string | null) ?? null,
      createdAt: Number(r.created_at),
    }));
  }
  async saveSquadsTransaction(t: SquadsTransactionRecord) {
    await this.db.query(
      `INSERT INTO squads_transactions (account_id, multisig, transaction_index, kind, address, hash, intent_id, create_signature, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [t.accountId, t.multisig, t.transactionIndex, t.kind, t.address, t.hash, t.intentId, t.createSignature, t.createdAt],
    );
  }
  async saveSecurityEvent(e: SecurityEventRecord) {
    await this.db.query(`INSERT INTO security_events (id, account_id, code, message, at) VALUES ($1,$2,$3,$4,$5)`, [e.id, e.accountId, e.code, e.message, e.at]);
  }
  async listSecurityEvents(accountId: string) {
    const { rows } = await this.db.query<Record<string, unknown>>(`SELECT * FROM security_events WHERE account_id = $1 ORDER BY at DESC`, [accountId]);
    return rows.map((r) => ({ id: r.id as string, accountId: r.account_id as string, code: r.code as string, message: r.message as string, at: Number(r.at) }));
  }

  // auditoria -----------------------------------------------------------------
  async appendAudit(input: AuditInput, at: number): Promise<AuditEvent> {
    return this.db.transaction(async (tx) => {
      await tx.query(`LOCK TABLE audit_log IN EXCLUSIVE MODE`);
      const { rows } = await tx.query<{ seq: string; hash: string }>(`SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1`);
      const prev = rows[0];
      const base: Omit<AuditEvent, "hash"> = {
        seq: prev ? Number(prev.seq) + 1 : 1,
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
        details: JSON.parse(JSON.stringify(input.details ?? {}, bigintReplacer)),
        prevHash: prev?.hash ?? AUDIT_GENESIS,
      };
      const ev: AuditEvent = { ...base, hash: auditHash(base) };
      await tx.query(
        `INSERT INTO audit_log (seq, at, type, account_id, user_id, device_id, public_key, multisig, transaction_index, proposal, intent_id, intent_hash, tx_signature, details, prev_hash, hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [ev.seq, ev.at, ev.type, ev.accountId, ev.userId, ev.deviceId, ev.publicKey, ev.multisig, ev.transactionIndex, ev.proposal, ev.intentId, ev.intentHash, ev.txSignature, JSON.stringify(ev.details), ev.prevHash, ev.hash],
      );
      return ev;
    });
  }
  async listAudit(accountId?: string) {
    const { rows } = accountId
      ? await this.db.query<Record<string, unknown>>(`SELECT * FROM audit_log WHERE account_id = $1 ORDER BY seq`, [accountId])
      : await this.db.query<Record<string, unknown>>(`SELECT * FROM audit_log ORDER BY seq`);
    return rows.map((r) => ({
      seq: Number(r.seq),
      at: Number(r.at),
      type: r.type as AuditEvent["type"],
      accountId: (r.account_id as string | null) ?? null,
      userId: (r.user_id as string | null) ?? null,
      deviceId: (r.device_id as string | null) ?? null,
      publicKey: (r.public_key as string | null) ?? null,
      multisig: (r.multisig as string | null) ?? null,
      transactionIndex: (r.transaction_index as string | null) ?? null,
      proposal: (r.proposal as string | null) ?? null,
      intentId: (r.intent_id as string | null) ?? null,
      intentHash: (r.intent_hash as string | null) ?? null,
      txSignature: (r.tx_signature as string | null) ?? null,
      details: r.details as Record<string, unknown>,
      prevHash: r.prev_hash as string,
      hash: r.hash as string,
    }));
  }
}

/** A política tem tetos em bigint; no JSON eles viram {"$bigint":"..."}. */
function bigintReplacer(_k: string, v: unknown) {
  return typeof v === "bigint" ? { $bigint: v.toString() } : v;
}
function reviveBigints(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reviveBigints);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Object.keys(o).length === 1 && typeof o.$bigint === "string") return BigInt(o.$bigint);
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, reviveBigints(x)]));
  }
  return v;
}
