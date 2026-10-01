import { PublicKey, SystemProgram } from "@solana/web3.js";

export const SYSTEM_PROGRAM = SystemProgram.programId;
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const COMPUTE_BUDGET_PROGRAM = new PublicKey("ComputeBudget111111111111111111111111111111");
export const SQUADS_V4_PROGRAM = new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");

export const KNOWN_PROGRAM_NAMES: Record<string, string> = {
  [SYSTEM_PROGRAM.toBase58()]: "System",
  [TOKEN_PROGRAM.toBase58()]: "SPL Token",
  [TOKEN_2022_PROGRAM.toBase58()]: "Token-2022",
  [ATA_PROGRAM.toBase58()]: "Associated Token Account",
  [MEMO_PROGRAM.toBase58()]: "Memo",
  [COMPUTE_BUDGET_PROGRAM.toBase58()]: "Compute Budget",
  [SQUADS_V4_PROGRAM.toBase58()]: "Squads v4",
};

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN_PROGRAM): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  )[0];
}
