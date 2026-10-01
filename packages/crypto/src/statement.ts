import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { canonicalize } from "@duplachave/shared";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { type Signer, verifyEd25519 } from "./signer";

/**
 * Mensagens off-chain assinadas pelas chaves de aprovação.
 *
 * A mesma chave Ed25519 assina transações Solana. Para que uma declaração
 * nunca possa ser lida como transação (nem o contrário), os bytes começam com
 * 0xFF: uma mensagem legacy começa com o número de assinaturas (< 0x80 na
 * prática) e uma versionada com 0x80 | versão (só v0 existe). É a mesma
 * técnica do padrão de mensagens off-chain da Solana ("\xffsolana offchain").
 */
const PREFIX = new Uint8Array([0xff, ...utf8ToBytes("duplachave/v1\n")]);

export function statementBytes(statement: object): Uint8Array {
  const body = utf8ToBytes(canonicalize(statement));
  const out = new Uint8Array(PREFIX.length + body.length);
  out.set(PREFIX, 0);
  out.set(body, PREFIX.length);
  return out;
}

export type Signed<T> = { statement: T; signature: string };

export async function signStatement<T extends object>(signer: Signer, statement: T): Promise<Signed<T>> {
  const sig = await signer.sign(statementBytes(statement));
  return { statement, signature: bs58.encode(sig) };
}

export function verifyStatement(signed: Signed<object>, expectedSigner: PublicKey): boolean {
  let sig: Uint8Array;
  try {
    sig = bs58.decode(signed.signature);
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  return verifyEd25519(statementBytes(signed.statement), sig, expectedSigner);
}

export function randomHex(bytes: number): string {
  return bytesToHex(randomBytes(bytes));
}
