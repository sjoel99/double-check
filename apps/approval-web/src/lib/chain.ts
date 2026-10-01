import type { AccountInfo, PublicKey } from "@solana/web3.js";
import { RpcChain, type Chain } from "@duplachave/solana";
import type { Cluster } from "@duplachave/shared";

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
    if (!same) throw new Error(`as duas RPCs divergem sobre ${pk.toBase58()}: não aprove nada`);
    return x;
  }
  getLatestBlockhash() { return this.a.getLatestBlockhash(); }
  sendTransaction(): Promise<string> { throw new Error("o app não envia transações"); }
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
  return v.toLocaleString("pt-BR", { maximumFractionDigits: max });
}
