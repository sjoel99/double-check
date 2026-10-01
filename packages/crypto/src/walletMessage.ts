import { PublicKey, VersionedMessage } from "@solana/web3.js";
import bs58 from "bs58";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { verifyEd25519 } from "./signer";

/**
 * Mensagens que a carteira comum (Phantom, Backpack, Solflare…) assina com
 * `signMessage`. São texto puro, porque a carteira mostra o texto na própria
 * janela: o usuário lê o que está assinando fora do nosso app.
 *
 * O servidor nunca "interpreta" o texto recebido: ele remonta o texto esperado
 * a partir do desafio que emitiu e confere a assinatura sobre esses bytes.
 * Começam com "Dupla Chave\n" — as carteiras recusam assinar mensagem que seja
 * uma transação válida, e um texto assim não é.
 */

export type PossessionOperation = "ENROLL_CLIENT_KEY" | "ROTATE_CLIENT_KEY" | "ROTATE_SERVER_KEY";

const OPERATION_TEXT: Record<PossessionOperation, string> = {
  ENROLL_CLIENT_KEY: "Vincular esta carteira a uma conta nova 2 de 2.",
  ROTATE_CLIENT_KEY: "Esta carteira vai substituir a carteira atual da conta.",
  ROTATE_SERVER_KEY: "Nova chave do serviço para esta conta.",
};

export type PossessionFields = {
  operation: PossessionOperation;
  publicKey: string;
  /** Multisig da conta; "nova" no cadastro. */
  account: string;
  cluster: string;
  challenge: string;
  expiresAt: number;
};

const iso = (t: number) => new Date(t * 1000).toISOString().replace(".000Z", "Z");

export function possessionMessage(f: PossessionFields): string {
  return [
    "Dupla Chave",
    OPERATION_TEXT[f.operation],
    "",
    `Carteira: ${f.publicKey}`,
    `Conta: ${f.account}`,
    `Rede: ${f.cluster}`,
    `Operação: ${f.operation}`,
    `Desafio: ${f.challenge}`,
    `Válido até: ${iso(f.expiresAt)}`,
  ].join("\n");
}

export function loginMessage(f: { publicKey: string; cluster: string; challenge: string; expiresAt: number }): string {
  return [
    "Dupla Chave",
    "Entrar na sua conta. Isto não aprova nenhuma transação.",
    "",
    `Carteira: ${f.publicKey}`,
    `Rede: ${f.cluster}`,
    `Desafio: ${f.challenge}`,
    `Válido até: ${iso(f.expiresAt)}`,
  ].join("\n");
}

/**
 * Vínculo de uma biometria (passkey) à conta: a carteira atual assina este
 * texto, que ela mostra. `credential` = primeiros 16 hex do sha256 do id da credencial.
 */
export function passkeyBindingMessage(f: { publicKey: string; account: string; cluster: string; credential: string; device: string; challenge: string }): string {
  return [
    "Dupla Chave",
    "Ativar a confirmação por biometria neste aparelho.",
    "",
    `Carteira: ${f.publicKey}`,
    `Conta: ${f.account}`,
    `Rede: ${f.cluster}`,
    `Biometria: ${f.credential}`,
    `Aparelho: ${f.device}`,
    `Desafio: ${f.challenge}`,
  ].join("\n");
}

export function verifyWalletMessage(message: string, signatureB58: string, publicKey: string): boolean {
  let sig: Uint8Array;
  try {
    sig = bs58.decode(signatureB58);
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  return verifyEd25519(utf8ToBytes(message), sig, new PublicKey(publicKey));
}

export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/**
 * Prova de posse como fica guardada e como o app a recebe (tudo público).
 * - via "message": a carteira assinou o texto com signMessage (extensão).
 * - via "transaction": a carteira assinou uma transação com um memo contendo o
 *   mesmo texto (celular via Solana Pay, que não tem signMessage). Guarda-se a
 *   mensagem da transação e a assinatura da carteira: dá para conferir offline.
 */
export type WalletProof = PossessionFields & { signature: string } & ({ via?: "message" } | { via: "transaction"; transactionMessage: string });

export function verifyWalletProof(p: WalletProof): boolean {
  const text = possessionMessage(p);
  if (p.via !== "transaction") return verifyWalletMessage(text, p.signature, p.publicKey);
  try {
    const bytes = Uint8Array.from(atob(p.transactionMessage), (c) => c.charCodeAt(0));
    const sig = bs58.decode(p.signature);
    const signer = new PublicKey(p.publicKey);
    if (sig.length !== 64 || !verifyEd25519(bytes, sig, signer)) return false;
    return memoSignedBy(VersionedMessage.deserialize(bytes), text, signer);
  } catch {
    return false;
  }
}

/** A mensagem tem um memo com exatamente este texto, com `signer` entre os signatários dele. */
export function memoSignedBy(msg: VersionedMessage, text: string, signer: PublicKey): boolean {
  const keys = msg.staticAccountKeys;
  if (msg.addressTableLookups.length) return false;
  const signerIdx = keys.findIndex((k) => k.equals(signer));
  if (signerIdx < 0 || signerIdx >= msg.header.numRequiredSignatures) return false;
  const want = utf8ToBytes(text);
  return msg.compiledInstructions.some((ix) => {
    const prog = keys[ix.programIdIndex];
    if (!prog?.equals(MEMO_PROGRAM_ID)) return false;
    const data = ix.data;
    return data.length === want.length && data.every((b, i) => b === want[i]) && ix.accountKeyIndexes.includes(signerIdx);
  });
}
