import { randomBytes } from "node:crypto";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { DevMemorySigner } from "@duplachave/crypto";
import { RpcChain } from "@duplachave/solana";
import { DefaultPolicyEngine } from "@duplachave/policy-engine";
import { CustodyService, LogNotificationService, MemoryStore } from "@duplachave/custody";
import { migrate, openPostgres, PgStore } from "@duplachave/database";
import { loadConfig } from "./config";
import { DevFileKeyStore, FileServerKeyProvider } from "./keys";
import { buildServer } from "./server";

const cfg = loadConfig();
const chain = new RpcChain(cfg.SOLANA_RPC_URL, cfg.SOLANA_CLUSTER);
const log = (m: string) => console.log(`[duplachave] ${m}`);

const store = cfg.DATABASE_URL
  ? await (async () => {
      const db = await openPostgres(cfg.DATABASE_URL!);
      await migrate(db);
      return new PgStore(db);
    })()
  : new MemoryStore();
log(cfg.DATABASE_URL ? "banco: Postgres" : "banco: memória (some ao reiniciar — combina com o surfpool, que também é efêmero)");

const keyStore = cfg.DK_KEY_ENCRYPTION_KEY ? new DevFileKeyStore(cfg.DK_KEYS_DIR, Buffer.from(cfg.DK_KEY_ENCRYPTION_KEY, "hex"), cfg.SOLANA_CLUSTER) : null;
if (!keyStore) log("chaves de serviço só em memória (defina DK_KEY_ENCRYPTION_KEY para persistir em DK_KEYS_DIR)");
const svc = (label: string) => keyStore?.loadOrCreate(label) ?? DevMemorySigner.generate(label, cfg.SOLANA_CLUSTER);
const service = { executor: svc("executor"), proposer: svc("proposer"), feePayer: svc("fee-payer") };
const serverKeys = await FileServerKeyProvider.open(keyStore, cfg.SOLANA_CLUSTER);

const feePayer = await service.feePayer.publicKey();
const conn = chain.connection;
const airdrop = async (address: PublicKey, lamports: number) => {
  const sig = await conn.requestAirdrop(address, lamports);
  await conn.confirmTransaction(sig, "confirmed");
};
if (cfg.SOLANA_CLUSTER !== "devnet" || (await chain.getBalance(feePayer)) < BigInt(LAMPORTS_PER_SOL) / 10n) {
  try {
    if ((await chain.getBalance(feePayer)) < 5n * BigInt(LAMPORTS_PER_SOL)) await airdrop(feePayer, 10 * LAMPORTS_PER_SOL);
  } catch (e) {
    log(`não consegui airdrop para o pagador ${feePayer.toBase58()}: ${String(e)} — financie manualmente`);
  }
}
const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(conn, multisig.getProgramConfigPda({})[0]);

const notifications = new LogNotificationService(log);
const custody = new CustodyService({
  cluster: cfg.SOLANA_CLUSTER,
  chain,
  store,
  policy: new DefaultPolicyEngine(),
  serverKeys,
  service,
  notifications,
  squadsTreasury: programConfig.treasury,
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
  appRpcUrl: cfg.APP_RPC_URL,
  sessionSecret,
  adminToken,
  feePayer: feePayer.toBase58(),
  airdrop: cfg.SOLANA_CLUSTER === "localnet" ? airdrop : undefined,
  log: true,
});

// Expira pendências vencidas (rejeição on-chain) a cada 30 s.
setInterval(async () => {
  for (const id of await store.listAccountIds()) {
    try {
      await custody.expireDue(id);
    } catch (e) {
      log(`expireDue ${id}: ${String(e)}`);
    }
  }
}, 30_000).unref();

await app.listen({ port: cfg.PORT, host: cfg.HOST });
log(`API em http://${cfg.HOST}:${cfg.PORT} · cluster ${cfg.SOLANA_CLUSTER} · RPC ${cfg.SOLANA_RPC_URL.replace(/api-key=[^&]+/, "api-key=***")} · pagador ${feePayer.toBase58()}`);
