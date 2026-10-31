import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Em dev: /api → API (8787) e /rpc → validador (surfpool, 8899).
// O app lê a chain pela /rpc — não pela API — para conferir o que a API diz.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const api = env.API_UPSTREAM ?? "http://127.0.0.1:8787";
  const rpc = env.RPC_UPSTREAM ?? "http://127.0.0.1:8899";
  const proxy = {
    "/api": { target: api, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/api/, "") },
    // Para a RPC vão só os cabeçalhos essenciais: pelo túnel chegam cabeçalhos da Cloudflare
    // (cf-*, x-forwarded-*, origin do túnel) que a RPC pública da devnet recusa.
    "/rpc": {
      target: rpc,
      changeOrigin: true,
      rewrite: () => "",
      configure: (proxy: { on: (ev: "proxyReq", fn: (req: { getHeaderNames(): string[]; removeHeader(h: string): void }) => void) => void }) =>
        proxy.on("proxyReq", (req) => {
          for (const h of req.getHeaderNames()) if (!["host", "content-type", "content-length", "accept"].includes(h)) req.removeHeader(h);
        }),
    },
  };
  return {
    plugins: [react()],
    define: { global: "globalThis" },
    // `require("buffer")` em dependências CommonJS (safe-buffer, via jayson/rpc-websockets) tem que cair
    // no pacote npm `buffer`, não no builtin do Node, que o Vite troca por um módulo vazio no navegador.
    // O caminho absoluto força o pacote. Sem isto, `Buffer.from` é undefined e a página morre ao carregar.
    resolve: { alias: { buffer: fileURLToPath(new URL("./node_modules/buffer/index.js", import.meta.url)) } },
    // O túnel (pnpm dev:devnet) chega com o host *.trycloudflare.com.
    server: { port: 5173, host: env.DK_WEB_HOST ?? "127.0.0.1", proxy, allowedHosts: [".trycloudflare.com", "localhost"] },
    preview: { port: 4173, proxy },
    build: {
      sourcemap: false,
      rolldownOptions: {
        output: {
          // Bibliotecas da Solana em chunks próprios: mudam pouco e ficam em cache entre deploys do app.
          // `squads` (SDK da Squads e o que só ele usa) separado de `solana` (web3.js e base): a Home só
          // precisa do segundo; o primeiro baixa quando a pessoa vai enviar, depositar ou mexer em segurança.
          codeSplitting: {
            groups: [
              // O polyfill do Buffer tem que rodar ANTES do chunk da Solana (web3.js usa `Buffer` ao
              // carregar). `main.tsx` importa `./polyfills` primeiro; num chunk próprio, ele avalia
              // antes dos outros. Dentro do chunk `solana` ele rodaria depois do web3.js e a página morria.
              { name: "polyfills", test: /src[\\/]polyfills\.ts$|node_modules[\\/](buffer|ieee754|base64-js)[\\/]/, priority: 3 },
              { name: "solana", test: /node_modules[\\/](@solana|@noble|bn\.js|borsh|jayson|rpc-websockets|superstruct|bs58|base-x)[\\/]/, priority: 2 },
              { name: "squads", test: /node_modules[\\/](@sqds|@metaplex-foundation|@coral-xyz|bigint-buffer|buffer-layout)[\\/]/, priority: 1 },
            ],
          },
        },
      },
    },
  };
});
