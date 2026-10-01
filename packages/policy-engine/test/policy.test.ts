import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { sealIntent, type TransactionIntent } from "@duplachave/shared";
import { parseInstruction, TOKEN_PROGRAM } from "@duplachave/solana";
import type { VaultView } from "@duplachave/squads";
import { DEFAULT_POLICY, DefaultPolicyEngine } from "../src/index";

const vault = Keypair.generate().publicKey;
const dest = Keypair.generate().publicKey;
const ctx = { vaultLamports: 10_000_000_000n, verifiedNewKeys: [], revokedKeys: [] };
const user = { id: "u", policy: DEFAULT_POLICY };

function intent(amount = "1000000000"): TransactionIntent {
  return sealIntent({
    version: 1, id: crypto.randomUUID(), cluster: "localnet", multisig: Keypair.generate().publicKey.toBase58(), transactionIndex: "1",
    createdAt: 1, expiresAt: 100, kind: "OPERATION", type: "TRANSFER_SOL", vault: vault.toBase58(), vaultIndex: 0,
    amountLamports: amount, destination: dest.toBase58(), programs: [SystemProgram.programId.toBase58()],
  });
}

function view(ixs: TransactionInstruction[], operation: VaultView["operation"]): VaultView {
  return {
    kind: "VAULT", vault: vault.toBase58(), writable: [],
    instructions: ixs.map((ix) => parseInstruction({ programId: ix.programId, keys: ix.keys, data: new Uint8Array(ix.data) })),
    programs: [...new Set(ixs.map((i) => i.programId.toBase58()))].sort(),
    operation,
  };
}

const engine = new DefaultPolicyEngine();
const transfer = SystemProgram.transfer({ fromPubkey: vault, toPubkey: dest, lamports: 1_000_000_000n });
const op = { type: "TRANSFER_SOL" as const, amountLamports: "1000000000", destination: dest.toBase58() };

describe("DefaultPolicyEngine", () => {
  it("transferência simples passa, marcada como destino externo", async () => {
    const d = await engine.validate(user, intent(), view([transfer], op), ctx);
    expect(d.allowed).toBe(true);
    expect(d.riskFlags).toContain("EXTERNAL_DESTINATION");
  });

  it("instrução extra (delegate de token) é recusada mesmo com a transferência certa", async () => {
    const approve = new TransactionInstruction({
      programId: TOKEN_PROGRAM,
      keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }, { pubkey: dest, isSigner: false, isWritable: false }, { pubkey: vault, isSigner: true, isWritable: false }],
      data: Buffer.from([4, ...new Array(8).fill(255)]),
    });
    const d = await engine.validate(user, intent(), view([transfer, approve], null), ctx);
    expect(d.allowed).toBe(false);
    expect(d.reasons.join()).toMatch(/DELEGATE_CREATION/);
  });

  it("programa desconhecido e chamada à Squads de dentro do vault são recusados", async () => {
    const unknown = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([1]) });
    const squads = new TransactionInstruction({ programId: new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf"), keys: [], data: Buffer.from([1]) });
    for (const extra of [unknown, squads]) {
      const d = await engine.validate(user, intent(), view([transfer, extra], null), ctx);
      expect(d.allowed).toBe(false);
    }
  });

  it("System Assign (troca de dono) é recusado", async () => {
    const assign = SystemProgram.assign({ accountPubkey: vault, programId: Keypair.generate().publicKey });
    const d = await engine.validate(user, intent(), view([assign], null), ctx);
    expect(d.reasons.join()).toMatch(/AUTHORITY_CHANGE/);
  });

  it("acima do teto e quase todo o saldo", async () => {
    const big = SystemProgram.transfer({ fromPubkey: vault, toPubkey: dest, lamports: 60_000_000_000n });
    const d = await engine.validate(user, intent("60000000000"), view([big], { ...op, amountLamports: "60000000000" }), { ...ctx, vaultLamports: 61_000_000_000n });
    expect(d.reasons.join()).toMatch(/LIMIT_EXCEEDED/);
    expect(d.riskFlags).toContain("POSSIBLE_FULL_BALANCE");
  });

  it("intenção diferente da transação é recusada", async () => {
    const d = await engine.validate(user, intent("5"), view([transfer], op), ctx);
    expect(d.reasons.join()).toMatch(/INTENT_MISMATCH/);
  });

  it("ConfigTransaction com spending limit ou threshold é recusada", async () => {
    const i = sealIntent({
      version: 1, id: crypto.randomUUID(), cluster: "localnet", multisig: Keypair.generate().publicKey.toBase58(), transactionIndex: "1",
      createdAt: 1, expiresAt: 100, kind: "CONFIG", type: "ROTATE_MEMBER", role: "CLIENT", oldKey: vault.toBase58(), newKey: dest.toBase58(), rotationId: crypto.randomUUID(),
    });
    const d = await engine.validate(user, i, { kind: "CONFIG", actions: [{ kind: "AddSpendingLimit" }, { kind: "ChangeThreshold", threshold: 1 }], rotation: null }, ctx);
    expect(d.allowed).toBe(false);
    expect(d.reasons.join()).toMatch(/SPENDING_LIMIT_FORBIDDEN/);
    expect(d.reasons.join()).toMatch(/THRESHOLD_CHANGE_FORBIDDEN/);
  });
});
