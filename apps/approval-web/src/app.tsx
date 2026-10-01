import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Chain } from "@duplachave/solana";
import type { Cluster } from "@duplachave/shared";
import { api, ApiError } from "./lib/api";
import { appChain, short } from "./lib/chain";
import { makeDevWallet, type DevConfirm } from "./lib/devwallet";
import { loadSession, saveSession, type Session } from "./lib/storage";
import { ConnectedWallet, discoverWallets, registerWallet, type StandardWallet } from "./lib/wallets";
import { Icon } from "./icons";

export type Config = { cluster: Cluster; feePayer: string; mode: string; devTools: boolean };

type ConfirmReq = Parameters<DevConfirm>[0] & { resolve: (ok: boolean) => void };

type Ctx = {
  config: Config;
  chain: Chain;
  session: Session | null;
  setSession: (s: Session | null) => Promise<void>;
  wallets: StandardWallet[];
  wallet: ConnectedWallet | null;
  /** Conecta (ou reconecta) uma carteira. */
  connect: (w: StandardWallet) => Promise<ConnectedWallet>;
  /** A carteira da conta, conectada e na conta certa — ou erro explicando o que fazer. */
  accountWallet: () => Promise<ConnectedWallet>;
  route: string;
  go: (path: string) => void;
  toast: (msg: string) => void;
  initiatedHere: (rotationId: string) => boolean;
  dev: { malicious: boolean; setMalicious: (v: boolean) => void };
};

const AppCtx = createContext<Ctx | null>(null);
export const useApp = () => useContext(AppCtx)!;

function useHashRoute() {
  const [route, setRoute] = useState(() => location.hash.slice(1) || "/");
  useEffect(() => {
    const on = () => setRoute(location.hash.slice(1) || "/");
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function AppProvider({ config, initialSession, children }: { config: Config; initialSession: Session | null; children: ReactNode }) {
  const [session, setSessionState] = useState(initialSession);
  const [wallets, setWallets] = useState<StandardWallet[]>([]);
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [, bump] = useState(0);
  const route = useHashRoute();
  const [toastMsg, setToast] = useState<string | null>(null);
  const [confirmReq, setConfirmReq] = useState<ConfirmReq | null>(null);
  const [malicious, setMalicious] = useState(false);
  const chain = useMemo(() => appChain(), []);
  const toastTimer = useRef<number>(0);
  const devConfirm = useRef<DevConfirm>(async () => false);
  devConfirm.current = (req) => new Promise<boolean>((resolve) => setConfirmReq({ ...req, resolve }));

  useEffect(() => {
    const stop = discoverWallets(setWallets);
    if (config.devTools) {
      registerWallet(makeDevWallet("Carteira de teste A", () => devConfirm.current) as unknown as StandardWallet);
      registerWallet(makeDevWallet("Carteira de teste B", () => devConfirm.current) as unknown as StandardWallet);
    }
    return stop;
  }, [config.devTools]);

  const connect = useCallback(
    async (w: StandardWallet) => {
      const c = await ConnectedWallet.connect(w, config.cluster);
      c.onChange(() => bump((x) => x + 1));
      setWallet(c);
      return c;
    },
    [config.cluster],
  );

  const ctx: Ctx = {
    config,
    chain,
    session,
    setSession: async (s) => {
      await saveSession(s);
      setSessionState(s);
    },
    wallets,
    wallet,
    connect,
    accountWallet: async () => {
      if (!session) throw new Error("sem sessão");
      let c = wallet;
      if (!c || c.name !== session.walletName) {
        const w = wallets.find((x) => x.name === session.walletName);
        if (!w) throw new Error(`Abra ou instale a carteira ${session.walletName} para assinar.`);
        c = await connect(w);
      }
      if (c.refresh() !== session.publicKey)
        throw new Error(`A ${c.name} está na conta ${short(c.publicKey)}, mas esta conta é da ${short(session.publicKey)}. Troque de conta na carteira e tente de novo.`);
      return c;
    },
    route,
    go: (p) => {
      location.hash = p;
    },
    toast: (m) => {
      setToast(m);
      clearTimeout(toastTimer.current);
      toastTimer.current = window.setTimeout(() => setToast(null), 4200);
    },
    initiatedHere: (rotationId) => Boolean(session?.myRotations.includes(rotationId)),
    dev: { malicious, setMalicious },
  };

  return (
    <AppCtx.Provider value={ctx}>
      {children}
      {confirmReq && (
        <DevWalletSheet
          req={confirmReq}
          onDone={(ok) => {
            confirmReq.resolve(ok);
            setConfirmReq(null);
          }}
        />
      )}
      {toastMsg && (
        <div className="toast" role="status">
          {toastMsg}
        </div>
      )}
    </AppCtx.Provider>
  );
}

/** Janela da carteira de teste: imita a confirmação de uma carteira de verdade. */
function DevWalletSheet({ req, onDone }: { req: ConfirmReq; onDone: (ok: boolean) => void }) {
  return (
    <div className="sheet-wrap" role="dialog" aria-modal="true" aria-label={`${req.walletName}: confirmar assinatura`}>
      <div className="sheet" style={{ alignItems: "stretch" }}>
        <div className="grab" style={{ alignSelf: "center" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="wallet-badge">
            <Icon name="lock" size={18} />
          </div>
          <div className="grow">
            <div style={{ fontWeight: 600 }}>{req.walletName}</div>
            <div className="muted" style={{ fontSize: 12 }}>
              {req.kind === "message" ? "Pedido de assinatura de mensagem" : "Pedido de assinatura de transação"}
            </div>
          </div>
          <span className="pill">localnet</span>
        </div>
        <pre className="wallet-text">{req.text}</pre>
        <div style={{ display: "flex", gap: 12 }}>
          <button type="button" className="btn" style={{ flex: 1 }} onClick={() => onDone(false)}>
            Recusar
          </button>
          <button type="button" className="btn primary" style={{ flex: 1 }} onClick={() => onDone(true)}>
            Assinar
          </button>
        </div>
        <div className="subtle" style={{ fontSize: 11, textAlign: "center" }}>
          Carteira de teste do ambiente local. Com a Phantom, esta janela é a da própria Phantom.
        </div>
      </div>
    </div>
  );
}

/**
 * Entra com a carteira: se ela já tem conta, assina o texto de entrada; se não,
 * assina o texto de vínculo e a conta 2-de-2 é criada.
 */
export async function loginOrEnroll(ctx: Ctx, c: ConnectedWallet, onStep: (s: string) => void): Promise<Session> {
  const publicKey = c.publicKey;
  const status = await api<{ enrolled: boolean; revoked: boolean }>("GET", `/v1/wallets/${publicKey}`, undefined, { auth: false });
  if (status.revoked && !status.enrolled) throw new Error("Esta carteira foi substituída em uma conta e não volta a valer. Use outra carteira.");
  if (status.enrolled) {
    onStep(`Confirme a entrada na ${c.name}…`);
    const ch = await api("POST", "/v1/auth/challenge", { publicKey }, { auth: false });
    const signature = await c.signMessage(ch.message);
    const r = await api("POST", "/v1/auth/verify", { challengeId: ch.challengeId, publicKey, signature }, { auth: false });
    const s: Session = { token: r.token, accountId: r.account.id, walletName: c.name, publicKey, myRotations: [] };
    await ctx.setSession(s);
    return s;
  }
  onStep(`Assine o vínculo na ${c.name}…`);
  const ch = await api("POST", "/v1/enrollment/challenge", { publicKey }, { auth: false });
  const signature = await c.signMessage(ch.message);
  onStep("Criando sua conta 2 de 2 na Solana…");
  const r = await api("POST", "/v1/enrollment", { challengeId: ch.challengeId, publicKey, signature, walletName: c.name }, { auth: false });
  const s: Session = { token: r.token, accountId: r.account.id, walletName: c.name, publicKey, myRotations: [] };
  await ctx.setSession(s);
  return s;
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  const m = (e as Error)?.message ?? String(e);
  if (/User rejected|rejected the request|recusad/i.test(m)) return "Assinatura recusada na carteira.";
  return m;
}

export { loadSession };
