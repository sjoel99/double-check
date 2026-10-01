// Sobe o ambiente local: validador (surfpool, fork da mainnet com o Squads v4 real),
// API (8787) e Approval App (5173). Ctrl+C derruba tudo.
//   pnpm dev                      # tudo local
//   SOLANA_RPC_URL=... pnpm dev   # usa uma RPC já existente (não sobe surfpool)
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";

const rpc = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const children: ChildProcess[] = [];
const log = (m: string) => console.log(`\x1b[36m[dev]\x1b[0m ${m}`);

async function rpcUp(url: string) {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }) });
    return r.ok;
  } catch {
    return false;
  }
}

function run(name: string, cmd: string, args: string[], env: Record<string, string> = {}, quiet = false) {
  mkdirSync(".data", { recursive: true });
  const out = quiet ? openSync(`.data/${name}.log`, "a") : "inherit";
  const p = spawn(cmd, args, { stdio: ["ignore", out, out], env: { ...process.env, ...env } });
  p.on("exit", (code) => log(`${name} saiu (${code})`));
  children.push(p);
  return p;
}

const stop = () => {
  for (const c of children) c.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

if (!(await rpcUp(rpc))) {
  if (process.env.SOLANA_RPC_URL) throw new Error(`RPC ${rpc} não responde`);
  const surfpool = [`${homedir()}/.local/bin/surfpool`, "/usr/local/bin/surfpool"].find(existsSync) ?? "surfpool";
  log(`subindo surfpool (fork da mainnet) — log em .data/surfpool.log`);
  run("surfpool", surfpool, ["start", "--network", "mainnet", "--no-tui", "--no-deploy", "-y"], {}, true);
  for (let i = 0; i < 60 && !(await rpcUp(rpc)); i++) await new Promise((r) => setTimeout(r, 500));
  if (!(await rpcUp(rpc))) throw new Error("surfpool não subiu; veja .data/surfpool.log");
} else {
  log(`RPC já no ar em ${rpc}`);
}

log("subindo API em http://127.0.0.1:8787");
run("api", "pnpm", ["--filter", "@duplachave/api", "start"], { SOLANA_RPC_URL: rpc, SOLANA_CLUSTER: process.env.SOLANA_CLUSTER ?? "localnet" });
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch("http://127.0.0.1:8787/healthz")).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
log("subindo Approval App em http://127.0.0.1:5173");
run("web", "pnpm", ["--filter", "@duplachave/approval-web", "dev"], { RPC_UPSTREAM: rpc });
