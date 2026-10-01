import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { PublicKey } from "@solana/web3.js";
import { readMultisig, type MultisigState } from "@duplachave/squads";
import { signPossession } from "@duplachave/custody/src/client";
import { errorText, login, useApp } from "../app";
import { api, ApiError } from "../lib/api";
import { now, short } from "../lib/chain";
import { FreshKeySigner, generateKey, type Protection, wipeDevice, loadDevice } from "../lib/device";
import { Icon } from "../icons";
import { IntentRow, Tabs, useAccount } from "./home";
import { ProtectionPicker } from "./onboarding";

function TopBar({ title, back = "/" }: { title: string; back?: string }) {
  const { go } = useApp();
  return (
    <div className="topbar">
      <button type="button" className="iconbtn" aria-label="Voltar" onClick={() => go(back)}>
        <Icon name="back" />
      </button>
      <h1>{title}</h1>
    </div>
  );
}

/** Conferência local: o app lê a multisig pela RPC dele e checa o modelo 2 de 2. */
function useOnchainCheck(multisig: string | undefined) {
  const ctx = useApp();
  const [state, setState] = useState<MultisigState | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!multisig) return;
    let on = true;
    const run = async () => {
      try {
        const s = await readMultisig(ctx.chain, new PublicKey(multisig));
        if (on) {
          setState(s);
          setCheckedAt(now());
        }
      } catch {
        /* mantém o último */
      }
    };
    void run();
    const i = setInterval(run, 10_000);
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => {
      on = false;
      clearInterval(i);
      clearInterval(t);
    };
  }, [multisig, ctx.chain]);
  const me = ctx.device?.publicKey;
  const voters = state?.members.filter((m) => m.vote) ?? [];
  const ok = Boolean(state && state.threshold === 2 && voters.length === 2 && voters.some((v) => v.key === me) && state.configAuthority === PublicKey.default.toBase58());
  return { state, ok, ago: checkedAt ? now() - checkedAt : null, tick };
}

export function Security() {
  const ctx = useApp();
  const { acc } = useAccount(8000);
  const { state, ok, ago } = useOnchainCheck(acc?.account.multisig);
  const roles = acc?.account.roles;
  const order = (k: string) => [roles?.client, roles?.server, roles?.executor, roles?.proposer].indexOf(k) + 1 || 9;
  const label = (k: string) =>
    k === roles?.client
      ? { icon: "phone", title: "Sua chave", sub: `${ctx.device?.deviceName ?? ""}, este aparelho`, role: "Aprova", accent: true }
      : k === roles?.server
        ? { icon: "server", title: "Chave do serviço", sub: "confere a política", role: "Aprova", accent: false }
        : k === roles?.executor
          ? { icon: "bolt", title: "Executor", sub: "não aprova", role: "Executa", accent: false }
          : k === roles?.proposer
            ? { icon: "send", title: "Proponente", sub: "não aprova", role: "Propõe", accent: false }
            : { icon: "shieldalert", title: "Chave desconhecida", sub: "não esperada", role: "?", accent: false };

  return (
    <>
      <TopBar title="Segurança" />
      <div className="page">
        <div className="card">
          <div className="row-between">
            <div className="muted" style={{ fontSize: 13 }}>
              Modo
            </div>
            {state ? (
              ok ? (
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ok-text)" }}>
                  <Icon name="check" size={14} color="#C8F169" sw={2.2} /> Conferido na Solana há {ago ?? 0} s
                </div>
              ) : (
                <span className="pill danger">Diferente do esperado</span>
              )
            ) : (
              <span className="spinner" />
            )}
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <div className="big" style={{ fontSize: 34 }}>
              {state ? `${state.threshold} de ${state.members.filter((m) => m.vote).length}` : "—"}
            </div>
            <div className="muted" style={{ fontSize: 14 }}>
              estrito
            </div>
          </div>
          <div style={{ fontSize: 13, color: "#b4bac4", lineHeight: 1.45 }}>Todo envio e toda troca de chave precisam da sua aprovação e da do serviço. Nenhuma chave sozinha move fundos.</div>
          {state && (
            <div className="subtle mono" style={{ fontSize: 11 }}>
              multisig {short(state.address)} · índice {state.transactionIndex.toString()} · sem config authority
            </div>
          )}
        </div>
        <div>
          <div className="section-title" style={{ paddingBottom: 4 }}>
            Chaves
          </div>
          {[...(state?.members ?? [])]
            .sort((a, b) => order(a.key) - order(b.key))
            .map((m) => {
            const l = label(m.key);
            return (
              <div className="list-row" key={m.key} style={{ borderTop: "1px solid var(--line-soft)" }}>
                <div className="ico" style={{ background: l.accent ? "var(--accent)" : "var(--surface-2)", width: 40, height: 40 }}>
                  <Icon name={l.icon} size={18} color={l.accent ? "#0B0D10" : "var(--muted)"} sw={2} />
                </div>
                <div className="grow">
                  <div className="t">{l.title}</div>
                  <div className="s mono">
                    {short(m.key)} · {l.sub}
                  </div>
                </div>
                <span className="pill">{l.role}</span>
              </div>
            );
          })}
        </div>
        <button type="button" className="btn" style={{ flex: "none", height: 52 }} onClick={() => ctx.go("/rotate")} disabled={Boolean(acc?.account.frozenBy)}>
          <Icon name="phone" size={18} /> Trocar de aparelho
        </button>
        <div style={{ display: "flex", gap: 10, fontSize: 12, color: "var(--subtle)", lineHeight: 1.5 }}>
          <Icon name="lock" size={14} />
          <div>Perder este aparelho sem trocar a chave antes bloqueia a conta. A recuperação ainda não está disponível neste modo.</div>
        </div>
      </div>
      <Tabs />
    </>
  );
}

// ---------------------------------------------------------------- troca de aparelho (aparelho atual)

export function Rotate() {
  const ctx = useApp();
  const [name, setName] = useState("Novo aparelho");
  const [pairing, setPairing] = useState<{ rotationId: string; challenge: string; link: string; qr: string } | null>(null);
  const [rotation, setRotation] = useState<{ status: string; intentId: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const accountId = ctx.device?.session?.accountId;

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api("POST", `/v1/accounts/${accountId}/rotations/client`, { newDeviceName: name });
      const p = r.pairing;
      // Lembra que a troca foi pedida aqui: o app recusa aprovar troca de chave que não pediu.
      if (ctx.device) await ctx.setDevice({ ...ctx.device, myRotations: [...(ctx.device.myRotations ?? []), p.rotationId].slice(-20) });
      const link = `${location.origin}/?device=novo-${p.rotationId.slice(0, 8)}#/pair?r=${p.rotationId}&c=${p.challenge}`;
      setPairing({ rotationId: p.rotationId, challenge: p.challenge, link, qr: await QRCode.toDataURL(link, { margin: 1, width: 400 }) });
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const poll = useCallback(async () => {
    if (!pairing) return;
    try {
      const r = await api<{ rotations: { id: string; status: string; intentId: string | null }[] }>("GET", `/v1/accounts/${accountId}/rotations`);
      const mine = r.rotations.find((x) => x.id === pairing.rotationId);
      if (mine) setRotation({ status: mine.status, intentId: mine.intentId });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setRotation({ status: "COMPLETED", intentId: null });
    }
  }, [pairing, accountId]);

  useEffect(() => {
    const i = setInterval(poll, 2000);
    return () => clearInterval(i);
  }, [poll]);

  const steps = [
    ["Aparelho novo abre o link ou lê o QR", true],
    ["Aparelho novo prova que tem a chave", rotation && rotation.status !== "REQUESTED"],
    ["Você aprova a troca aqui", rotation && ["AWAITING_SERVER_APPROVAL", "EXECUTING", "VERIFIED", "COMPLETED"].includes(rotation.status)],
    ["Serviço aprova e a Solana troca as chaves", rotation?.status === "COMPLETED"],
  ] as const;

  return (
    <>
      <TopBar title="Trocar de aparelho" back="/security" />
      <div className="page">
        {!pairing ? (
          <>
            <div style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.2 }}>Leve sua aprovação para outro aparelho</div>
            <div className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
              O aparelho novo cria a própria chave e prova que a tem. Depois você confirma aqui, e a Solana troca uma chave pela outra numa única transação. Envios ficam pausados até terminar.
            </div>
            <div className="field">
              <label htmlFor="nd">Nome do aparelho novo</label>
              <input id="nd" className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
            </div>
            <button type="button" className="btn primary" style={{ flex: "none" }} disabled={busy || !name.trim()} onClick={start}>
              {busy ? <span className="spinner" /> : null}Gerar código de pareamento
            </button>
          </>
        ) : (
          <>
            <div className="center" style={{ gap: 16 }}>
              <img className="qr" src={pairing.qr} alt="QR code para parear o aparelho novo" />
              <div className="muted" style={{ fontSize: 13, lineHeight: 1.5, maxWidth: 320 }}>
                Abra no aparelho novo. Quem tem este código consegue só pedir para entrar — a troca ainda depende da sua aprovação aqui.
              </div>
              <div style={{ display: "flex", gap: 10, width: "100%" }}>
                <button
                  type="button"
                  className="btn small"
                  style={{ flex: 1 }}
                  onClick={async () => {
                    await navigator.clipboard.writeText(pairing.link);
                    ctx.toast("Link copiado");
                  }}
                >
                  <Icon name="copy" size={16} /> Copiar link
                </button>
                <a className="btn small" style={{ flex: 1 }} href={pairing.link} target="_blank" rel="noreferrer">
                  <Icon name="ext" size={16} /> Abrir como novo
                </a>
              </div>
            </div>
            <div className="card" style={{ padding: "8px 16px", gap: 0 }}>
              {steps.map(([t, done], k) => (
                <div key={k} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0" }}>
                  <div className="dot" style={{ background: done ? "var(--accent)" : "#343a44" }}>
                    {done ? <Icon name="check" size={14} color="#0B0D10" sw={2.4} /> : <span className="mono" style={{ fontSize: 11, color: "var(--text)" }}>{k + 1}</span>}
                  </div>
                  <div style={{ fontSize: 14 }}>{t}</div>
                </div>
              ))}
            </div>
            {rotation?.status === "AWAITING_CLIENT_APPROVAL" && rotation.intentId && (
              <button type="button" className="btn amber" style={{ flex: "none" }} onClick={() => ctx.go(`/intent/${rotation.intentId}`)}>
                <Icon name="shieldalert" color="#0B0D10" sw={2} /> Revisar e aprovar a troca
              </button>
            )}
            {rotation && ["REJECTED", "EXPIRED", "FAILED", "ROLLBACK_REQUIRED"].includes(rotation.status) && <div className="banner danger">Troca encerrada: {rotation.status}</div>}
          </>
        )}
        {err && <div className="banner danger">{err}</div>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- aparelho novo

export function Pair({ r, c }: { r: string; c: string }) {
  const ctx = useApp();
  const [info, setInfo] = useState<{ status: string; multisig: string; newDeviceName: string | null; newKey: string | null; expiresAt: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setInfo(await api("POST", `/v1/rotations/${r}/pairing`, { challenge: c }, { auth: false }));
    } catch (e) {
      setErr(errorText(e));
    }
  }, [r, c]);

  useEffect(() => {
    void load();
    const i = setInterval(load, 2000);
    return () => clearInterval(i);
  }, [load]);

  const mine = info?.newKey && ctx.device?.publicKey === info.newKey;
  const loggingIn = useRef(false);

  useEffect(() => {
    // Concluído: entra na conta com a chave nova (uma vez só, mesmo com o polling).
    if (mine && info?.status === "COMPLETED" && ctx.device && !ctx.device.session && !loggingIn.current) {
      loggingIn.current = true;
      void login(ctx, ctx.device)
        .then(() => {
          ctx.toast("Este aparelho agora aprova suas transações.");
          ctx.go("/");
        })
        .catch((e) => {
          loggingIn.current = false;
          if ((e as Error).message !== "CANCELLED") setErr(errorText(e));
        });
    }
  }, [mine, info?.status, ctx]);

  const prove = async (protection: Protection) => {
    setBusy(true);
    setErr(null);
    try {
      if (ctx.device) throw new Error("este aparelho já tem uma chave; use ?device=outro-nome para simular mais um");
      const key = await generateKey();
      const possession = await signPossession({ signer: new FreshKeySigner(key), operation: "ROTATE_CLIENT_KEY", cluster: ctx.config.cluster, multisig: info!.multisig, rotationId: r, challenge: c, now: now() });
      await api("POST", `/v1/rotations/${r}/proof`, { possession }, { auth: false });
      await ctx.setDevice({ privateKey: key.privateKey, publicKey: key.publicKey, deviceName: info!.newDeviceName ?? "Novo aparelho", protection, createdAt: Date.now(), session: null });
      await load();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page" style={{ paddingTop: 40 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 600, color: "var(--warn)", letterSpacing: "0.12em", textTransform: "uppercase" }}>
        <Icon name="phone" size={16} color="#F2B33D" /> Novo aparelho
      </div>
      <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.2 }}>{mine ? "Aguardando a aprovação no aparelho antigo" : "Parear este aparelho"}</div>
      {info && (
        <div className="card" style={{ padding: "4px 16px", gap: 0 }}>
          <div className="detail" style={{ borderTop: 0 }}>
            <div>Conta</div>
            <div className="mono">{short(info.multisig)}</div>
          </div>
          <div className="detail">
            <div>Nome</div>
            <div>{info.newDeviceName}</div>
          </div>
          <div className="detail">
            <div>Situação</div>
            <div>{info.status}</div>
          </div>
        </div>
      )}
      {!mine && info?.status === "REQUESTED" && (
        <>
          <div className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
            Este aparelho vai criar a própria chave de aprovação e provar que a tem. A chave nunca sai daqui.
          </div>
          <ProtectionPicker deviceName={info.newDeviceName ?? "Novo aparelho"} onReady={prove} busy={busy} />
        </>
      )}
      {mine && info?.status !== "COMPLETED" && (
        <>
          <div className="card" style={{ alignItems: "center", textAlign: "center", gap: 8 }}>
            <div className="muted" style={{ fontSize: 13 }}>
              A chave deste aparelho
            </div>
            <div className="big" style={{ fontSize: 28 }}>
              {short(ctx.device!.publicKey)}
            </div>
            <div className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
              No aparelho antigo, a "Nova" chave tem que ser exatamente esta. Se for outra, rejeite lá.
            </div>
          </div>
          <div className="status">
            <span className="spinner" /> Confirme a troca no aparelho antigo.
          </div>
        </>
      )}
      {info && ["REJECTED", "EXPIRED", "FAILED"].includes(info.status) && <div className="banner danger">A troca foi encerrada ({info.status}).</div>}
      {err && <div className="banner danger">{err}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- atividade

export function Activity() {
  const ctx = useApp();
  const { intents } = useAccount(6000);
  const [audit, setAudit] = useState<{ seq: number; type: string; at: number; hash: string; txSignature: string | null }[]>([]);
  useEffect(() => {
    const id = ctx.device?.session?.accountId;
    if (id) void api("GET", `/v1/accounts/${id}/audit`).then((r) => setAudit(r.events.slice().reverse()));
  }, [ctx.device, intents.length]);
  return (
    <>
      <div className="topbar">
        <h1>Atividade</h1>
      </div>
      <div className="page">
        <div>
          {intents.length === 0 && <div className="subtle" style={{ fontSize: 13 }}>Nenhuma transação ainda.</div>}
          {intents.map((i) => (
            <IntentRow key={i.intent.id} i={i} />
          ))}
        </div>
        <div>
          <div className="section-title" style={{ paddingBottom: 6 }}>
            Registro de auditoria
          </div>
          <div className="subtle" style={{ fontSize: 12, paddingBottom: 6 }}>
            Só inserção, encadeado por hash. Editar um evento quebra a cadeia.
          </div>
          {audit.slice(0, 30).map((e) => (
            <div className="list-row" key={e.seq} style={{ padding: "9px 0" }}>
              <div className="grow">
                <div className="t mono" style={{ fontSize: 12 }}>
                  {e.type}
                </div>
                <div className="s">{new Date(e.at * 1000).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "medium" })}</div>
              </div>
              <div className="subtle mono" style={{ fontSize: 11 }}>
                #{e.seq} {e.hash.slice(0, 8)}
              </div>
            </div>
          ))}
        </div>
      </div>
      <Tabs />
    </>
  );
}

// ---------------------------------------------------------------- sessão

export function Login() {
  const ctx = useApp();
  const [err, setErr] = useState<string | null>(null);
  const [replaced, setReplaced] = useState<null | "revoked" | "unknown">(null);
  const go = async () => {
    setErr(null);
    try {
      await login(ctx, ctx.device!);
      ctx.go("/");
    } catch (e) {
      if (e instanceof ApiError && e.code === "KEY_REVOKED") setReplaced("revoked");
      else if (e instanceof ApiError && e.code === "NOT_A_CLIENT_KEY") setReplaced("unknown");
      else if ((e as Error).message !== "CANCELLED") setErr(errorText(e));
    }
  };
  if (replaced) {
    return (
      <div className="page" style={{ paddingTop: 56 }}>
        <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em" }}>{replaced === "revoked" ? "Esta chave foi substituída" : "Conta não encontrada"}</div>
        <div className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
          {replaced === "revoked"
            ? "A conta agora é aprovada por outro aparelho. Esta chave não vota mais na Solana e não volta a valer. Você pode apagá-la daqui."
            : "Este servidor não conhece nenhuma conta com esta chave. No ambiente local isso acontece quando a API ou o validador são reiniciados (os dois guardam tudo em memória). Apague a chave e crie uma conta nova."}
        </div>
        <button
          type="button"
          className="btn"
          style={{ flex: "none" }}
          onClick={async () => {
            await wipeDevice();
            await ctx.setDevice(null);
            ctx.go("/");
          }}
        >
          Apagar chave deste aparelho
        </button>
      </div>
    );
  }
  return (
    <div className="page" style={{ paddingTop: 56, justifyContent: "space-between" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em" }}>Entrar</div>
        <div className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
          Sua sessão expirou. Para entrar, este aparelho assina um desafio com a chave dele. Entrar não aprova nada: cada transação continua pedindo confirmação.
        </div>
        <div className="status mono" style={{ fontSize: 12 }}>
          <Icon name="key" size={14} /> {short(ctx.device!.publicKey)} · {ctx.device!.deviceName}
        </div>
        {err && <div className="banner danger">{err}</div>}
      </div>
      <button type="button" className="btn primary" style={{ flex: "none" }} onClick={go}>
        Entrar
      </button>
    </div>
  );
}

void loadDevice;
