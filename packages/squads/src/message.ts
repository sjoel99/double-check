import { PublicKey } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { deny } from "@duplachave/shared";
import type { RawInstruction } from "@duplachave/solana";

/**
 * Reconstrói as instruções de uma VaultTransaction lida da chain. Lookup
 * tables não são aceitas: com elas, parte das contas viria de outra conta
 * mutável e o que o usuário vê deixaria de estar todo na transação.
 */
export function vaultMessageInstructions(vt: multisig.accounts.VaultTransaction): RawInstruction[] {
  const m = vt.message;
  if (m.addressTableLookups.length > 0) deny("ALT_NOT_SUPPORTED", "transação usa address lookup table");
  const keys = m.accountKeys;
  const numSigners = m.numSigners;
  const numNonSigners = keys.length - numSigners;
  const isSigner = (i: number) => i < numSigners;
  const isWritable = (i: number) =>
    i < numSigners ? i < m.numWritableSigners : i - numSigners < m.numWritableNonSigners;
  if (numNonSigners < 0) deny("BAD_MESSAGE", "mensagem malformada");

  return m.instructions.map((ci) => {
    const programId = keys[ci.programIdIndex];
    if (!programId) deny("BAD_MESSAGE", "programIdIndex fora da tabela");
    return {
      programId: new PublicKey(programId),
      keys: Array.from(ci.accountIndexes).map((i) => {
        const k = keys[i];
        if (!k) deny("BAD_MESSAGE", "accountIndex fora da tabela");
        return { pubkey: new PublicKey(k), isSigner: isSigner(i), isWritable: isWritable(i) };
      }),
      data: new Uint8Array(ci.data),
    };
  });
}

export function writableAccounts(vt: multisig.accounts.VaultTransaction): string[] {
  const m = vt.message;
  return m.accountKeys
    .map((k, i) => ({ k: k.toBase58(), i }))
    .filter(({ i }) => (i < m.numSigners ? i < m.numWritableSigners : i - m.numSigners < m.numWritableNonSigners))
    .map(({ k }) => k);
}
