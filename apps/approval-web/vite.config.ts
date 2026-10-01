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
    "/rpc": { target: rpc, changeOrigin: true, rewrite: () => "" },
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
