import { DevMemorySigner, type ServerSigner, type Signer } from "@duplachave/crypto";
import type { Cluster } from "@duplachave/shared";

/**
 * Onde moram as chaves do servidor. Produção: KMS/HSM/MPC — a interface só
 * expõe chave pública e assinatura; nada aqui devolve material secreto.
 */
export interface ServerKeyProvider {
  /** Gera uma chave nova (para conta nova ou rotação). Ainda não é membro de nada. */
  create(label: string): Promise<ServerSigner>;
  /** Signer de uma chave pública conhecida. */
  get(publicKey: string): Promise<ServerSigner | null>;
  /** Apaga/agenda destruição da chave (depois de removida on-chain). */
  retire(publicKey: string): Promise<void>;
}

export class DevServerKeyProvider implements ServerKeyProvider {
  private keys = new Map<string, DevMemorySigner>();
  readonly retired = new Set<string>();
  constructor(private readonly cluster: Cluster) {}
  async create(label: string) {
    const s = DevMemorySigner.generate(label, this.cluster);
    this.keys.set((await s.publicKey()).toBase58(), s);
    return s;
  }
  async get(publicKey: string) {
    if (this.retired.has(publicKey)) return null;
    return this.keys.get(publicKey) ?? null;
  }
  async retire(publicKey: string) {
    this.retired.add(publicKey);
    this.keys.delete(publicKey);
  }
}

/**
 * Chaves operacionais do serviço: nenhuma vota e nenhuma paga nada — taxa e
 * rent saem da carteira do cliente.
 */
export type ServiceKeys = {
  /** Membro só com Execute (reserva: a carteira do cliente executa na transação atômica). */
  executor: Signer;
  /** Membro só com Initiate: cria a transação da Squads (assina, não paga). */
  proposer: Signer;
};
