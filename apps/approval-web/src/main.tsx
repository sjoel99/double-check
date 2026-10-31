import "./polyfills";
import { lazy, StrictMode, Suspense, useCallback, useEffect, useState } from "react";
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
import { Welcome } from "./screens/welcome";

// Telas fora do caminho principal (entrar → enviar) vêm sob demanda: ficam fora do chunk inicial.
const Security = lazy(() => import("./screens/security").then((m) => ({ default: m.Security })));
const ChangeClient = lazy(() => import("./screens/security").then((m) => ({ default: m.ChangeClient })));
const ChangeWebapp = lazy(() => import("./screens/security").then((m) => ({ default: m.ChangeWebapp })));
const Activity = lazy(() => import("./screens/security").then((m) => ({ default: m.Activity })));
const MobileHandoff = lazy(() => import("./screens/handoff").then((m) => ({ default: m.MobileHandoff })));
const PrfCheck = lazy(() => import("./screens/prfcheck").then((m) => ({ default: m.PrfCheck })));

const Spinner = () => <div className="page" style={{ alignItems: "center", justifyContent: "center" }}><span className="spinner" /></div>;

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
  // Tela nova começa do topo: a rolagem de uma tela longa não pode "vazar" para a seguinte.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [path]);
  return <Suspense fallback={<Spinner />}><Routes path={path} session={session} /></Suspense>;
}

function Routes({ path, session }: { path: string | undefined; session: Session | null }) {
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
  const [state, setState] = useState<{ config: Config; session: Session | null } | { error: string; retry?: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setState(null);
    setAttempt((n) => n + 1);
  }, []);
  useEffect(() => {
    (async () => {
      try {
        const [config, session] = await Promise.all([api<Config>("GET", "/v1/config", undefined, { auth: false }), loadSession()]);
        if (config.cluster !== PINNED_CLUSTER) return setState({ error: tr(`A API está em ${config.cluster}, mas este app foi feito para ${PINNED_CLUSTER}. Não continue.`, `The API is on ${config.cluster}, but this app was built for ${PINNED_CLUSTER}. Do not continue.`) });
        // As ferramentas de teste (biometria em software, carteiras de teste) só existem em
        // localnet, e isso é decidido pelo build, não pela API: uma API que anuncie devTools
        // fora de localnet está errada ou comprometida, e o app não pode rebaixar a biometria.
        if (config.devTools && PINNED_CLUSTER !== "localnet") return setState({ error: tr("A API anuncia ferramentas de teste fora de localnet. Não continue.", "The API advertises test tools outside localnet. Do not continue.") });
        if (config.devTools && !(await ed25519Supported())) return setState({ error: tr("As carteiras de teste precisam de Ed25519 no WebCrypto (Chrome 137+, Firefox 129+, Safari 17+).", "Test wallets need Ed25519 in WebCrypto (Chrome 137+, Firefox 129+, Safari 17+).") });
        setState({ config, session });
      } catch {
        // Para quem usa: sem detalhe técnico. A dica do `pnpm dev` só faz sentido em localnet.
        const hint = PINNED_CLUSTER === "localnet" ? tr(" Em localnet, rode `pnpm dev` na raiz do projeto.", " On localnet, run `pnpm dev` at the project root.") : "";
        setState({ error: tr(`O serviço não respondeu. Confira sua conexão e tente de novo.${hint}`, `The service did not respond. Check your connection and try again.${hint}`), retry: true });
      }
    })();
  }, [attempt]);
  if (!state) return <div className="app"><Spinner /></div>;
  if ("error" in state)
    return (
      <div className="app">
        <div className="page" style={{ justifyContent: "center" }}>
          <div className="banner danger">{state.error}</div>
          {state.retry && (
            <div className="actions">
              <button className="btn primary" onClick={retry}>{tr("Tentar de novo", "Try again")}</button>
            </div>
          )}
        </div>
      </div>
    );
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
