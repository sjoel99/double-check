import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";

/**
 * Quem assina. A chave privada nunca sai da implementação: quem usa só vê a
 * chave pública e recebe assinaturas. Servidor (KMS/HSM/MPC) e app (Keystore,
 * Secure Enclave, passkey via wrapper) implementam a mesma interface.
 */
export interface Signer {
  publicKey(): Promise<PublicKey>;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/** A interface pedida para o lado do servidor é a mesma. */
export type ServerSigner = Signer;

/**
 * Signer de desenvolvimento: chave em memória. Nunca persiste nada. Recusa
 * rodar em mainnet (o chamador passa o cluster).
 */
export class DevMemorySigner implements Signer {
  readonly #keypair: Keypair;

  private constructor(keypair: Keypair, private readonly label: string) {
    this.#keypair = keypair;
  }

  static generate(label: string, cluster: string = "localnet"): DevMemorySigner {
    if (cluster === "mainnet-beta") throw new Error("DevMemorySigner não roda em mainnet");
    return new DevMemorySigner(Keypair.generate(), label);
  }

  /** Só para testes e para a VPS de dev (seed vinda de arquivo fora do repo). */
  static fromSeed(seed: Uint8Array, label: string, cluster: string = "localnet"): DevMemorySigner {
    if (cluster === "mainnet-beta") throw new Error("DevMemorySigner não roda em mainnet");
    return new DevMemorySigner(Keypair.fromSeed(seed), label);
  }

  async publicKey(): Promise<PublicKey> {
    return this.#keypair.publicKey;
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    return ed25519.sign(message, this.#keypair.secretKey.subarray(0, 32));
  }

  /** Impede que o objeto vaze a chave por JSON.stringify ou console.log. */
  toJSON() {
    return { kind: "dev-memory", label: this.label, publicKey: this.#keypair.publicKey.toBase58() };
  }
}

export function verifyEd25519(message: Uint8Array, signature: Uint8Array, publicKey: PublicKey): boolean {
  try {
    return ed25519.verify(signature, message, publicKey.toBytes());
  } catch {
    return false;
  }
}

/** Assina uma VersionedTransaction com cada signer (mensagem serializada). */
export async function signTransaction(tx: VersionedTransaction, signers: Signer[]): Promise<VersionedTransaction> {
  const message = tx.message.serialize();
  for (const signer of signers) {
    const pk = await signer.publicKey();
    tx.addSignature(pk, await signer.sign(message));
  }
  return tx;
}
