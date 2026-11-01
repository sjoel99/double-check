import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  ApprovalRecord,
  AuditEvent,
  AuditInput,
  ChallengeRecord,
  HandoffRecord,
  PendingEnrollmentRecord,
  SecurityChangeRecord,
  WebappKeyRecord,
  ChallengeStore,
  DeviceRecord,
  IntentRecord,
  MemberRecord,
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
  /** Fecha conexões (encerramento gracioso). Ausente no `Db` de uma transação aberta. */
  close?(): Promise<void>;
}

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/**
 * Aplica, em ordem, os `.sql` da pasta de migrações que ainda não constam em
 * `schema_migrations`. A 001 é idempotente (CREATE IF NOT EXISTS, ALTER IF NOT
 * EXISTS): um banco criado antes desta tabela existir a reaplica sem efeito e a
 * registra. Os arquivos são idempotentes (IF NOT EXISTS): uma queda no meio se resolve rodando de novo.
 */
export async function migrate(db: Db) {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at bigint NOT NULL)`);
  const { rows } = await db.query<{ name: string }>(`SELECT name FROM schema_migrations`);
  const applied = new Set(rows.map((r) => r.name));
  for (const name of migrationFiles()) {
    if (applied.has(name)) continue;
    // `exec` (protocolo simples): o arquivo tem várias instruções e corpos `$$`, que o protocolo com parâmetros recusa.
    await db.exec(readFileSync(`${MIGRATIONS_DIR}${name}`, "utf8"));
    await db.query(`INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)`, [name, Math.floor(Date.now() / 1000)]);
  }
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort();
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
    close: () => pg.close(),
  };
}

// `Db.transaction` só abre transação nova no nível de fora; o PgStore de uma
// transação aberta (ver PgStore.transaction) entrega um `Db` cujo `transaction`
// reaproveita a conexão, o que faz `LOCK TABLE` e os INSERTs do audit entrarem
// na mesma transação do chamador.

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
    close: () => pool.end(),
  };
}

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export class PgStore implements Store, ChallengeStore {
  constructor(private readonly db: Db) {}

  /**
   * BEGIN … COMMIT/ROLLBACK de verdade: `fn` recebe um PgStore preso à mesma
   * conexão. Dentro dela, `transaction` e o `appendAudit` (que abre uma) só
   * reaproveitam a transação aberta — Postgres não aninha.
   */
  async transaction<T>(fn: (s: Store) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => {
      const inner: Db = { query: (t, p) => tx.query(t, p), exec: async (sql) => void (await tx.query(sql)), transaction: (f) => f(tx) };
      return fn(new PgStore(inner));
    });
  }

  // users / devices -----------------------------------------------------------
  async saveUser(u: UserRecord) {
    await this.db.query(
      `INSERT INTO users (id, name, policy, created_at, email, email_verified_at) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, policy = EXCLUDED.policy, email = EXCLUDED.email, email_verified_at = EXCLUDED.email_verified_at`,
      [u.id, u.name, JSON.stringify(u.policy, bigintReplacer), u.createdAt, u.email ?? null, u.emailVerifiedAt ?? null],
    );
  }
  async getUser(id: string) {
    const { rows } = await this.db.query<{ id: string; name: string; policy: unknown; created_at: string; email: string | null; email_verified_at: string | null }>(`SELECT * FROM users WHERE id = $1`, [id]);
    const r = rows[0];
    return r ? { id: r.id, name: r.name, policy: reviveBigints(r.policy) as UserRecord["policy"], createdAt: Number(r.created_at), email: r.email, emailVerifiedAt: n(r.email_verified_at) } : null;
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
  async findWebappKeyByCredential(credentialId: string) {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT k.account_id, k.public_key, k.blob, k.device_name, k.created_at, k.revoked_at,
              a.id AS a_id, a.user_id AS a_user_id, a.cluster AS a_cluster, a.multisig AS a_multisig, a.vault AS a_vault, a.roles AS a_roles, a.frozen_by AS a_frozen_by, a.created_at AS a_created_at
         FROM webapp_keys k JOIN smart_accounts a ON a.id = k.account_id
        WHERE k.credential_id = $1 AND k.revoked_at IS NULL AND k.public_key = a.roles->>'webapp'
        ORDER BY k.created_at ASC LIMIT 1`,
      [credentialId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      account: this.account({ id: r.a_id, user_id: r.a_user_id, cluster: r.a_cluster, multisig: r.a_multisig, vault: r.a_vault, roles: r.a_roles, frozen_by: r.a_frozen_by, created_at: r.a_created_at }),
      key: { accountId: r.account_id as string, publicKey: r.public_key as string, blob: r.blob as WebappKeyRecord["blob"], deviceName: r.device_name as string, createdAt: Number(r.created_at), revokedAt: n(r.revoked_at) },
    };
  }

  // "continuar no celular" e cadastros preparados --------------------------------
  async saveHandoff(h: HandoffRecord) {
    await this.db.query(
      `INSERT INTO handoffs (token, poll, kind, label, subject, account_id, created_at, expires_at, status, error, result) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (token) DO UPDATE SET status = EXCLUDED.status, error = EXCLUDED.error, result = EXCLUDED.result`,
      [h.token, h.poll, h.kind, h.label, h.subject, h.accountId, h.createdAt, h.expiresAt, h.status, h.error, h.result ? JSON.stringify(h.result) : null],
    );
  }
  private handoff(r: Record<string, unknown>): HandoffRecord {
    return {
      token: r.token as string,
      poll: r.poll as string,
      kind: r.kind as HandoffRecord["kind"],
      label: r.label as string,
      subject: (r.subject as string | null) ?? null,
      accountId: (r.account_id as string | null) ?? null,
      createdAt: Number(r.created_at),
      expiresAt: Number(r.expires_at),
      status: r.status as HandoffRecord["status"],
      error: (r.error as string | null) ?? null,
      result: (r.result as Record<string, unknown> | null) ?? null,
    };
  }
  async getHandoff(token: string) {
    const { rows } = await this.db.query<Record<string, unknown>>(`SELECT * FROM handoffs WHERE token = $1`, [token]);
    return rows[0] ? this.handoff(rows[0]) : null;
  }
  async getHandoffByPoll(poll: string) {
    const { rows } = await this.db.query<Record<string, unknown>>(`SELECT * FROM handoffs WHERE poll = $1`, [poll]);
    return rows[0] ? this.handoff(rows[0]) : null;
  }
  async purgeHandoffs(before: number) {
    await this.db.query(`DELETE FROM handoffs WHERE expires_at < $1`, [before]);
  }
  async savePendingEnrollment(p: PendingEnrollmentRecord) {
    await this.db.query(`INSERT INTO pending_enrollments (id, record, created_at) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET record = EXCLUDED.record`, [p.id, JSON.stringify(p), p.createdAt]);
  }
  async getPendingEnrollment(id: string) {
    const { rows } = await this.db.query<{ record: PendingEnrollmentRecord }>(`SELECT record FROM pending_enrollments WHERE id = $1`, [id]);
    return rows[0]?.record ?? null;
  }
  async deletePendingEnrollment(id: string) {
    await this.db.query(`DELETE FROM pending_enrollments WHERE id = $1`, [id]);
  }
  async listPendingEnrollments() {
    const { rows } = await this.db.query<{ record: PendingEnrollmentRecord }>(`SELECT record FROM pending_enrollments ORDER BY created_at`);
    return rows.map((r) => r.record);
  }
  async listAccountIdsWithOpenWork() {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT DISTINCT account_id AS id FROM transaction_intents WHERE status = 'AWAITING_CLIENT'
       UNION SELECT DISTINCT account_id AS id FROM security_changes WHERE status IN ('PREPARED','PENDING')`,
    );
    return rows.map((r) => r.id);
  }
  async purgeExpired(now: number) {
    await this.db.query(`DELETE FROM challenges WHERE expires_at < $1`, [now]);
    await this.db.query(`DELETE FROM consumed_nonces WHERE expires_at < $1`, [now]);
    await this.purgeHandoffs(now - 600);
    await this.db.query(`DELETE FROM pending_enrollments WHERE created_at < $1`, [now - 3600]);
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
