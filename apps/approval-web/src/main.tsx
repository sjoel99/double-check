import "./polyfills";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { AppProvider, type Config, useApp } from "./app";
import { api } from "./lib/api";
import { PINNED_CLUSTER } from "./lib/chain";
import { trace } from "./lib/trace";
import { tr } from "./lib/i18n";
import { isMobile } from "./lib/activation";
import { ed25519Supported, loadSession, type Session } from "./lib/storage";
import { Deposit, Home } from "./screens/home";
import { IntentScreen, Send } from "./screens/intent";
import { Activity, ChangeClient, ChangeWebapp, Security } from "./screens/security";
import { Welcome } from "./screens/welcome";
import { MobileHandoff } from "./screens/handoff";
import { PrfCheck } from "./screens/prfcheck";

// Diagnóstico no celular: erros soltos e quando a página sai/volta (troca para o app da carteira).
if (isMobile()) {
  addEventListener("error", (e) => trace("erro", e.message));
  addEventListener("unhandledrejection", (e) => trace("promessa-rejeitada", e.reason));
  document.addEventListener("visibilitychange", () => trace(`pagina:${document.visibilityState}`));
  trace("pagina:abriu", navigator.userAgent);
}

function Router() {
  const { route, session } = useApp();
  const [path] = route.split("?");
  if (path === "/prf") return <PrfCheck />;
  if (path?.startsWith("/m/")) return <MobileHandoff key={path} token={path.slice(3)} />;
  if (!session) return <Welcome />;
  if (path === "/send") return <Send />;
  if (path === "/deposit") return <Deposit />;
  if (path?.startsWith("/intent/")) return <IntentScreen key={path} id={path.slice("/intent/".length)} />;
  if (path === "/security") return <Security />;
  if (path === "/change/client") return <ChangeClient />;
  if (path === "/change/webapp") return <ChangeWebapp />;
  if (path === "/activity") return <Activity />;
  return <Home />;
}

function Boot() {
  const [state, setState] = useState<{ config: Config; session: Session | null } | { error: string } | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const [config, session] = await Promise.all([api<Config>("GET", "/v1/config", undefined, { auth: false }), loadSession()]);
        if (config.cluster !== PINNED_CLUSTER) return setState({ error: tr(`A API está em ${config.cluster}, mas este app foi feito para ${PINNED_CLUSTER}. Não continue.`, `The API is on ${config.cluster}, but this app was built for ${PINNED_CLUSTER}. Do not continue.`) });
        if (config.devTools && !(await ed25519Supported())) return setState({ error: tr("As carteiras de teste precisam de Ed25519 no WebCrypto (Chrome 137+, Firefox 129+, Safari 17+).", "Test wallets need Ed25519 in WebCrypto (Chrome 137+, Firefox 129+, Safari 17+).") });
        setState({ config, session });
      } catch (e) {
        setState({ error: tr(`API indisponível: ${(e as Error).message}. Rode \`pnpm dev\` na raiz do projeto.`, `API unavailable: ${(e as Error).message}. Run \`pnpm dev\` at the project root.`) });
      }
    })();
  }, []);
  if (!state) return <div className="app"><div className="page" style={{ alignItems: "center", justifyContent: "center" }}><span className="spinner" /></div></div>;
  if ("error" in state) return <div className="app"><div className="page" style={{ justifyContent: "center" }}><div className="banner danger">{state.error}</div></div></div>;
  return (
    <AppProvider config={state.config} initialSession={state.session}>
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
