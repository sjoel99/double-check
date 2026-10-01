import "./polyfills";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { AppProvider, type Config, useApp } from "./app";
import { api } from "./lib/api";
import { type DeviceRecord, ed25519Supported, loadDevice } from "./lib/device";
import { PINNED_CLUSTER } from "./lib/chain";
import { Home } from "./screens/home";
import { IntentScreen, Send } from "./screens/intent";
import { Onboarding } from "./screens/onboarding";
import { Activity, Login, Pair, Rotate, Security } from "./screens/security";

function Router() {
  const { route, device } = useApp();
  const [path, query = ""] = route.split("?");
  const q = new URLSearchParams(query);
  if (path === "/pair" && q.get("r") && q.get("c")) return <Pair r={q.get("r")!} c={q.get("c")!} />;
  if (!device) return <Onboarding />;
  if (!device.session) return <Login />;
  if (path === "/send") return <Send />;
  if (path?.startsWith("/intent/")) return <IntentScreen key={path} id={path.slice("/intent/".length)} />;
  if (path === "/security") return <Security />;
  if (path === "/rotate") return <Rotate />;
  if (path === "/activity") return <Activity />;
  return <Home />;
}

function Boot() {
  const [state, setState] = useState<{ config: Config; device: DeviceRecord | null } | { error: string } | null>(null);
  useEffect(() => {
    (async () => {
      if (!(await ed25519Supported())) return setState({ error: "Este navegador não tem Ed25519 no WebCrypto (Chrome 137+, Firefox 129+, Safari 17+). Sem isso a chave não pode ficar protegida." });
      try {
        const [config, device] = await Promise.all([api<Config>("GET", "/v1/config", undefined, { auth: false }), loadDevice()]);
        if (config.cluster !== PINNED_CLUSTER) return setState({ error: `A API está em ${config.cluster}, mas este app foi feito para ${PINNED_CLUSTER}. Não continue.` });
        setState({ config, device });
      } catch (e) {
        setState({ error: `API indisponível: ${(e as Error).message}. Rode \`pnpm dev\` na raiz do projeto.` });
      }
    })();
  }, []);
  if (!state) return <div className="app"><div className="page" style={{ alignItems: "center", justifyContent: "center" }}><span className="spinner" /></div></div>;
  if ("error" in state) return <div className="app"><div className="page" style={{ justifyContent: "center" }}><div className="banner danger">{state.error}</div></div></div>;
  return (
    <AppProvider config={state.config} initialDevice={state.device}>
      <div className="app">
        <Router />
      </div>
    </AppProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
);
