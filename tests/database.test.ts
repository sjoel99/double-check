import { describe, expect, it } from "vitest";
import { migrate, migrationFiles, openPglite, PgStore } from "@duplachave/database";
import { type ChallengeStore, type IntentRecord, MemoryStore, type Store, verifyAuditChain } from "@duplachave/custody";

describe("PgStore (PGlite)", () => {
  it("auditoria é só inserção e encadeada", async () => {
    const db = await openPglite();
    await migrate(db);
    const s = new PgStore(db);
    await s.appendAudit({ type: "SMART_ACCOUNT_CREATED", accountId: "a" }, 1);
    await s.appendAudit({ type: "TRANSACTION_PROPOSED", accountId: "a", details: { x: 1 } }, 2);
    expect(verifyAuditChain(await s.listAudit())).toBe(true);
    await expect(db.query(`UPDATE audit_log SET type = 'X' WHERE seq = 1`)).rejects.toThrow(/só inserção/);
    await expect(db.query(`DELETE FROM audit_log`)).rejects.toThrow(/só inserção/);
  });

  it("nonce de uso único é atômico no banco", async () => {
    const db = await openPglite();
    await migrate(db);
    const s = new PgStore(db);
    expect(await s.consumeNonce("approval", "ab".repeat(16), 10)).toBe(true);
    expect(await s.consumeNonce("approval", "ab".repeat(16), 10)).toBe(false);
  });

  it("transaction: tudo ou nada, inclusive a auditoria encadeada dentro dela", async () => {
    const db = await openPglite();
    await migrate(db);
    const s = new PgStore(db);
    const user = { id: "u", name: "u", policy: { allowedPrograms: [], allowedMints: [], maxLamportsPerTx: 5n, maxTokenPerTx: {}, addressBook: [], requireAddressBook: false }, createdAt: 1 };
    // Falha no meio: nem o usuário nem o evento de auditoria ficam.
    await expect(
      s.transaction(async (tx) => {
        await tx.saveUser(user);
        await tx.appendAudit({ type: "SMART_ACCOUNT_CREATED", accountId: "a" }, 1);
        throw new Error("queda no meio");
      }),
    ).rejects.toThrow(/queda/);
    expect(await s.getUser("u")).toBeNull();
    expect(await s.listAudit()).toEqual([]);
    // Sucesso: os dois ficam, e a cadeia da auditoria continua válida.
    await s.transaction(async (tx) => {
      await tx.saveUser(user);
      await tx.appendAudit({ type: "SMART_ACCOUNT_CREATED", accountId: "a" }, 1);
    });
    await s.appendAudit({ type: "TRANSACTION_PROPOSED", accountId: "a" }, 2);
    expect((await s.getUser("u"))?.id).toBe("u");
    expect(verifyAuditChain(await s.listAudit())).toBe(true);
  });

  it("MemoryStore.transaction volta à foto anterior se falhar", async () => {
    const s = new MemoryStore();
    const user = { id: "u", name: "u", policy: { allowedPrograms: [], allowedMints: [], maxLamportsPerTx: 5n, maxTokenPerTx: {}, addressBook: [], requireAddressBook: false }, createdAt: 1 };
    await expect(
      s.transaction(async (tx) => {
        await tx.saveUser(user);
        await tx.appendAudit({ type: "SMART_ACCOUNT_CREATED", accountId: "a" }, 1);
        throw new Error("queda");
      }),
    ).rejects.toThrow(/queda/);
    expect(await s.getUser("u")).toBeNull();
    expect(await s.listAudit()).toEqual([]);
    await s.transaction(async (tx) => void (await tx.saveUser(user)));
    expect((await s.getUser("u"))?.id).toBe("u");
  });

  it("trigger impede reativar chave revogada", async () => {
    const db = await openPglite();
    await migrate(db);
    const s = new PgStore(db);
    await s.saveUser({ id: "u", name: "u", policy: { allowedPrograms: [], allowedMints: [], maxLamportsPerTx: 5n, maxTokenPerTx: {}, addressBook: [], requireAddressBook: false }, createdAt: 1 });
    expect((await s.getUser("u"))?.policy.maxLamportsPerTx).toBe(5n);
    await s.saveAccount({ id: "a", userId: "u", cluster: "localnet", multisig: "m", vault: "v", roles: { client: "c", webapp: "w", server: "s", operator: "o" }, frozenBy: null, createdAt: 1 });
    const m = { accountId: "a", publicKey: "k", role: "CLIENT" as const, permissions: 2, status: "REVOKED" as const, deviceId: null, createdAt: 1, revokedAt: 2 };
    await s.saveMember(m);
    await expect(s.saveMember({ ...m, status: "ACTIVE", revokedAt: null })).rejects.toThrow(/revogada/);
  });
});

// ---------------------------------------------------------------------------
// Estado que vivia em memória (QR, cadastros preparados), buscas indexadas e purga:
// o mesmo contrato nos dois stores.
// ---------------------------------------------------------------------------
const policy = { allowedPrograms: [], allowedMints: [], maxLamportsPerTx: 5n, maxTokenPerTx: {}, addressBook: [], requireAddressBook: false };
const stores: [string, () => Promise<Store>][] = [
  ["MemoryStore", async () => new MemoryStore()],
  [
    "PgStore (PGlite)",
    async () => {
      const db = await openPglite();
      await migrate(db);
      return new PgStore(db);
    },
  ],
];

describe.each(stores)("%s: estado persistido e purga", (_name, open) => {
  const seedAccount = async (s: Store, id = "a", webapp = "w") => {
    await s.saveUser({ id: `u-${id}`, name: "u", policy, createdAt: 1 });
    await s.saveAccount({ id, userId: `u-${id}`, cluster: "localnet", multisig: `m-${id}`, vault: `v-${id}`, roles: { client: `c-${id}`, webapp, server: `s-${id}`, operator: "o" }, frozenBy: null, createdAt: 1 });
  };

  it("acha a cópia da chave do webapp pela passkey: só a não revogada e da chave atual", async () => {
    const s = await open();
    await seedAccount(s, "a", "w1");
    await seedAccount(s, "b", "w2");
    const blob = (credentialId: string) => ({ credentialId, salt: "s", iv: "i", ciphertext: "c" });
    await s.saveWebappKey({ accountId: "a", publicKey: "w1", blob: blob("cred-atual"), deviceName: "Celular", createdAt: 1, revokedAt: null });
    await s.saveWebappKey({ accountId: "a", publicKey: "w0", blob: blob("cred-antiga"), deviceName: "Antigo", createdAt: 1, revokedAt: null }); // chave que não é mais a atual
    await s.saveWebappKey({ accountId: "b", publicKey: "w2", blob: blob("cred-revogada"), deviceName: "Perdido", createdAt: 1, revokedAt: 5 });
    const found = await s.findWebappKeyByCredential("cred-atual");
    expect(found?.account.id).toBe("a");
    expect(found?.key.deviceName).toBe("Celular");
    expect(await s.findWebappKeyByCredential("cred-antiga")).toBeNull();
    expect(await s.findWebappKeyByCredential("cred-revogada")).toBeNull();
    expect(await s.findWebappKeyByCredential("nao-existe")).toBeNull();
  });

  it("pedido do QR: token e poll separados; vence e é purgado", async () => {
    const s = await open();
    const h = { token: "t1", poll: "p1", kind: "CONNECT" as const, label: "Entrar", subject: null, accountId: null, createdAt: 100, expiresAt: 700, status: "WAITING" as const, error: null, result: null };
    await s.saveHandoff(h);
    expect((await s.getHandoff("t1"))?.poll).toBe("p1");
    expect((await s.getHandoffByPoll("p1"))?.token).toBe("t1");
    expect(await s.getHandoff("p1")).toBeNull();
    await s.saveHandoff({ ...h, status: "DONE", result: { accountId: "a" } });
    expect(await s.getHandoffByPoll("p1")).toMatchObject({ status: "DONE", result: { accountId: "a" } });
    await s.purgeHandoffs(700); // ainda não venceu (expires_at < before é falso)
    expect(await s.getHandoff("t1")).not.toBeNull();
    await s.purgeHandoffs(701);
    expect(await s.getHandoff("t1")).toBeNull();
  });

  it("cadastro preparado sobrevive no store e some ao concluir ou envelhecer", async () => {
    const s = await open();
    const p = { id: "e1", wallet: "c", webapp: "w", walletName: "Phantom", plan: { userId: "u", roles: { client: "c", webapp: "w", server: "s", operator: "o" }, multisig: "m", vault: "v" }, message: "AAAA", createdAt: 1000 };
    await s.savePendingEnrollment(p);
    expect(await s.getPendingEnrollment("e1")).toEqual(p);
    expect((await s.listPendingEnrollments()).map((x) => x.id)).toEqual(["e1"]);
    await s.deletePendingEnrollment("e1");
    expect(await s.getPendingEnrollment("e1")).toBeNull();
    await s.savePendingEnrollment(p);
    await s.purgeExpired(1000 + 3600); // created_at < now - 3600 é falso: fica
    expect(await s.getPendingEnrollment("e1")).not.toBeNull();
    await s.purgeExpired(1000 + 3601);
    expect(await s.getPendingEnrollment("e1")).toBeNull();
  });

  it("purga desafios e nonces vencidos; mantém os válidos", async () => {
    const s = await open();
    const cs = s as unknown as ChallengeStore;
    await cs.putChallenge({ id: "velho", purpose: "AUTH", subject: "k", challenge: "x", expiresAt: 50 });
    await cs.putChallenge({ id: "novo", purpose: "AUTH", subject: "k", challenge: "y", expiresAt: 500 });
    expect(await s.consumeNonce("n", "velho", 50)).toBe(true);
    expect(await s.consumeNonce("n", "novo", 500)).toBe(true);
    await s.purgeExpired(100);
    expect(await cs.takeChallenge("velho")).toBeNull();
    expect((await cs.takeChallenge("novo"))?.id).toBe("novo");
    expect(await s.consumeNonce("n", "velho", 900)).toBe(true); // o registro vencido saiu; um novo uso é aceito
    expect(await s.consumeNonce("n", "novo", 900)).toBe(false);
  });

  it("só contas com algo em aberto entram na varredura", async () => {
    const s = await open();
    await seedAccount(s, "a");
    await seedAccount(s, "b");
    await seedAccount(s, "c");
    const intent = (id: string, accountId: string, status: IntentRecord["status"]): IntentRecord => ({
      intent: { version: 1, id, cluster: "localnet", multisig: `m-${accountId}`, transactionIndex: "1", createdAt: 1, expiresAt: 601, kind: "OPERATION", type: "TRANSFER_SOL", vault: `v-${accountId}`, vaultIndex: 0, amountLamports: "1", destination: "11111111111111111111111111111112", programs: [], intentHash: `h-${id}` } as IntentRecord["intent"],
      accountId, transactionHash: "", status, riskFlags: [], reasons: [], signatures: {}, updatedAt: 1, prepared: null,
    });
    await s.saveIntent(intent("11111111-1111-4111-8111-111111111111", "a", "AWAITING_CLIENT"));
    await s.saveIntent(intent("22222222-2222-4222-8222-222222222222", "b", "EXECUTED"));
    await s.saveSecurityChange({ id: "ch", accountId: "c", role: "CLIENT", oldKey: "c-c", newKey: "n", status: "PENDING", index: "2", createdAt: 1, executeAfter: 9, prepared: null, newKeyBlob: null, signatures: {}, history: [] });
    expect((await s.listAccountIdsWithOpenWork()).sort()).toEqual(["a", "c"]);
  });
});

describe("migrações", () => {
  it("rodam uma vez cada, em ordem, e são registradas; repetir não muda nada", async () => {
    const db = await openPglite();
    await migrate(db);
    const names = () => db.query<{ name: string }>(`SELECT name FROM schema_migrations ORDER BY name`).then((r) => r.rows.map((x) => x.name));
    expect(await names()).toEqual(migrationFiles());
    expect((await names()).length).toBeGreaterThanOrEqual(2);
    await migrate(db);
    expect((await names()).length).toBe(migrationFiles().length);
    // As tabelas do modelo 2 de 2 saíram; as novas existem.
    const tables = (await db.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)).rows.map((r) => r.table_name);
    expect(tables).not.toContain("key_rotations");
    expect(tables).not.toContain("passkeys");
    expect(tables).toEqual(expect.arrayContaining(["handoffs", "pending_enrollments", "schema_migrations"]));
  });

  it("um banco criado antes do registro (só a 001 aplicada) ganha a 002 sem erro", async () => {
    const db = await openPglite();
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    await db.exec(readFileSync(fileURLToPath(new URL("../packages/database/migrations/001_init.sql", import.meta.url)), "utf8"));
    await migrate(db);
    const rows = (await db.query<{ name: string }>(`SELECT name FROM schema_migrations ORDER BY name`)).rows.map((r) => r.name);
    expect(rows).toEqual(migrationFiles());
  });
});
