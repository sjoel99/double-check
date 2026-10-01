// Ambiente para testar com o celular de verdade (Phantom/Solflare lendo o QR).
//
//   pnpm dev:devnet
//
// - Rede: devnet (a carteira do celular envia a transação para a rede dela; localnet não serve).
// - Túnel HTTPS (cloudflared) para a API: o Solana Pay exige HTTPS que o celular alcance.
// - Postgres em Docker (volume persistente) e chaves de serviço cifradas em .data/devnet-keys:
//   contas e pagador sobrevivem a reinícios.
// - .env.devnet (criado na primeira vez, fora do git) guarda os segredos locais.
//   Opcional: DEVNET_RPC_URL=https://devnet.helius-rpc.com/?api-key=... (mais estável que a pública).
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

const log = (m: string) => console.log(`\x1b[35m[devnet]\x1b[0m ${m}`);
const children: ChildProcess[] = [];
const stop = () => {
  for (const c of children) c.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
mkdirSync(".data", { recursive: true });

// ---------------------------------------------------------------- segredos locais
const ENV = ".env.devnet";
if (!existsSync(ENV)) {
  writeFileSync(
    ENV,
    [
      "# Segredos do ambiente devnet local (não versionado).",
      `DK_KEY_ENCRYPTION_KEY=${randomBytes(32).toString("hex")}`,
      `DK_SESSION_SECRET=${randomBytes(32).toString("hex")}`,
      `DK_ADMIN_TOKEN=${randomBytes(16).toString("hex")}`,
      "DK_KEYS_DIR=.data/devnet-keys",
      "# DEVNET_RPC_URL=https://devnet.helius-rpc.com/?api-key=SUA_CHAVE",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  log(`criei ${ENV} (segredos locais, permissão 600)`);
}
const env: Record<string, string> = {};
for (const line of readFileSync(ENV, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]!] = m[2]!;
}
const rpc = env.DEVNET_RPC_URL || "https://api.devnet.solana.com";
const masked = rpc.replace(/api-key=[^&]+/, "api-key=***");

// ---------------------------------------------------------------- Postgres
let databaseUrl = env.DATABASE_URL;
if (!databaseUrl) {
  try {
    const running = execSync("docker ps --filter name=^dk-pg-devnet$ --format '{{.Names}}'").toString().trim();
    if (!running) {
      const exists = execSync("docker ps -a --filter name=^dk-pg-devnet$ --format '{{.Names}}'").toString().trim();
      if (exists) execSync("docker start dk-pg-devnet");
      else execSync("docker run -d --name dk-pg-devnet -e POSTGRES_PASSWORD=dk -e POSTGRES_DB=dk -p 55433:5432 -v dk-pg-devnet-data:/var/lib/postgresql/data postgres:17-alpine");
      log("Postgres (Docker) subindo em 127.0.0.1:55433");
      for (let i = 0; i < 30; i++) {
        try {
          execSync("docker exec dk-pg-devnet pg_isready -U postgres", { stdio: "ignore" });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    }
    databaseUrl = "postgres://postgres:dk@127.0.0.1:55433/dk";
  } catch {
    log("Docker indisponível: banco em memória (contas somem ao reiniciar)");
  }
}

// ---------------------------------------------------------------- túnel HTTPS
const cloudflared = [`${homedir()}/.local/bin/cloudflared`, "/usr/local/bin/cloudflared", "/usr/bin/cloudflared"].find(existsSync) ?? "cloudflared";
log("abrindo túnel HTTPS para a API (cloudflared)…");
const tunnel = spawn(cloudflared, ["tunnel", "--url", "http://127.0.0.1:8787", "--no-autoupdate"], { stdio: ["ignore", "pipe", "pipe"] });
children.push(tunnel);
const tunnelLog = openSync(".data/cloudflared.log", "a");
const publicUrl = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("túnel não abriu em 40 s; veja .data/cloudflared.log")), 40_000);
  const onData = (b: Buffer) => {
    const s = b.toString();
    try {
      writeSync(tunnelLog, s);
    } catch {}
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(s);
    if (m) {
      clearTimeout(timer);
      resolve(m[0]);
    }
  };
  tunnel.stdout!.on("data", onData);
  tunnel.stderr!.on("data", onData);
});
log(`túnel: ${publicUrl}`);

// ---------------------------------------------------------------- API e app
const apiEnv = {
  ...process.env,
  SOLANA_RPC_URL: rpc,
  SOLANA_CLUSTER: "devnet",
  DK_PUBLIC_URL: publicUrl,
  DK_KEY_ENCRYPTION_KEY: env.DK_KEY_ENCRYPTION_KEY!,
  DK_SESSION_SECRET: env.DK_SESSION_SECRET!,
  DK_ADMIN_TOKEN: env.DK_ADMIN_TOKEN!,
  DK_KEYS_DIR: env.DK_KEYS_DIR ?? ".data/devnet-keys",
  ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
};
log(`API (devnet, RPC ${masked})`);
const api = spawn("pnpm", ["--filter", "@duplachave/api", "start"], { stdio: "inherit", env: apiEnv, cwd: process.cwd() });
children.push(api);
for (let i = 0; i < 80; i++) {
  try {
    if ((await fetch("http://127.0.0.1:8787/healthz")).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
const web = spawn("pnpm", ["--filter", "@duplachave/approval-web", "dev"], { stdio: "inherit", env: { ...process.env, RPC_UPSTREAM: rpc, VITE_CLUSTER: "devnet" } });
children.push(web);

// ---------------------------------------------------------------- pagador de taxas
try {
  const cfg = (await (await fetch("http://127.0.0.1:8787/v1/config")).json()) as { feePayer: string };
  const bal = await new Connection(rpc, "confirmed").getBalance(new PublicKey(cfg.feePayer));
  log(`pagador de taxas do serviço: ${cfg.feePayer} — saldo ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  if (bal < 0.3 * LAMPORTS_PER_SOL) log("⚠ abasteça o pagador com SOL de devnet em https://faucet.solana.com (cole o endereço acima). Cada conta nova custa ~0,01 SOL.");
} catch (e) {
  log(`não consegui ler o pagador: ${String(e)}`);
}
log("abra http://127.0.0.1:5173 no computador; no celular, a Phantom em modo devnet (Configurações → Configurações de desenvolvedor → Modo testnet → Solana Devnet)");
