import { type AccountInfo, Connection, type PublicKey } from "@solana/web3.js";
import { RpcChain, type Chain } from "@duplachave/solana";
import type { Cluster } from "@duplachave/shared";
import { locale, tr } from "./i18n";

/**
 * RPC e cluster que o app usa para conferir a chain: FIXOS NO BUILD, nunca
 * vindos da API. Se a API indicasse a RPC, um backend comprometido apontaria o
 * app para uma RPC que mente sobre a transação no índice — e o voto do cliente,
 * que só referencia o índice, aprovaria outra coisa.
 *
 * VITE_RPC_URL_2 (opcional): segunda RPC independente; as contas lidas têm que
 * ser idênticas nas duas.
 */
export const PINNED_CLUSTER = (import.meta.env.VITE_CLUSTER ?? "localnet") as Cluster;
const RPC_1 = import.meta.env.VITE_RPC_URL ?? "/rpc";
const RPC_2 = import.meta.env.VITE_RPC_URL_2 as string | undefined;

class QuorumChain implements Chain {
  readonly cluster: Cluster;
  constructor(private readonly a: RpcChain, private readonly b: RpcChain) {
    this.cluster = a.cluster;
  }
  async getAccountInfo(pk: PublicKey): Promise<AccountInfo<Buffer> | null> {
    const [x, y] = await Promise.all([this.a.getAccountInfo(pk), this.b.getAccountInfo(pk)]);
    const same = (!x && !y) || (x && y && x.owner.equals(y.owner) && Buffer.from(x.data).equals(Buffer.from(y.data)));
    if (!same) throw new Error(tr(`as duas RPCs divergem sobre ${pk.toBase58()}: não aprove nada`, `the two RPCs disagree about ${pk.toBase58()}: do not approve anything`));
    return x;
  }
  getLatestBlockhash() { return this.a.getLatestBlockhash(); }
  sendTransaction(): Promise<string> { throw new Error(tr("o app não envia transações", "the app does not send transactions")); }
  getBalance(pk: PublicKey) { return this.a.getBalance(pk); }
  now() { return this.a.now(); }
}

let chain: Chain | null = null;

export function appChain(): Chain {
  if (!chain) {
    const one = new RpcChain(new URL(RPC_1, location.origin).toString(), PINNED_CLUSTER);
    chain = RPC_2 ? new QuorumChain(one, new RpcChain(new URL(RPC_2, location.origin).toString(), PINNED_CLUSTER)) : one;
  }
  return chain;
}

export const now = () => Math.floor(Date.now() / 1000);
export const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;

export function sol(lamports: string | bigint | number, max = 4): string {
  const v = Number(BigInt(lamports.toString())) / 1e9;
  return v.toLocaleString(locale, { maximumFractionDigits: max });
}

/** "1,5" ou "1.5" → lamports; null se não for um valor com até 9 casas. */
export function parseSol(input: string): bigint | null {
  const s = input.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,9})?$/.test(s)) return null;
  const [i, f = ""] = s.split(".");
  return BigInt(i!) * 1_000_000_000n + BigInt(f.padEnd(9, "0"));
}

/** lamports → texto para o campo ("1,5" em pt, "1.5" em en), sem perder casas; parseSol aceita os dois. */
export function solInput(lamports: bigint): string {
  const f = (lamports % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return f ? `${lamports / 1_000_000_000n}${tr(",", ".")}${f}` : `${lamports / 1_000_000_000n}`;
}

/**
 * Envia uma transação já assinada pela carteira (paga por ela) pela RPC fixada
 * e espera confirmar consultando o status (o proxy local não repassa websocket).
 */
export async function sendSigned(transactionB64: string): Promise<string> {
  const conn = new Connection(new URL(RPC_1, location.origin).toString(), "confirmed");
  const raw = Uint8Array.from(atob(transactionB64), (c) => c.charCodeAt(0));
  const sig = await conn.sendRawTransaction(raw, { preflightCommitment: "confirmed" });
  for (let i = 0; i < 60; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(tr(`a transação falhou: ${JSON.stringify(st.err)}`, `the transaction failed: ${JSON.stringify(st.err)}`));
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(tr("a transação não confirmou a tempo; confira o saldo antes de tentar de novo", "the transaction did not confirm in time; check your balance before trying again"));
}
