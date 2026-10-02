import { z } from "zod";
import * as multisig from "@sqds/multisig";

const Env = z.object({
  PORT: z.coerce.number().default(8787),
  HOST: z.string().default("127.0.0.1"),
  SOLANA_RPC_URL: z.string().url().default("http://127.0.0.1:8899"),
  SOLANA_CLUSTER: z.enum(["localnet", "devnet", "mainnet-beta"]).default("localnet"),
  SQUADS_PROGRAM_ID: z.string().default(multisig.PROGRAM_ID.toBase58()),
  DATABASE_URL: z.string().optional(),
  /** URL HTTPS pública do app (túnel), para o QR "continuar no celular". Também vira origem aceita da biometria. */
  DK_PUBLIC_URL: z.string().url().optional(),
  /** Segundos entre o pedido de uma troca de chave e a execução. Padrão 72 h. */
  DK_SECURITY_DELAY: z.coerce.number().int().positive().optional(),
  /** Segredo das sessões HTTP. Sessão não autoriza nada sozinha. */
  DK_SESSION_SECRET: z.string().min(32).optional(),
  /** Token do painel administrativo (só pede rotação da chave do servidor; não aprova nada). */
  DK_ADMIN_TOKEN: z.string().min(16).optional(),
  /** Resend (alertas por e-mail). Sem a chave, os alertas só vão para o log. */
  RESEND_API_KEY: z.string().min(10).optional(),
  /** Remetente, num domínio verificado na Resend. Ex.: "Dupla Chave <alertas@sjoel99.com>". */
  DK_EMAIL_FROM: z.string().min(3).optional(),
  /** Pasta das chaves de serviço em dev (fora do repo, 0600). */
  DK_KEYS_DIR: z.string().default(".data/keys"),
  /** Chave (hex, 32 bytes) que cifra as seeds em DK_KEYS_DIR. Sem ela, chaves só em memória. */
  DK_KEY_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = Env.parse(env);
  if (cfg.SOLANA_CLUSTER === "mainnet-beta") {
    throw new Error("mainnet desabilitada nesta versão: chaves de serviço ainda são de desenvolvimento (sem KMS/HSM)");
  }
  if (cfg.SQUADS_PROGRAM_ID !== multisig.PROGRAM_ID.toBase58()) {
    throw new Error(`SQUADS_PROGRAM_ID ${cfg.SQUADS_PROGRAM_ID} diferente do programa do SDK (${multisig.PROGRAM_ID.toBase58()})`);
  }
  if (cfg.RESEND_API_KEY && !cfg.DK_EMAIL_FROM) throw new Error("RESEND_API_KEY sem DK_EMAIL_FROM (remetente num domínio verificado na Resend)");
  return cfg;
}
