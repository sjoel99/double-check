import { PublicKey } from "@solana/web3.js";
import {
  ATA_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  MEMO_PROGRAM,
  SQUADS_V4_PROGRAM,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
} from "./programs";

export type RawAccountMeta = { pubkey: PublicKey; isSigner: boolean; isWritable: boolean };
export type RawInstruction = { programId: PublicKey; keys: RawAccountMeta[]; data: Uint8Array };

/**
 * O que uma instrução faz, lido dos bytes. Tudo que não está aqui vira
 * UNKNOWN — e UNKNOWN nunca é tratado como seguro.
 */
export type ParsedInstruction =
  | { kind: "SYSTEM_TRANSFER"; from: string; to: string; lamports: bigint }
  | { kind: "SYSTEM_ASSIGN"; account: string; owner: string }
  | { kind: "SYSTEM_CREATE_ACCOUNT"; from: string; newAccount: string; lamports: bigint; owner: string }
  | { kind: "SYSTEM_OTHER"; tag: number }
  | { kind: "TOKEN_TRANSFER_CHECKED"; program: string; source: string; mint: string; destination: string; authority: string; amount: bigint; decimals: number }
  | { kind: "TOKEN_TRANSFER_UNCHECKED"; program: string; source: string; destination: string; authority: string; amount: bigint }
  | { kind: "TOKEN_APPROVE"; program: string; source: string; delegate: string }
  | { kind: "TOKEN_SET_AUTHORITY"; program: string; account: string; authorityType: number; newAuthority: string | null }
  | { kind: "TOKEN_CLOSE_ACCOUNT"; program: string; account: string; destination: string }
  | { kind: "TOKEN_OTHER"; program: string; tag: number }
  | { kind: "ATA_CREATE"; idempotent: boolean; payer: string; ata: string; owner: string; mint: string; tokenProgram: string }
  | { kind: "MEMO"; text: string }
  | { kind: "COMPUTE_BUDGET" }
  | { kind: "SQUADS_CALL" }
  | { kind: "UNKNOWN"; programId: string };

function readU32LE(d: Uint8Array, o: number) {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(o, true);
}
function readU64LE(d: Uint8Array, o: number) {
  return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(o, true);
}
const key = (ix: RawInstruction, i: number) => {
  const k = ix.keys[i];
  if (!k) throw new Error(`conta ${i} ausente`);
  return k.pubkey.toBase58();
};

export function parseInstruction(ix: RawInstruction): ParsedInstruction {
  const p = ix.programId;
  const d = ix.data;
  try {
    if (p.equals(SYSTEM_PROGRAM)) {
      const tag = readU32LE(d, 0);
      if (tag === 2 && d.length === 12) return { kind: "SYSTEM_TRANSFER", from: key(ix, 0), to: key(ix, 1), lamports: readU64LE(d, 4) };
      if (tag === 1 && d.length === 36) return { kind: "SYSTEM_ASSIGN", account: key(ix, 0), owner: new PublicKey(d.subarray(4, 36)).toBase58() };
      if (tag === 0 && d.length === 52)
        return { kind: "SYSTEM_CREATE_ACCOUNT", from: key(ix, 0), newAccount: key(ix, 1), lamports: readU64LE(d, 4), owner: new PublicKey(d.subarray(20, 52)).toBase58() };
      return { kind: "SYSTEM_OTHER", tag };
    }
    if (p.equals(TOKEN_PROGRAM) || p.equals(TOKEN_2022_PROGRAM)) {
      const program = p.toBase58();
      const tag = d[0] ?? 255;
      if (tag === 12 && d.length === 10)
        return { kind: "TOKEN_TRANSFER_CHECKED", program, source: key(ix, 0), mint: key(ix, 1), destination: key(ix, 2), authority: key(ix, 3), amount: readU64LE(d, 1), decimals: d[9]! };
      if (tag === 3) return { kind: "TOKEN_TRANSFER_UNCHECKED", program, source: key(ix, 0), destination: key(ix, 1), authority: key(ix, 2), amount: readU64LE(d, 1) };
      if (tag === 4 || tag === 13) return { kind: "TOKEN_APPROVE", program, source: key(ix, 0), delegate: key(ix, tag === 4 ? 1 : 2) };
      if (tag === 6) {
        const hasNew = d[2] === 1;
        return { kind: "TOKEN_SET_AUTHORITY", program, account: key(ix, 0), authorityType: d[1]!, newAuthority: hasNew ? new PublicKey(d.subarray(3, 35)).toBase58() : null };
      }
      if (tag === 9) return { kind: "TOKEN_CLOSE_ACCOUNT", program, account: key(ix, 0), destination: key(ix, 1) };
      return { kind: "TOKEN_OTHER", program, tag };
    }
    if (p.equals(ATA_PROGRAM)) {
      const idempotent = d.length > 0 && d[0] === 1;
      if (d.length === 0 || d[0] === 0 || d[0] === 1)
        return { kind: "ATA_CREATE", idempotent, payer: key(ix, 0), ata: key(ix, 1), owner: key(ix, 2), mint: key(ix, 3), tokenProgram: key(ix, 5) };
      return { kind: "UNKNOWN", programId: p.toBase58() };
    }
    if (p.equals(MEMO_PROGRAM)) return { kind: "MEMO", text: new TextDecoder().decode(d) };
    if (p.equals(COMPUTE_BUDGET_PROGRAM)) return { kind: "COMPUTE_BUDGET" };
    if (p.equals(SQUADS_V4_PROGRAM)) return { kind: "SQUADS_CALL" };
  } catch {
    return { kind: "UNKNOWN", programId: p.toBase58() };
  }
  return { kind: "UNKNOWN", programId: p.toBase58() };
}
