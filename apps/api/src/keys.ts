import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { join } from "node:path";
import { DevMemorySigner, type ServerSigner } from "@duplachave/crypto";
import type { ServerKeyProvider } from "@duplachave/custody";
import type { Cluster } from "@duplachave/shared";

/**
 * "KMS" de desenvolvimento: seeds cifradas com AES-256-GCM em arquivos 0600.
 * Produção troca por KMS/HSM/MPC atrás da mesma interface — a assinatura
 * acontece lá dentro e a seed nunca chega à aplicação.
 */
export class DevFileKeyStore {
  constructor(
    private readonly dir: string,
    private readonly kek: Buffer,
    private readonly cluster: Cluster,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  private path(label: string) {
    return join(this.dir, `${label.replace(/[^a-zA-Z0-9_.-]/g, "_")}.key`);
  }

  private seal(seed: Uint8Array) {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.kek, iv);
    const ct = Buffer.concat([c.update(seed), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
  }

  private open(blob: string) {
    const b = Buffer.from(blob, "base64");
    const d = createDecipheriv("aes-256-gcm", this.kek, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]);
  }

  load(label: string): DevMemorySigner | null {
    const p = this.path(label);
    if (!existsSync(p)) return null;
    return DevMemorySigner.fromSeed(this.open(readFileSync(p, "utf8")), label, this.cluster);
  }

  save(label: string, seed: Uint8Array) {
    const p = this.path(label);
    if (existsSync(p)) throw new Error(`chave ${label} já existe`);
    writeFileSync(p, this.seal(seed), { mode: 0o600 });
    chmodSync(p, 0o600);
  }

  loadOrCreate(label: string): DevMemorySigner {
    const found = this.load(label);
    if (found) return found;
    const seed = randomBytes(32);
    this.save(label, seed);
    return DevMemorySigner.fromSeed(seed, label, this.cluster);
  }

  /** Mantém o arquivo (renomeado) para auditoria; produção agendaria destruição no KMS. */
  retire(label: string) {
    const p = this.path(label);
    if (existsSync(p)) renameSync(p, `${p}.retired`);
  }

  labels() {
    return readdirSync(this.dir).filter((f) => f.endsWith(".key")).map((f) => f.slice(0, -4));
  }
}

/** Chaves do servidor por conta, no DevFileKeyStore (ou só em memória sem KEK). */
export class FileServerKeyProvider implements ServerKeyProvider {
  private cache = new Map<string, DevMemorySigner>();
  private constructor(
    private readonly store: DevFileKeyStore | null,
    private readonly cluster: Cluster,
  ) {}

  static async open(store: DevFileKeyStore | null, cluster: Cluster) {
    const p = new FileServerKeyProvider(store, cluster);
    if (store) {
      for (const label of store.labels().filter((l) => l.startsWith("server-"))) {
        const s = store.load(label)!;
        p.cache.set((await s.publicKey()).toBase58(), s);
      }
    }
    return p;
  }

  async create(_label: string): Promise<ServerSigner> {
    const seed = randomBytes(32);
    const s = DevMemorySigner.fromSeed(seed, "server", this.cluster);
    const pk = (await s.publicKey()).toBase58();
    this.store?.save(`server-${pk}`, seed);
    seed.fill(0);
    this.cache.set(pk, s);
    return s;
  }

  async get(publicKey: string) {
    return this.cache.get(publicKey) ?? null;
  }

  async retire(publicKey: string) {
    this.cache.delete(publicKey);
    this.store?.retire(`server-${publicKey}`);
  }
}
