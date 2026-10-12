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
 * Começam com "Double Check\n" — as carteiras recusam assinar mensagem que seja
 * uma transação válida, e um texto assim não é.
 */

const iso = (t: number) => new Date(t * 1000).toISOString().replace(".000Z", "Z");

export function loginMessage(f: { publicKey: string; cluster: string; challenge: string; expiresAt: number }): string {
  return [
    "Double Check",
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

export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
