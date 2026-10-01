import { PublicKey } from "@solana/web3.js";
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

/** Prova de posse como fica guardada e como o app a recebe (tudo público). */
export type WalletProof = PossessionFields & { signature: string };

export function verifyWalletProof(p: WalletProof): boolean {
  return verifyWalletMessage(possessionMessage(p), p.signature, p.publicKey);
}
