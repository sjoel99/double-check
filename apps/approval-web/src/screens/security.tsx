import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { readMultisig, type MultisigState } from "@duplachave/squads";
import { possessionMessage, type PossessionFields } from "@duplachave/crypto";
import { errorText, useApp } from "../app";
import { api } from "../lib/api";
import { now, short } from "../lib/chain";
import type { StandardWallet } from "../lib/wallets";
import { Icon } from "../icons";
import { IntentRow, Tabs, useAccount } from "./home";
import { WalletList } from "./welcome";
import { PhoneQr, SCAN_STEPS } from "../components/PhoneQr";

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
  const [, setTick] = useState(0);
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
  const me = ctx.session?.publicKey;
  const voters = state?.members.filter((m) => m.vote) ?? [];
  const ok = Boolean(state && state.threshold === 2 && voters.length === 2 && voters.some((v) => v.key === me) && state.configAuthority === PublicKey.default.toBase58());
  return { state, ok, ago: checkedAt ? now() - checkedAt : null };
}

export function Security() {
  const ctx = useApp();
  const { acc } = useAccount(8000);
  const { state, ok, ago } = useOnchainCheck(acc?.account.multisig);
  const roles = acc?.account.roles;
  const s = ctx.session!;
  const order = (k: string) => [roles?.client, roles?.server, roles?.executor, roles?.proposer].indexOf(k) + 1 || 9;
  const label = (k: string) =>
    k === roles?.client
      ? { icon: "key", title: `Sua carteira (${s.walletName})`, sub: "assina suas transações", role: "Aprova e executa", accent: true }
      : k === roles?.server
        ? { icon: "server", title: "Chave do serviço", sub: "confere a política", role: "Aprova", accent: false }
        : k === roles?.executor
          ? { icon: "bolt", title: "Executor do serviço", sub: "não aprova", role: "Executa", accent: false }
          : k === roles?.proposer
            ? { icon: "send", title: "Proponente do serviço", sub: "não aprova", role: "Propõe", accent: false }
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
          <div style={{ fontSize: 13, color: "#b4bac4", lineHeight: 1.45 }}>Todo envio e toda troca de chave precisam da sua carteira e da aprovação do serviço. Nenhuma chave sozinha move fundos.</div>
          {state && (
            <div className="subtle mono" style={{ fontSize: 11 }}>
              multisig {short(state.address)} · índice {state.transactionIndex.toString()} · sem config authority
            </div>
          )}
        </div>
        <div>
          <div className="section-title" style={{ paddingBottom: 4 }}>
            Chaves da conta
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
        <button type="button" className="btn" style={{ height: 52 }} onClick={() => ctx.go("/rotate")} disabled={Boolean(acc?.account.frozenBy)}>
          <Icon name="key" size={18} /> Trocar a carteira da conta
        </button>
        <button
          type="button"
          className="linkbtn"
          onClick={async () => {
            await ctx.wallet?.disconnect();
            await ctx.setSession(null);
            ctx.go("/");
          }}
        >
          Sair
        </button>
        <div style={{ display: "flex", gap: 10, fontSize: 12, color: "var(--subtle)", lineHeight: 1.5 }}>
          <Icon name="lock" size={14} />
          <div>Perder o acesso à sua carteira (seed phrase) sem trocar antes bloqueia a conta. A recuperação ainda não está disponível neste modo.</div>
        </div>
      </div>
      <Tabs />
    </>
  );
}

// ---------------------------------------------------------------- troca de carteira

type RotateStep = { kind: "start" } | { kind: "connect"; rotationId: string; fields: Omit<PossessionFields, "publicKey"> } | { kind: "approve"; intentId: string; newKey: string };

export function RotateWallet() {
  const ctx = useApp();
  const s = ctx.session!;
  const [step, setStep] = useState<RotateStep>({ kind: "start" });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const start = async () => {
    setErr(null);
    setBusy("Pedindo a troca…");
    try {
      const r = await api("POST", `/v1/accounts/${s.accountId}/rotations/client`, {});
      // Lembra que a troca foi pedida aqui: o app recusa aprovar troca que não pediu.
      await ctx.setSession({ ...s, myRotations: [...s.myRotations, r.rotationId].slice(-20) });
      setStep({ kind: "connect", rotationId: r.rotationId, fields: r.fields });
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const pickNew = async (w: StandardWallet) => {
    if (step.kind !== "connect") return;
    setErr(null);
    try {
      setBusy(`Conectando à ${w.name}…`);
      const c = await ctx.connect(w);
      if (c.publicKey === s.publicKey) throw new Error(`Essa é a carteira atual. Na ${w.name}, troque para outra conta (ou escolha outra carteira) e tente de novo.`);
      setBusy(`Assine na ${w.name} para provar que a carteira nova é sua…`);
      const fields = { ...step.fields, publicKey: c.publicKey };
      const signature = await c.signMessage(possessionMessage(fields));
      setBusy("Preparando a troca na Solana…");
      const r = await api("POST", `/v1/rotations/${step.rotationId}/proof`, { proof: { ...fields, signature } });
      setStep({ kind: "approve", intentId: r.intent.id, newKey: c.publicKey });
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const stepDot = (n: number, done: boolean, active: boolean) => (
    <div className="step-n" style={{ background: done ? "var(--accent)" : active ? "var(--text)" : "var(--surface-2)", color: done || active ? "#0B0D10" : "var(--muted)" }}>
      {done ? <Icon name="check" size={14} color="#0B0D10" sw={2.4} /> : n}
    </div>
  );
  const idx = step.kind === "start" ? 0 : step.kind === "connect" ? 1 : 2;

  return (
    <>
      <TopBar title="Trocar carteira" back="/security" />
      <div className="page">
        <div className="steps">
          {[
            ["Pedir a troca", "com a carteira atual conectada"],
            ["Conectar a carteira nova", "ela assina um texto provando que é sua"],
            ["Assinar com a carteira atual", "a troca acontece numa transação só"],
          ].map(([t, sub], i) => (
            <div key={t} className="step">
              {stepDot(i + 1, i < idx, i === idx)}
              <div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{t}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {sub}
                </div>
              </div>
            </div>
          ))}
        </div>

        {step.kind === "start" && (
          <>
            <div className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
              A carteira nova entra e a atual (<span className="mono">{short(s.publicKey)}</span>, {s.walletName}) sai, na mesma transação da Solana, assinada e paga pela carteira atual (~0,000015 SOL) e aprovada pelo serviço.
            </div>
            <button type="button" className="btn primary" disabled={Boolean(busy)} onClick={start}>
              Começar
            </button>
          </>
        )}

        {step.kind === "connect" && (
          <>
            <div className="card">
              <PhoneQr
                create={() => api("POST", `/v1/rotations/${step.rotationId}/pay-proof`, {})}
                title="Escaneie com a carteira NOVA"
                steps={["Na carteira do celular, abra a conta nova (ou outra carteira)", "Escaneie e confirme: ela só prova que é sua (taxa de 0,000005 SOL, paga por ela)"]}
                onDone={(r: { intentId: string; newKey: string }) => setStep({ kind: "approve", intentId: r.intentId, newKey: r.newKey })}
              />
            </div>
            <div className="or">ou com uma extensão deste navegador</div>
            <WalletList onPick={pickNew} busy={Boolean(busy)} exclude={s.walletName} />
          </>
        )}

        {step.kind === "approve" && (
          <>
            <div className="card" style={{ gap: 8 }}>
              <div className="muted" style={{ fontSize: 13 }}>
                Carteira nova (posse conferida)
              </div>
              <div className="big" style={{ fontSize: 22 }}>
                {short(step.newKey)}
              </div>
            </div>
            <div className="banner warn">
              <Icon name="shieldalert" size={18} color="#F2B33D" />
              <div>
                Agora volte para a carteira <b>atual</b> (<span className="mono">{short(s.publicKey)}</span>) e assine a troca. O serviço já conferiu a política; a carteira atual paga a taxa.
              </div>
            </div>
            <button type="button" className="btn amber" onClick={() => ctx.go(`/intent/${step.intentId}`)}>
              <Icon name="key" color="#0B0D10" sw={2} /> Revisar e assinar a troca
            </button>
          </>
        )}

        {busy && (
          <div className="status">
            <span className="spinner" /> {busy}
          </div>
        )}
        {err && <div className="banner danger">{err}</div>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- atividade

export function Activity() {
  const ctx = useApp();
  const { intents } = useAccount(6000);
  const [audit, setAudit] = useState<{ seq: number; type: string; at: number; hash: string }[]>([]);
  useEffect(() => {
    const id = ctx.session?.accountId;
    if (id) void api("GET", `/v1/accounts/${id}/audit`).then((r) => setAudit(r.events.slice().reverse())).catch(() => {});
  }, [ctx.session, intents.length]);
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
