import { useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { errorText, useApp } from "../app";
import { api, ApiError } from "../lib/api";
import { now, short, sol } from "../lib/chain";
import { Icon, Logo } from "../icons";

export type AccountView = {
  account: { id: string; multisig: string; vault: string; roles: { client: string; server: string; executor: string; proposer: string }; frozenBy: string | null };
  invariantOk: boolean;
  vaultLamports: string;
};

export type IntentView = {
  intent: any;
  status: string;
  riskFlags: string[];
  reasons: string[];
  signatures: Record<string, string>;
  transactionHash: string;
  updatedAt: number;
  display: { title: string; subtitle: string; rows: { label: string; value: string }[]; warnings: string[] };
};

/** Busca conta + intenções; trata sessão de chave revogada. */
export function useAccount(pollMs = 5000) {
  const ctx = useApp();
  const [acc, setAcc] = useState<AccountView | null>(null);
  const [intents, setIntents] = useState<IntentView[]>([]);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const accountId = ctx.device?.session?.accountId;

  const load = useCallback(async () => {
    if (!accountId) return;
    try {
      const [a, l] = await Promise.all([api<AccountView>("GET", `/v1/accounts/${accountId}/security`), api<{ intents: IntentView[] }>("GET", `/v1/accounts/${accountId}/intents`)]);
      setAcc(a);
      setIntents(l.intents);
      // Saldo lido pela RPC do app, não pela API.
      setBalance(await ctx.chain.getBalance(new PublicKey(a.account.vault)));
      setErr(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && ctx.device) {
        await ctx.setDevice({ ...ctx.device, session: null });
        return;
      }
      setErr(errorText(e));
    }
  }, [accountId, ctx]);

  useEffect(() => {
    void load();
    const t = setInterval(load, pollMs);
    return () => clearInterval(t);
  }, [load, pollMs]);

  return { acc, intents, balance, err, reload: load };
}

export function Tabs() {
  const { route, go } = useApp();
  const tab = (path: string, icon: string, label: string) => (
    <button type="button" className={route === path ? "on" : ""} onClick={() => go(path)}>
      <Icon name={icon} size={22} />
      {label}
    </button>
  );
  return (
    <nav className="tabs" aria-label="Navegação">
      {tab("/", "home", "Início")}
      {tab("/activity", "list", "Atividade")}
      {tab("/security", "shield", "Segurança")}
    </nav>
  );
}

const STATUS: Record<string, string> = {
  AWAITING_CLIENT: "Aguardando você",
  AWAITING_SERVER: "Com o serviço",
  EXECUTING: "Executando",
  EXECUTED: "Executada",
  REJECTED: "Rejeitada",
  EXPIRED: "Expirada",
  FAILED: "Falhou",
};

export function intentTitle(i: IntentView) {
  if (i.intent.type === "ROTATE_MEMBER") return i.intent.role === "CLIENT" ? "Troca da sua chave" : "Troca da chave do serviço";
  return `Enviar ${sol(i.intent.amountLamports)} SOL`;
}

export function IntentRow({ i }: { i: IntentView }) {
  const { go } = useApp();
  const rot = i.intent.type === "ROTATE_MEMBER";
  const icon = rot ? "key" : i.status === "EXECUTED" ? "arrowup" : i.status === "REJECTED" || i.status === "EXPIRED" ? "x" : "send";
  const when = new Date(i.updatedAt * 1000).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  return (
    <button type="button" className="list-row" style={{ background: "none", border: 0, borderTop: "1px solid var(--surface-2)", width: "100%", textAlign: "left", cursor: "pointer", color: "inherit" }} onClick={() => go(`/intent/${i.intent.id}`)}>
      <div className="ico">
        <Icon name={icon} size={18} />
      </div>
      <div className="grow">
        <div className="t">{intentTitle(i)}</div>
        <div className="s">
          {rot ? short(i.intent.newKey) : `Para ${short(i.intent.destination)}`} · {when}
        </div>
      </div>
      <div className="subtle" style={{ fontSize: 12 }}>
        {i.reasons.length && i.status === "REJECTED" ? "Recusada" : STATUS[i.status] ?? i.status}
      </div>
    </button>
  );
}

export function Home() {
  const ctx = useApp();
  const { acc, intents, balance, err, reload } = useAccount();
  const pending = intents.filter((i) => i.status === "AWAITING_CLIENT");
  const recent = intents.filter((i) => i.status !== "AWAITING_CLIENT").slice(0, 5);

  return (
    <>
      <div className="row-between" style={{ padding: "20px 20px 8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Logo />
          <div style={{ fontSize: 16, fontWeight: 600 }}>Dupla Chave</div>
        </div>
        <button type="button" className="iconbtn" aria-label="Segurança" onClick={() => ctx.go("/security")}>
          <Icon name="shieldcheck" />
        </button>
      </div>
      <div className="page">
        <div className="card" style={{ borderRadius: 24, padding: 20, gap: 16 }}>
          <div className="row-between">
            <div className="muted" style={{ fontSize: 13 }}>
              Seu Vault
            </div>
            <div className="muted mono" style={{ fontSize: 12 }}>
              {acc ? short(acc.account.vault) : "…"}
            </div>
          </div>
          <div className="big" style={{ fontSize: 40 }}>
            {balance === null ? "—" : sol(balance)} <span style={{ fontSize: 20, color: "var(--muted)" }}>SOL</span>
          </div>
          <div className="status">
            <div className="dots">
              <div className="dot" style={{ background: "var(--accent)" }}>
                <Icon name="phone" size={14} color="#0B0D10" sw={2} />
              </div>
              <div className="dot" style={{ background: "var(--text)" }}>
                <Icon name="server" size={13} color="#0B0D10" sw={2} />
              </div>
            </div>
            <div className="grow">
              {acc?.account.frozenBy ? (
                <>
                  <b>Troca de chave em andamento.</b> <span className="muted">Envios pausados.</span>
                </>
              ) : acc && !acc.invariantOk ? (
                <span style={{ color: "var(--danger)" }}>Configuração on-chain diferente do esperado. Não aprove nada.</span>
              ) : (
                <>
                  <b>Proteção 2 de 2 ativa.</b> <span className="muted">Nada sai sem você e o serviço.</span>
                </>
              )}
            </div>
          </div>
        </div>

        {pending.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="section-title">
              <span>Aguardando você</span>
              <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
                {pending.length}
              </span>
            </div>
            {pending.map((i) => {
              const rot = i.intent.type === "ROTATE_MEMBER";
              const mins = Math.max(0, Math.ceil((i.intent.expiresAt - now()) / 60));
              return (
                <button type="button" key={i.intent.id} className={`item ${rot ? "warn" : ""}`} onClick={() => ctx.go(`/intent/${i.intent.id}`)}>
                  <div className="ico">
                    <Icon name={rot ? "shieldalert" : "send"} color={rot ? "#F2B33D" : "currentColor"} />
                  </div>
                  <div className="grow">
                    <div className="t">{rot ? "Alteração de segurança" : intentTitle(i)}</div>
                    <div className="s">
                      {rot ? (i.intent.role === "CLIENT" ? "Trocar sua chave de aprovação" : "O serviço pede troca da chave dele") : `Para ${short(i.intent.destination)}`} · expira em {mins} min
                    </div>
                  </div>
                  <Icon name="chev" size={18} color="var(--muted)" />
                </button>
              );
            })}
          </div>
        )}

        <button type="button" className="btn primary" style={{ flex: "none" }} disabled={!acc || Boolean(acc.account.frozenBy)} onClick={() => ctx.go("/send")}>
          <Icon name="send" color="#0B0D10" sw={2} /> Enviar SOL
        </button>

        <div>
          <div className="section-title" style={{ paddingBottom: 6 }}>
            Recentes
          </div>
          {recent.length === 0 && <div className="subtle" style={{ fontSize: 13, padding: "10px 0" }}>Nada por aqui ainda.</div>}
          {recent.map((i) => (
            <IntentRow key={i.intent.id} i={i} />
          ))}
        </div>

        {ctx.config.devTools && acc && <DevTools vault={acc.account.vault} accountId={acc.account.id} reload={reload} />}
        {err && <div className="err">{err}</div>}
      </div>
      <Tabs />
    </>
  );
}

function DevTools({ vault, accountId, reload }: { vault: string; accountId: string; reload: () => Promise<void> }) {
  const ctx = useApp();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      await reload();
    } catch (e) {
      ctx.toast(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dev">
      <div className="title">Ferramentas de teste (localnet)</div>
      <button type="button" className="btn small" disabled={busy} onClick={() => run(async () => { await api("POST", "/v1/dev/airdrop", { address: vault, sol: 10 }); ctx.toast("10 SOL de teste no Vault"); })}>
        <Icon name="drop" size={18} /> Depositar 10 SOL de teste
      </button>
      <button
        type="button"
        className="btn small"
        disabled={busy}
        onClick={() =>
          run(async () => {
            const r = await api("POST", `/v1/dev/accounts/${accountId}/rotations/server`, {});
            ctx.go(`/intent/${r.intent.id}`);
          })
        }
      >
        <Icon name="server" size={18} /> Simular pedido de troca da chave do serviço
      </button>
      <label className="toggle">
        <input type="checkbox" checked={ctx.dev.malicious} onChange={(e) => ctx.dev.setMalicious(e.target.checked)} />
        Simular servidor malicioso (mostra 1/10 do valor real)
      </label>
    </div>
  );
}
