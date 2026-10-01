import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import { PublicKey, type TransactionInstruction, type VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import * as multisig from "@sqds/multisig";
import { buildTransaction, ChainTxError, type Chain, programErrorFromLogs } from "@duplachave/solana";

const root = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Chain em processo: LiteSVM com o ELF do Squads v4 baixado da mainnet
 * (fixtures/ORIGEM.md). Assinaturas são verificadas de verdade (sigverify on).
 */
export class LiteSvmChain implements Chain {
  readonly cluster = "localnet" as const;
  readonly svm: LiteSVM;
  readonly treasury: PublicKey;

  constructor() {
    this.svm = new LiteSVM().withSigverify(true).withBlockhashCheck(true);
    this.svm.addProgramFromFile(multisig.PROGRAM_ID, `${root}fixtures/squads_multisig_program.so`);
    const cfg = JSON.parse(readFileSync(`${root}fixtures/program_config.json`, "utf8"));
    this.svm.setAccount(new PublicKey(cfg.address), {
      lamports: cfg.lamports,
      data: Buffer.from(cfg.data, "base64"),
      owner: new PublicKey(cfg.owner),
      executable: false,
    });
    this.treasury = new PublicKey(cfg.treasury);
    this.svm.airdrop(this.treasury, 1_000_000_000n);
  }

  async getAccountInfo(address: PublicKey) {
    const a = this.svm.getAccount(address);
    if (!a) return null;
    return { ...a, data: Buffer.from(a.data) };
  }

  async getLatestBlockhash() {
    return this.svm.latestBlockhash();
  }

  async sendTransaction(tx: VersionedTransaction): Promise<string> {
    const res = this.svm.sendTransaction(tx);
    // Blockhash novo a cada envio: duas transações idênticas não colidem.
    this.svm.expireBlockhash();
    if (res instanceof FailedTransactionMetadata) {
      const logs = res.meta().logs();
      throw new ChainTxError(`transação falhou: ${res.err().toString()}`, logs, programErrorFromLogs(logs) ?? res.err().toString());
    }
    return bs58.encode(tx.signatures[0]!);
  }

  async getBalance(address: PublicKey) {
    return this.svm.getBalance(address) ?? 0n;
  }

  async now() {
    return Number(this.svm.getClock().unixTimestamp);
  }

  async simulate(payer: PublicKey, instructions: TransactionInstruction[]) {
    const tx = await buildTransaction(this, payer, instructions);
    this.svm.withSigverify(false);
    try {
      const r = this.svm.simulateTransaction(tx);
      if (r instanceof FailedTransactionMetadata) return { ok: false, error: r.err().toString(), logs: r.meta().logs() };
      return { ok: true, error: null, logs: r.meta().logs() };
    } finally {
      this.svm.withSigverify(true);
    }
  }

  airdrop(address: PublicKey, lamports: bigint) {
    this.svm.airdrop(address, lamports);
  }

  /** Avança o relógio da chain. */
  warp(seconds: number) {
    const clock = this.svm.getClock();
    clock.unixTimestamp += BigInt(seconds);
    clock.slot += BigInt(Math.max(1, Math.floor(seconds * 2.5)));
    this.svm.setClock(clock);
  }
}
