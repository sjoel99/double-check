import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

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
    // O túnel (pnpm dev:devnet) chega com o host *.trycloudflare.com.
    server: { port: 5173, host: env.DK_WEB_HOST ?? "127.0.0.1", proxy, allowedHosts: [".trycloudflare.com", "localhost"] },
    preview: { port: 4173, proxy },
    build: { sourcemap: false, chunkSizeWarningLimit: 4000 },
  };
});
