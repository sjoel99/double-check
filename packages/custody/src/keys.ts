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
  /**
   * Descarta a chave. `UNUSED`: nunca entrou na chain (cadastro abandonado,
   * troca vetada antes de votar) — pode ser apagada de vez. `ROTATED`: saiu da
   * multisig numa troca — fica guardada para auditoria (produção agendaria a
   * destruição no KMS).
   */
  retire(publicKey: string, reason: RetireReason): Promise<void>;
}

export type RetireReason = "UNUSED" | "ROTATED";

export class DevServerKeyProvider implements ServerKeyProvider {
  private keys = new Map<string, DevMemorySigner>();
  readonly retired = new Set<string>();
  /** Motivo de cada descarte (para os testes conferirem). */
  readonly retiredWhy = new Map<string, RetireReason>();
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
  async retire(publicKey: string, reason: RetireReason) {
    this.retired.add(publicKey);
    this.retiredWhy.set(publicKey, reason);
    this.keys.delete(publicKey);
  }
}

/**
 * Chaves operacionais do serviço: nenhuma vota e nenhuma paga nada — taxa e
 * rent saem da carteira do cliente.
 */
export type ServiceKeys = {
  /** Membro com criar + executar, sem voto: o ÚNICO executor da multisig. Assina, não paga. */
  operator: Signer;
};
