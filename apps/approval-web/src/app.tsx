import { PublicKey } from "@solana/web3.js";
import { verifyEnrollmentTransaction } from "@duplachave/custody/src/client";
import { makeMwaWallet } from "./lib/mwa";
import { type BiometricConfirm, createWebappKey, deviceName, unlockWebappKey, type UnlockedKey, type WebappKeyBlob } from "./lib/webappKey";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Chain } from "@duplachave/solana";
import type { Cluster } from "@duplachave/shared";
import { api, ApiError, sentence } from "./lib/api";
import { appChain, short } from "./lib/chain";
import { makeDevWallet, type DevConfirm } from "./lib/devwallet";
import { saveSession, type Session } from "./lib/storage";
import { ConnectedWallet, discoverWallets, registerWallet, type StandardWallet, walletDisplay, walletLabel } from "./lib/wallets";
import { setActivationGate } from "./lib/activation";
import { trace } from "./lib/trace";
import { lang, tr } from "./lib/i18n";
import { errorEn } from "./lib/errors-en";
import { Icon } from "./icons";

let mwaRegistered = false;

export type Config = { cluster: Cluster; mode: string; devTools: boolean };

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
  /** Janela da biometria de teste (localnet). */
  biometric: BiometricConfirm;
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
  const [tapReq, setTapReq] = useState<{ label: string; resolve: () => void; reject: (e: Error) => void } | null>(null);
  useEffect(() => {
    setActivationGate((label) => new Promise<void>((resolve, reject) => setTapReq({ label, resolve, reject })));
    return () => setActivationGate(null);
  }, []);
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
    // No Android, a carteira do celular entra pelo Mobile Wallet Adapter (a página chama o app da carteira).
    if (/Android/i.test(navigator.userAgent) && config.cluster !== "localnet" && !mwaRegistered) {
      mwaRegistered = true;
      registerWallet(makeMwaWallet({ chain: config.cluster === "devnet" ? "solana:devnet" : "solana:mainnet", identity: { name: "Double Check", uri: location.origin, icon: "icon.svg" } }) as unknown as StandardWallet);
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
      if (!session) throw new Error(tr("sem sessão", "not signed in"));
      let c = wallet;
      if (!c || c.name !== session.walletName) {
        const w = wallets.find((x) => walletLabel(x.name) === session.walletName);
        if (!w) throw new Error(
            session.via === "webapp"
              ? tr(`Conecte a carteira da conta (${short(session.publicKey)}) para assinar: entre de novo com ela.`, `Connect the account's wallet (${short(session.publicKey)}) to sign: sign in again with it.`)
              : tr(`Abra ou instale a carteira ${session.walletName} para assinar.`, `Open or install the ${walletDisplay(session.walletName)} wallet to sign.`),
          );
        c = await connect(w);
      }
      if (c.refresh() !== session.publicKey)
        throw new Error(tr(`A ${c.name} está na conta ${short(c.publicKey)}, mas esta conta é da ${short(session.publicKey)}. Troque de conta na carteira e tente de novo.`, `${walletDisplay(c.name)} is on account ${short(c.publicKey)}, but this account belongs to ${short(session.publicKey)}. Switch accounts in the wallet and try again.`));
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
    biometric: (text) => devConfirm.current({ walletName: tr("Biometria de teste", "Test biometrics"), kind: "biometric", text }),
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
      {tapReq && (
        <div className="sheet-wrap" role="dialog" aria-modal="true" aria-label={tapReq.label}>
          <div className="sheet" style={{ alignItems: "stretch" }}>
            <div className="grab" style={{ alignSelf: "center" }} />
            <div style={{ fontSize: 17, fontWeight: 600, textAlign: "center" }}>{tr("Continue com um toque", "Tap to continue")}</div>
            <div className="muted" style={{ fontSize: 13, textAlign: "center", lineHeight: 1.5 }}>
              {tr("O celular só deixa abrir a carteira ou a biometria logo depois de um toque seu.", "Your phone only opens the wallet or biometrics right after you tap.")}
            </div>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                // Resolve dentro do próprio toque: a chamada seguinte ainda conta como iniciada por ele.
                tapReq.resolve();
                setTapReq(null);
              }}
            >
              {tapReq.label}
            </button>
            <button
              type="button"
              className="linkbtn"
              onClick={() => {
                tapReq.reject(new Error("assinatura recusada"));
                setTapReq(null);
              }}
            >
              {tr("Cancelar", "Cancel")}
            </button>
          </div>
        </div>
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
    <div className="sheet-wrap" role="dialog" aria-modal="true" aria-label={tr(`${req.walletName}: confirmar assinatura`, `${walletDisplay(req.walletName)}: confirm signature`)}>
      <div className="sheet" style={{ alignItems: "stretch" }}>
        <div className="grab" style={{ alignSelf: "center" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="wallet-badge">
            <Icon name="lock" size={18} />
          </div>
          <div className="grow">
            <div style={{ fontWeight: 600 }}>{walletDisplay(req.walletName)}</div>
            <div className="muted" style={{ fontSize: 12 }}>
              {req.kind === "message"
                ? tr("Pedido de assinatura de mensagem", "Message signature request")
                : req.kind === "biometric"
                  ? tr("Confirmação por biometria (digital, rosto)", "Confirm with fingerprint or face")
                  : tr("Pedido de assinatura de transação", "Transaction signature request")}
            </div>
          </div>
          <span className="pill">localnet</span>
        </div>
        <pre className="wallet-text">{req.text}</pre>
        <div style={{ display: "flex", gap: 12 }}>
          <button type="button" className="btn" style={{ flex: 1 }} onClick={() => onDone(false)}>
            {tr("Recusar", "Decline")}
          </button>
          <button type="button" className="btn primary" style={{ flex: 1 }} onClick={() => onDone(true)}>
            {req.kind === "biometric" ? tr("Confirmar", "Confirm") : tr("Assinar", "Sign")}
          </button>
        </div>
        <div className="subtle" style={{ fontSize: 11, textAlign: "center" }}>
          {req.kind === "biometric"
            ? tr("Biometria de teste do ambiente local. No celular, é a digital ou o rosto do próprio aparelho.", "Local test biometrics. On a phone, it's the device's own fingerprint or face.")
            : tr("Carteira de teste do ambiente local. Com uma carteira de verdade, esta janela é a da própria carteira.", "Local test wallet. With a real wallet, this window is the wallet's own.")}
        </div>
      </div>
    </div>
  );
}

/**
 * Entra com a carteira: se ela já tem conta, assina o texto de entrada (sem
 * custo); se não, cria a chave do webapp (biometria) e a carteira assina e paga
 * a criação da conta 2 de 3 (~0,003 SOL), depois de o app conferir a transação.
 */
export async function loginOrEnroll(ctx: Ctx, c: ConnectedWallet, onStep: (s: string) => void): Promise<Session & { created?: boolean }> {
  const publicKey = c.publicKey;
  const status = await api<{ enrolled: boolean; revoked: boolean }>("GET", `/v1/wallets/${publicKey}`, undefined, { auth: false });
  if (status.revoked && !status.enrolled) throw new Error(tr("Esta carteira foi substituída em uma conta e não volta a valer. Use outra carteira.", "This wallet was replaced on an account and can't be used again. Use another wallet."));
  if (status.enrolled) {
    trace("login:desafio");
    onStep(tr(`Confirme a entrada na ${c.name}…`, `Confirm sign-in in ${walletDisplay(c.name)}…`));
    const ch = await api("POST", "/v1/auth/challenge", { publicKey }, { auth: false });
    const signature = await c.signMessage(ch.message);
    const r = await api("POST", "/v1/auth/verify", { challengeId: ch.challengeId, publicKey, signature }, { auth: false });
    const s: Session = { token: r.token, accountId: r.account.id, walletName: c.name, publicKey, via: "extension" };
    await ctx.setSession(s);
    return s;
  }
  // Em localnet, a carteira (de teste ou não) recebe SOL de teste para pagar a criação.
  if (ctx.config.devTools && (await ctx.chain.getBalance(new PublicKey(publicKey))) < 10_000_000n) {
    onStep(tr("Pedindo SOL de teste para a sua carteira…", "Requesting test SOL for your wallet…"));
    await api("POST", "/v1/dev/airdrop", { address: publicKey, sol: 2 }, { auth: false });
  }
  // A chave do webapp nasce aqui, cifrada pela biometria deste aparelho; é um dos três votos.
  onStep(tr("Confirme a biometria: ela protege a chave do webapp neste aparelho…", "Confirm with fingerprint or face: it protects the webapp key on this device…"));
  const key = await createWebappKey({ devTools: ctx.config.devTools, confirm: ctx.biometric, what: tr("Criar a chave do webapp", "Create the webapp key") });
  try {
    onStep(tr("Preparando sua conta 2 de 3…", "Preparing your 2-of-3 account…"));
    const p = await api("POST", "/v1/enrollment/prepare", { publicKey, webappPublicKey: key.publicKey.toBase58(), walletName: c.name }, { auth: false });
    const { transaction } = verifyEnrollmentTransaction(p.transaction, new PublicKey(publicKey), key.publicKey);
    transaction.addSignature(key.publicKey, key.sign(transaction.message.serialize()));
    onStep(tr(`Confirme na ${c.name}: criar a conta custa ~0,003 SOL, pagos pela sua carteira…`, `Confirm in ${walletDisplay(c.name)}: creating the account costs ~0.003 SOL, paid by your wallet…`));
    const signed = await c.signTransaction(transaction);
    onStep(tr("Criando sua conta 2 de 3 na Solana…", "Creating your 2-of-3 account on Solana…"));
    const r = await api("POST", "/v1/enrollment/submit", { enrollmentId: p.enrollmentId, transaction: signed, keyBlob: { ...key.blob, deviceName: deviceName() } }, { auth: false });
    const s: Session = { token: r.token, accountId: r.account.id, walletName: c.name, publicKey, via: "extension" };
    await ctx.setSession(s);
    return { ...s, created: true };
  } finally {
    key.wipe();
  }
}

/**
 * Entrar só com a biometria (perdeu a carteira): o aparelho descobre a passkey,
 * pede ao serviço a cópia cifrada da chave do webapp, abre e assina a entrada.
 */
export async function loginWithBiometrics(ctx: Ctx, onStep: (s: string) => void): Promise<Session> {
  onStep(tr("Confirme a biometria deste aparelho…", "Confirm with this device's fingerprint or face…"));
  const key = await unlockWebappKey(null, {
    devTools: ctx.config.devTools,
    confirm: ctx.biometric,
    what: tr("Entrar com a biometria (sem a carteira)", "Sign in with biometrics (no wallet)"),
    lookup: (credentialId) => api("POST", "/v1/webapp-keys/lookup", { credentialId }, { auth: false }),
  });
  try {
    const pub = key.publicKey.toBase58();
    const ch = await api("POST", "/v1/auth/challenge", { publicKey: pub }, { auth: false });
    const signature = (await import("bs58")).default.encode(key.sign(new TextEncoder().encode(ch.message)));
    const r = await api("POST", "/v1/auth/webapp", { challengeId: ch.challengeId, publicKey: pub, signature }, { auth: false });
    const s: Session = { token: r.token, accountId: r.account.id, walletName: "sem carteira", publicKey: r.account.roles.client, via: "webapp" };
    await ctx.setSession(s);
    return s;
  } finally {
    key.wipe();
  }
}

/** As cópias cifradas da chave do webapp desta conta (pela sessão ou pelo token do QR). */
export async function accountKeyBlobs(path: string, auth = true): Promise<{ publicKey: string; blob: WebappKeyBlob }[]> {
  return (await api<{ keys: { publicKey: string; blob: WebappKeyBlob }[] }>("GET", path, undefined, auth ? undefined : { auth: false })).keys;
}

/** Abre a chave do webapp desta conta com a biometria, para uma assinatura. */
export async function unlockAccountKey(ctx: Ctx, keys: { publicKey: string; blob: WebappKeyBlob }[], what: string): Promise<UnlockedKey> {
  if (!keys.length) throw new Error(tr("Esta conta não tem a chave do webapp guardada.", "This account has no stored webapp key."));
  return unlockWebappKey(keys, { devTools: ctx.config.devTools, confirm: ctx.biometric, what });
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  const m = (e as Error)?.message ?? String(e);
  if (/NotAllowedError|The operation either timed out or was not allowed|biometria recusada/i.test(m)) return tr("Biometria cancelada.", "Biometrics canceled.");
  if (/User rejected|rejected the request|recusad/i.test(m)) return tr("Assinatura recusada na carteira.", "Signature declined in the wallet.");
  if (/insufficient|Attempt to debit an account but found no record/i.test(m)) return tr("Sua carteira não tem SOL suficiente para a taxa.", "Your wallet doesn't have enough SOL for the fee.");
  // Erros de segurança gerados no próprio webapp ("[CÓDIGO] mensagem"): sem o código e, em inglês, pelo mapa.
  const code = (e as { code?: unknown })?.code;
  if (typeof code === "string" && /^[A-Z0-9_]+$/.test(code)) {
    const pt = m.replace(/^\[[A-Z0-9_]+\]\s*/, "");
    return sentence((lang === "en" && errorEn(code, pt)) || pt);
  }
  return m;
}
