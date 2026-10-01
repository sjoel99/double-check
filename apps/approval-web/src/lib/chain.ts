import { RpcChain } from "@duplachave/solana";
import type { Cluster } from "@duplachave/shared";

let chain: RpcChain | null = null;

/** Chain que o app usa para conferir — RPC própria, não a API. */
export function appChain(cluster: Cluster, rpcUrl: string): RpcChain {
  if (!chain) chain = new RpcChain(new URL(rpcUrl, location.origin).toString(), cluster);
  return chain;
}

export const now = () => Math.floor(Date.now() / 1000);
export const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;

export function sol(lamports: string | bigint | number, max = 4): string {
  const v = Number(BigInt(lamports.toString())) / 1e9;
  return v.toLocaleString("pt-BR", { maximumFractionDigits: max });
}
