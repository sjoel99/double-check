import {
  type AccountInfo,
  type AddressLookupTableAccount,
  Connection,
  PublicKey,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { Cluster } from "@duplachave/shared";
import { type Signer, signTransaction } from "@duplachave/crypto";

export class ChainTxError extends Error {
  constructor(
    message: string,
    public readonly logs: string[],
    /** Nome do erro Anchor/Squads, quando aparece nos logs (ex.: "Unauthorized"). */
    public readonly programError: string | null,
  ) {
    super(message);
    this.name = "ChainTxError";
  }
}

export function programErrorFromLogs(logs: string[]): string | null {
  for (const line of logs) {
    const m = /Error Code: (\w+)/.exec(line);
    if (m) return m[1] ?? null;
  }
  for (const line of logs) {
    if (/missing required signature/i.test(line)) return "MissingRequiredSignature";
  }
  return null;
}

/**
 * O que o sistema precisa da rede. Duas implementações: RPC (validador local,
 * devnet, mainnet) e LiteSVM (testes, em processo, com o binário real da Squads).
 */
export interface Chain {
  readonly cluster: Cluster;
  getAccountInfo(address: PublicKey): Promise<AccountInfo<Buffer> | null>;
  getLatestBlockhash(): Promise<string>;
  /** Envia e espera confirmação. Lança ChainTxError com os logs se falhar. */
  sendTransaction(tx: VersionedTransaction): Promise<string>;
  getBalance(address: PublicKey): Promise<bigint>;
  /** Hora da chain (Clock sysvar), em segundos. */
  now(): Promise<number>;
  getAddressLookupTable?(address: PublicKey): Promise<AddressLookupTableAccount | null>;
  /**
   * Simula instruções como se `payer` (o vault) as assinasse — o mesmo que o
   * programa da Squads faz no execute. Sem verificação de assinatura.
   */
  simulate?(payer: PublicKey, instructions: TransactionInstruction[]): Promise<SimulationResult>;
}

export type SimulationResult = { ok: boolean; error: string | null; logs: string[] };

/** O SDK da Squads pede um `Connection`; isto expõe só o que ele usa. */
export function connectionLike(chain: Chain): Connection {
  const like = {
    getAccountInfo: (pk: PublicKey) => chain.getAccountInfo(pk),
    getAddressLookupTable: async (pk: PublicKey) => ({
      context: { slot: 0 },
      value: chain.getAddressLookupTable ? await chain.getAddressLookupTable(pk) : null,
    }),
  };
  return like as unknown as Connection;
}

export async function buildTransaction(
  chain: Chain,
  payer: PublicKey,
  instructions: TransactionInstruction[],
  lookupTables: AddressLookupTableAccount[] = [],
): Promise<VersionedTransaction> {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: await chain.getLatestBlockhash(),
    instructions,
  }).compileToV0Message(lookupTables);
  return new VersionedTransaction(message);
}

/** Monta, assina (primeiro signer paga a taxa) e envia. */
export async function sendInstructions(
  chain: Chain,
  instructions: TransactionInstruction[],
  signers: Signer[],
  lookupTables: AddressLookupTableAccount[] = [],
): Promise<string> {
  const [payer] = signers;
  if (!payer) throw new Error("sem pagador");
  const tx = await buildTransaction(chain, await payer.publicKey(), instructions, lookupTables);
  await signTransaction(tx, signers);
  return chain.sendTransaction(tx);
}

export class RpcChain implements Chain {
  readonly connection: Connection;

  constructor(
    rpcUrl: string,
    readonly cluster: Cluster,
  ) {
    this.connection = new Connection(rpcUrl, "confirmed");
  }

  getAccountInfo(address: PublicKey) {
    return this.connection.getAccountInfo(address, "confirmed");
  }

  async getLatestBlockhash() {
    return (await this.connection.getLatestBlockhash("confirmed")).blockhash;
  }

  async sendTransaction(tx: VersionedTransaction): Promise<string> {
    const sim = await this.connection.simulateTransaction(tx, { sigVerify: true, commitment: "confirmed" });
    if (sim.value.err) {
      const logs = sim.value.logs ?? [];
      throw new ChainTxError(`simulação falhou: ${JSON.stringify(sim.value.err)}`, logs, programErrorFromLogs(logs));
    }
    const sig = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    const latest = await this.connection.getLatestBlockhash("confirmed");
    const res = await this.connection.confirmTransaction(
      { signature: sig, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
      "confirmed",
    );
    if (res.value.err) {
      const info = await this.connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      const logs = info?.meta?.logMessages ?? [];
      throw new ChainTxError(`transação falhou: ${JSON.stringify(res.value.err)}`, logs, programErrorFromLogs(logs));
    }
    return sig;
  }

  async getBalance(address: PublicKey) {
    return BigInt(await this.connection.getBalance(address, "confirmed"));
  }

  async now() {
    const slot = await this.connection.getSlot("confirmed");
    const t = await this.connection.getBlockTime(slot);
    return t ?? Math.floor(Date.now() / 1000);
  }

  async getAddressLookupTable(address: PublicKey) {
    return (await this.connection.getAddressLookupTable(address)).value;
  }

  async simulate(payer: PublicKey, instructions: TransactionInstruction[]): Promise<SimulationResult> {
    const tx = await buildTransaction(this, payer, instructions);
    const sim = await this.connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
    const logs = sim.value.logs ?? [];
    return { ok: !sim.value.err, error: sim.value.err ? JSON.stringify(sim.value.err) : null, logs };
  }
}
