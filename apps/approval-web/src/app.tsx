import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { RpcChain } from "@duplachave/solana";
import type { Cluster } from "@duplachave/shared";
import { api, ApiError } from "./lib/api";
import { appChain } from "./lib/chain";
import { type DeviceRecord, loadDevice, saveDevice, unlockWithBiometric, unlockWithPin, WebCryptoSigner } from "./lib/device";
import { Icon } from "./icons";

export type Config = { cluster: Cluster; rpcUrl: string; feePayer: string; mode: string; devTools: boolean };

type UnlockRequest = { summary: string; resolve: () => void; reject: (e: Error) => void };

type Ctx = {
  config: Config;
  chain: RpcChain;
  device: DeviceRecord | null;
  setDevice: (d: DeviceRecord | null) => Promise<void>;
  route: string;
  go: (path: string) => void;
  toast: (msg: string) => void;
  signer: () => WebCryptoSigner;
  /** Abre a confirmação local (biometria/PIN). Resolve quando o signer está destravado. */
  unlock: (summary: string) => Promise<void>;
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

export function AppProvider({ config, initialDevice, children }: { config: Config; initialDevice: DeviceRecord | null; children: ReactNode }) {
  const [device, setDeviceState] = useState(initialDevice);
  const route = useHashRoute();
  const [toastMsg, setToast] = useState<string | null>(null);
  const [unlockReq, setUnlockReq] = useState<UnlockRequest | null>(null);
  const [malicious, setMalicious] = useState(false);
  const chain = useMemo(() => appChain(config.cluster, config.rpcUrl), [config]);
  const toastTimer = useRef<number>(0);

  const ctx: Ctx = {
    config,
    chain,
    device,
    setDevice: async (d) => {
      if (d) await saveDevice(d);
      setDeviceState(d);
    },
    route,
    go: (p) => {
      location.hash = p;
    },
    toast: (m) => {
      setToast(m);
      clearTimeout(toastTimer.current);
      toastTimer.current = window.setTimeout(() => setToast(null), 3800);
    },
    signer: () => {
      if (!device) throw new Error("sem chave neste aparelho");
      return new WebCryptoSigner(device);
    },
    unlock: (summary) => new Promise<void>((resolve, reject) => setUnlockReq({ summary, resolve, reject })),
    dev: { malicious, setMalicious },
  };

  return (
    <AppCtx.Provider value={ctx}>
      {children}
      {unlockReq && device && (
        <UnlockSheet
          device={device}
          summary={unlockReq.summary}
          onDone={() => {
            unlockReq.resolve();
            setUnlockReq(null);
          }}
          onCancel={() => {
            unlockReq.reject(new Error("CANCELLED"));
            setUnlockReq(null);
          }}
          refresh={async () => setDeviceState(await loadDevice())}
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

function UnlockSheet({ device, summary, onDone, onCancel, refresh }: { device: DeviceRecord; summary: string; onDone: () => void; onCancel: () => void; refresh: () => Promise<void> }) {
  const [pin, setPin] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isPin = device.protection.kind === "pin";

  const tryPin = useCallback(
    async (value: string) => {
      setBusy(true);
      try {
        const fresh = (await loadDevice())!;
        await unlockWithPin(fresh, value);
        onDone();
      } catch (e) {
        setErr((e as Error).message);
        setPin("");
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [onDone, refresh],
  );

  const press = (k: string) => {
    if (busy) return;
    setErr(null);
    if (k === "del") return setPin((p) => p.slice(0, -1));
    const next = (pin + k).slice(0, 6);
    setPin(next);
    if (next.length === 6) void tryPin(next);
  };

  const bio = async () => {
    setErr(null);
    try {
      if (device.protection.kind !== "webauthn") return;
      await unlockWithBiometric(device.protection);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  useEffect(() => {
    if (!isPin) void bio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="sheet-wrap" role="dialog" aria-modal="true" aria-label="Confirme que é você">
      <div className="sheet">
        <div className="grab" />
        <div style={{ width: 84, height: 84, borderRadius: 28, background: "var(--surface-2)", border: "1px solid #2b313a", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--accent)" }}>
          <Icon name={isPin ? "lock" : "finger"} size={44} sw={1.5} />
        </div>
        <div className="center" style={{ gap: 8 }}>
          <div style={{ fontSize: 20, fontWeight: 600 }}>Confirme que é você</div>
          <div className="muted" style={{ fontSize: 14, lineHeight: 1.5, maxWidth: 300 }}>
            Sua chave de aprovação assina aqui, neste aparelho. Ela nunca sai dele.
          </div>
        </div>
        <div className="status mono" style={{ fontSize: 12, color: "var(--muted)", maxWidth: "100%" }}>
          <Icon name="lock" size={14} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary}</span>
        </div>
        {isPin ? (
          <>
            <div className="pin" aria-label={`${pin.length} de 6 dígitos`}>
              {Array.from({ length: 6 }, (_, i) => (
                <span key={i} className={i < pin.length ? "on" : ""} />
              ))}
            </div>
            <div className="keypad">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "del"].map((k, i) =>
                k === "" ? (
                  <span key={i} />
                ) : (
                  <button key={i} type="button" onClick={() => press(k)} aria-label={k === "del" ? "Apagar" : k} disabled={busy}>
                    {k === "del" ? "⌫" : k}
                  </button>
                ),
              )}
            </div>
          </>
        ) : (
          <button type="button" className="btn primary" style={{ width: "100%", flex: "none" }} onClick={bio}>
            <Icon name="finger" color="#0B0D10" sw={2} /> Usar biometria
          </button>
        )}
        {err && <div className="err">{err}</div>}
        <button type="button" className="linkbtn" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

/** Sessão: assina um desafio com a chave do aparelho. */
export async function login(ctx: Ctx, device: DeviceRecord) {
  const { signStatement, randomHex } = await import("@duplachave/crypto");
  await ctx.unlock("Entrar na sua conta");
  const ch = await api("POST", "/v1/auth/challenge", { publicKey: device.publicKey }, { auth: false });
  const signed = await signStatement(new WebCryptoSigner(device), {
    domain: "duplachave/auth/v1",
    challenge: ch.challenge,
    publicKey: device.publicKey,
    cluster: ctx.config.cluster,
    nonce: randomHex(16),
    createdAt: Math.floor(Date.now() / 1000),
  });
  const r = await api("POST", "/v1/auth/verify", { challengeId: ch.challengeId, signed }, { auth: false });
  const next = { ...device, session: { token: r.token, accountId: r.account.id } };
  await ctx.setDevice(next);
  return next;
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return `${e.message}`;
  return (e as Error)?.message ?? String(e);
}
