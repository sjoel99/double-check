// Sobe o ambiente local: validador (surfpool), API (8787) e Approval App (5173). Ctrl+C derruba tudo.
//   pnpm dev                      # surfpool OFFLINE com o ELF do Squads v4 das fixtures (padrão)
//   SURFPOOL_FORK=1 pnpm dev      # surfpool como fork da mainnet (busca contas no RPC público)
//   SOLANA_RPC_URL=... pnpm dev   # usa uma RPC já existente (não sobe surfpool)
//
// Por que offline por padrão: no modo fork, cada conta que não existe localmente
// (chave nova, vault novo) vira uma consulta ao RPC público da mainnet, que limita
// por IP e responde "Internal error" — a aprovação falhava de forma intermitente.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
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

async function rpcCall(method: string, params: unknown[]) {
  const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

const SQUADS = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";

/** Carrega no surfpool o ELF do Squads v4 e o ProgramConfig (fixtures baixadas da mainnet). */
async function loadSquads() {
  const info = (await rpcCall("getAccountInfo", [SQUADS, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }])) as { value: unknown };
  if (info.value) return;
  const elf = readFileSync("fixtures/squads_multisig_program.so");
  const cfg = JSON.parse(readFileSync("fixtures/program_config.json", "utf8"));
  await rpcCall("surfnet_setAccount", [SQUADS, { lamports: 1_000_000_000, data: elf.toString("hex"), owner: "BPFLoader2111111111111111111111111111111111", executable: true }]);
  await rpcCall("surfnet_setAccount", [cfg.address, { lamports: cfg.lamports, data: Buffer.from(cfg.data, "base64").toString("hex"), owner: cfg.owner, executable: false }]);
  await rpcCall("surfnet_setAccount", [cfg.treasury, { lamports: 1_000_000_000, data: "", owner: "11111111111111111111111111111111", executable: false }]);
  log("Squads v4 carregado das fixtures (sha256 em fixtures/ORIGEM.md)");
}

if (!(await rpcUp(rpc))) {
  if (process.env.SOLANA_RPC_URL) throw new Error(`RPC ${rpc} não responde`);
  const surfpool = [`${homedir()}/.local/bin/surfpool`, "/usr/local/bin/surfpool"].find(existsSync) ?? "surfpool";
  const fork = process.env.SURFPOOL_FORK === "1";
  log(`subindo surfpool (${fork ? "fork da mainnet" : "offline"}) — log em .data/surfpool.log`);
  run("surfpool", surfpool, ["start", ...(fork ? ["--network", "mainnet"] : ["--offline"]), "--no-tui", "--no-deploy", "-y"], {}, true);
  for (let i = 0; i < 60 && !(await rpcUp(rpc)); i++) await new Promise((r) => setTimeout(r, 500));
  if (!(await rpcUp(rpc))) throw new Error("surfpool não subiu; veja .data/surfpool.log");
  if (!fork) await loadSquads();
} else {
  log(`RPC já no ar em ${rpc}`);
  if (!process.env.SOLANA_RPC_URL) await loadSquads().catch((e) => log(`não carreguei o Squads: ${String(e)}`));
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
