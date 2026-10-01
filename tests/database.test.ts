import { describe, expect, it } from "vitest";
import { migrate, openPglite, PgStore } from "@duplachave/database";
import { verifyAuditChain } from "@duplachave/custody";

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

  it("trigger impede reativar chave revogada", async () => {
    const db = await openPglite();
    await migrate(db);
    const s = new PgStore(db);
    await s.saveUser({ id: "u", name: "u", policy: { allowedPrograms: [], allowedMints: [], maxLamportsPerTx: 5n, maxTokenPerTx: {}, addressBook: [], requireAddressBook: false }, createdAt: 1 });
    expect((await s.getUser("u"))?.policy.maxLamportsPerTx).toBe(5n);
    await s.saveAccount({ id: "a", userId: "u", cluster: "localnet", multisig: "m", vault: "v", roles: { client: "c", server: "s", executor: "e", proposer: "p" }, frozenBy: null, createdAt: 1 });
    const m = { accountId: "a", publicKey: "k", role: "CLIENT" as const, permissions: 2, status: "REVOKED" as const, deviceId: null, createdAt: 1, revokedAt: 2 };
    await s.saveMember(m);
    await expect(s.saveMember({ ...m, status: "ACTIVE", revokedAt: null })).rejects.toThrow(/revogada/);
  });
});
