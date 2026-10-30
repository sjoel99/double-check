import { randomBytes } from "node:crypto";
import type { PublicKey } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { DevMemorySigner } from "@duplachave/crypto";
import { RpcChain } from "@duplachave/solana";
import { DefaultPolicyEngine } from "@duplachave/policy-engine";
import { CustodyService, EmailNotificationService, LogNotificationService, MemoryStore, ResendMailer } from "@duplachave/custody";
import { migrate, openPostgres, PgStore } from "@duplachave/database";
import { loadConfig } from "./config";
import { DevFileKeyStore, FileServerKeyProvider } from "./keys";
import { buildServer } from "./server";

const cfg = loadConfig();
const chain = new RpcChain(cfg.SOLANA_RPC_URL, cfg.SOLANA_CLUSTER);
const log = (m: string) => console.log(`[duplachave] ${m}`);

/** O Postgres pode subir depois da API (Docker): tenta por até ~60 s antes de desistir. */
async function openDatabase(url: string) {
  const db = await openPostgres(url);
  for (let attempt = 1; ; attempt++) {
    try {
      await migrate(db);
      return db;
    } catch (e) {
      if (attempt >= 30) throw e;
      if (attempt === 1) log(`banco ainda não responde (${String((e as Error).message).slice(0, 80)}); tentando de novo…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

const db = cfg.DATABASE_URL ? await openDatabase(cfg.DATABASE_URL) : null;
const store = db ? new PgStore(db) : new MemoryStore();
log(cfg.DATABASE_URL ? "banco: Postgres" : "banco: memória (some ao reiniciar — combina com o surfpool, que também é efêmero)");

const keyStore = cfg.DK_KEY_ENCRYPTION_KEY ? new DevFileKeyStore(cfg.DK_KEYS_DIR, Buffer.from(cfg.DK_KEY_ENCRYPTION_KEY, "hex"), cfg.SOLANA_CLUSTER) : null;
if (!keyStore) log("chaves de serviço só em memória (defina DK_KEY_ENCRYPTION_KEY para persistir em DK_KEYS_DIR)");
const svc = (label: string) => keyStore?.loadOrCreate(label) ?? DevMemorySigner.generate(label, cfg.SOLANA_CLUSTER);
// Nenhuma chave do serviço tem SOL: a carteira do cliente paga taxa e rent.
// Operador: cria e é o único que executa; não vota e não tem SOL.
const service = { operator: svc("operator") };
const serverKeys = await FileServerKeyProvider.open(keyStore, cfg.SOLANA_CLUSTER);

const conn = chain.connection;
const airdrop = async (address: PublicKey, lamports: number) => {
  const sig = await conn.requestAirdrop(address, lamports);
  await conn.confirmTransaction(sig, "confirmed");
};
const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(conn, multisig.getProgramConfigPda({})[0]);

const publicUrl = cfg.DK_PUBLIC_URL ?? "http://127.0.0.1:5173";
// O e-mail do usuário vem do banco a cada envio (só o confirmado).
const notifications =
  cfg.RESEND_API_KEY && cfg.DK_EMAIL_FROM
    ? new EmailNotificationService({
        mailer: new ResendMailer({ apiKey: cfg.RESEND_API_KEY, from: cfg.DK_EMAIL_FROM }),
        appUrl: publicUrl,
        emailOf: async (userId) => (await store.getUser(userId))?.email ?? null,
        log,
      })
    : new LogNotificationService(log);
log(cfg.RESEND_API_KEY ? `alertas por e-mail (Resend, de ${cfg.DK_EMAIL_FROM})` : "alertas só no log (defina RESEND_API_KEY e DK_EMAIL_FROM)");
const custody = new CustodyService({
  cluster: cfg.SOLANA_CLUSTER,
  chain,
  store,
  policy: new DefaultPolicyEngine(),
  serverKeys,
  service,
  notifications,
  squadsTreasury: programConfig.treasury,
  securityDelay: cfg.DK_SECURITY_DELAY,
  log,
});

const sessionSecret = cfg.DK_SESSION_SECRET ?? randomBytes(32).toString("hex");
if (!cfg.DK_SESSION_SECRET) log("DK_SESSION_SECRET ausente: segredo aleatório (sessões caem ao reiniciar)");
const adminToken = cfg.DK_ADMIN_TOKEN ?? (cfg.SOLANA_CLUSTER === "localnet" ? randomBytes(12).toString("hex") : null);
if (!cfg.DK_ADMIN_TOKEN && adminToken) log(`token de admin desta execução: ${adminToken}`);

const app = await buildServer({
  custody,
  store,
  chain,
  cluster: cfg.SOLANA_CLUSTER,
  sessionSecret,
  adminToken,
  publicUrl,
  airdrop: cfg.SOLANA_CLUSTER === "localnet" ? airdrop : undefined,
  log: true,
});

// Concilia com a chain e vence rascunhos a cada 30 s.
const sweeper = setInterval(async () => {
  for (const id of await store.listAccountIds()) {
    try {
      await custody.expireDue(id);
    } catch (e) {
      log(`expireDue ${id}: ${String(e)}`);
    }
  }
}, 30_000);
sweeper.unref();

// Encerramento gracioso (docker stop / restart): para de aceitar conexões, termina as
// respostas em andamento e fecha o banco. Se travar, sai à força depois de 10 s.
let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log(`${signal}: encerrando`);
  const hard = setTimeout(() => process.exit(1), 10_000);
  hard.unref();
  clearInterval(sweeper);
  try {
    await app.close();
    await db?.close?.();
    process.exit(0);
  } catch (e) {
    log(`erro ao encerrar: ${String(e)}`);
    process.exit(1);
  }
};
for (const s of ["SIGTERM", "SIGINT"] as const) process.on(s, () => void shutdown(s));

await app.listen({ port: cfg.PORT, host: cfg.HOST });
if (cfg.DK_PUBLIC_URL) log(`QR do celular abre o app em ${cfg.DK_PUBLIC_URL}/#/m/…`);
else log("sem DK_PUBLIC_URL: o QR só funciona com o celular de teste (celular de verdade exige HTTPS — use pnpm dev:devnet)");
log(`API em http://${cfg.HOST}:${cfg.PORT} · cluster ${cfg.SOLANA_CLUSTER} · RPC ${cfg.SOLANA_RPC_URL.replace(/api-key=[^&]+/, "api-key=***")} · taxas pagas pela carteira do cliente`);
