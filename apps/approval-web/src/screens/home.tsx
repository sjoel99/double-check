import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { errorText, useApp } from "../app";
import { api, ApiError, setUnauthorizedHandler } from "../lib/api";
import { now, short, sol } from "../lib/chain";
import { Icon, Logo } from "../icons";
import { walletWord } from "../lib/wallets";
import { useChanges } from "../hooks/useChanges";
import { fmtWhen, tr, trn } from "../lib/i18n";
import type { TransactionIntent } from "@duplachave/shared";
import { usePolling } from "../hooks/usePolling";
import { useTitle } from "../hooks/useTitle";

// As ferramentas de teste puxam a conferência de transações (SDK da Squads): só em localnet, e sob demanda.
const DevTools = lazy(() => import("./devtools").then((m) => ({ default: m.DevTools })));

type AccountView = {
  account: { id: string; multisig: string; vault: string; roles: { client: string; webapp: string; server: string; operator: string }; frozenBy: string | null };
  invariantOk: boolean;
  vaultLamports: string;
  walletLamports: string;
  /** E-mail de alerta (mascarado), ou null se não há. */
  alertEmail: string | null;
  limits?: { maxLamportsPerTx: string };
  /** Aparelhos com a cópia cifrada da chave atual do webapp. */
  webappDevices?: { deviceName: string; createdAt: number }[];
};

/** Saldo que a carteira precisa ter na hora de assinar: o depósito das contas volta na mesma transação. */
const WALLET_NEEDS = 7_000_000n;

export type IntentView = {
  intent: TransactionIntent;
  status: string;
  riskFlags: string[];
  reasons: string[];
  signatures: Record<string, string>;
  transactionHash: string;
  updatedAt: number;
  display: { title: string; subtitle: string; rows: { label: string; value: string }[]; warnings: string[] };
};

/**
 * Busca conta + intenções; sessão de carteira substituída volta para o início.
 * As duas chamadas são independentes: a conta lê a chain no serviço (e falha
 * quando a RPC falha), a lista de intenções não pode sumir por causa disso.
 * `intentsLoaded`: a lista já veio ao menos uma vez (vazia ≠ ainda carregando).
 */
export function useAccount(pollMs = 5000) {
  const ctx = useApp();
  const [acc, setAcc] = useState<AccountView | null>(null);
  const [intents, setIntents] = useState<IntentView[]>([]);
  const [intentsLoaded, setIntentsLoaded] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const accountId = ctx.session?.accountId;
  const { chain, setSession, toast } = ctx;

  // Qualquer 401 do serviço (sessão de 12 h vencida, carteira trocada) derruba a sessão,
  // em qualquer tela: sem isso a pessoa ficava presa numa tela que nunca mais funcionaria.
  useEffect(
    () =>
      setUnauthorizedHandler(() => {
        toast(tr("Sua sessão venceu; entre de novo.", "Your session expired; sign in again."));
        void setSession(null);
      }),
    [setSession, toast],
  );

  const load = useCallback(async () => {
    if (!accountId) return;
    const [a, l] = await Promise.allSettled([api<AccountView>("GET", `/v1/accounts/${accountId}/security`), api<{ intents: IntentView[] }>("GET", `/v1/accounts/${accountId}/intents`)]);
    if (l.status === "fulfilled") {
      setIntents(l.value.intents);
      setIntentsLoaded(true);
    }
    try {
      if (a.status === "rejected") throw a.reason;
      setAcc(a.value);
      // Saldo lido pela RPC do app, não pela API.
      setBalance(await chain.getBalance(new PublicKey(a.value.account.vault)));
      if (l.status === "rejected") throw l.reason;
      setErr(null);
    } catch (e) {
      // 401: o tratador central já derrubou a sessão e avisou.
      if (e instanceof ApiError && e.status === 401) return;
      setErr(errorText(e));
    }
  }, [accountId, chain]);

  // Só com a aba visível; ao voltar para ela, carrega na hora.
  usePolling(load, pollMs);

  return { acc, intents, intentsLoaded, balance, err, reload: load };
}

export function Tabs() {
  const { route, go } = useApp();
  const tab = (path: string, icon: string, label: string) => (
    <button type="button" className={route === path ? "on" : ""} aria-current={route === path ? "page" : undefined} onClick={() => go(path)}>
      <Icon name={icon} size={22} />
      {label}
    </button>
  );
  return (
    <nav className="tabs" aria-label={tr("Navegação", "Navigation")}>
      {tab("/", "home", tr("Início", "Home"))}
      {tab("/activity", "list", tr("Atividade", "Activity"))}
      {tab("/security", "shield", tr("Segurança", "Security"))}
    </nav>
  );
}

const STATUS: Record<string, string> = {
  AWAITING_CLIENT: tr("Aguardando você", "Waiting for you"),
  EXECUTING: tr("Executando", "Executing"),
  APPROVED_PENDING_EXECUTION: tr("Aguardando execução", "Waiting to execute"),
  CANCELLED: tr("Cancelada", "Cancelled"),
  EXECUTED: tr("Executada", "Done"),
  REJECTED: tr("Cancelada", "Cancelled"),
  EXPIRED: tr("Expirada", "Expired"),
  FAILED: tr("Falhou", "Failed"),
};

function intentTitle(i: IntentView) {
  if (i.intent.type === "ROTATE_MEMBER") return i.intent.role === "CLIENT" ? tr("Troca da sua carteira", "Wallet change") : tr("Troca da chave do serviço", "Service key change");
  // Só TRANSFER_SOL existe hoje (o serviço não cria TRANSFER_TOKEN).
  const amount = i.intent.type === "TRANSFER_SOL" ? sol(i.intent.amountLamports) : "?";
  return tr(`Enviar ${amount} SOL`, `Send ${amount} SOL`);
}

export function IntentRow({ i }: { i: IntentView }) {
  const { go } = useApp();
  const rot = i.intent.type === "ROTATE_MEMBER";
  const icon = rot ? "key" : i.status === "EXECUTED" ? "arrowup" : i.status === "REJECTED" || i.status === "EXPIRED" ? "x" : "send";
  return (
    <button type="button" className="list-row as-button" onClick={() => go(`/intent/${i.intent.id}`)}>
      <div className="ico">
        <Icon name={icon} size={18} />
      </div>
      <div className="grow">
        <div className="t">{intentTitle(i)}</div>
        <div className="s">
          {i.intent.type === "ROTATE_MEMBER" ? short(i.intent.newKey) : tr(`Para ${short(i.intent.destination)}`, `To ${short(i.intent.destination)}`)} · {fmtWhen(i.updatedAt)}
        </div>
      </div>
      <div className="subtle" style={{ fontSize: 12 }}>
        {STATUS[i.status] ?? i.status}
      </div>
    </button>
  );
}

export function Home() {
  const ctx = useApp();
  const { acc, intents, balance, err, reload } = useAccount();
  const pending = intents.filter((i) => i.status === "AWAITING_CLIENT" || i.status === "APPROVED_PENDING_EXECUTION");
  const recent = intents.filter((i) => !pending.includes(i)).slice(0, 5);
  const s = ctx.session!;
  const { pending: pendingChanges } = useChanges(15000);
  useTitle(tr("Início", "Home"));
  // Sem dado e sem erro: esqueleto (ainda carregando). Com erro e sem dado: "—".
  const loading = !err;

  return (
    <>
      <div className="row-between" style={{ padding: "20px 20px 8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Logo />
          <div style={{ fontSize: 16, fontWeight: 600, whiteSpace: "nowrap" }}>Double Check</div>
        </div>
        <button type="button" className="wallet-chip" onClick={() => ctx.go("/security")} aria-label={tr("Carteira e segurança", "Wallet and security")}>
          <Icon name="key" size={14} />
          <span className="chip-name">{walletWord(s.walletName)}</span> · <span className="mono">{short(s.publicKey)}</span>
        </button>
      </div>
      <div className="page">
        {err && (
          <div className="banner danger" role="alert">
            <Icon name="shieldalert" size={18} color="#FF8F80" />
            <div className="grow">{err}</div>
            <button type="button" className="linkbtn small act" onClick={() => void reload()}>
              {tr("Tentar de novo", "Try again")}
            </button>
          </div>
        )}
        <div className="card" style={{ borderRadius: 24, padding: 20, gap: 16 }}>
          <div className="row-between">
            <div className="muted" style={{ fontSize: 13 }}>
              {tr("Seu Vault", "Your Vault")}
            </div>
            <button
              type="button"
              className="mono subtle copy"
              onClick={async () => {
                if (!acc) return;
                try {
                  await navigator.clipboard.writeText(acc.account.vault);
                  ctx.toast(tr("Endereço do Vault copiado", "Vault address copied"));
                } catch {
                  ctx.toast(tr("Não deu para copiar; abra Depositar e selecione o endereço.", "Couldn't copy; open Deposit and select the address."));
                }
              }}
            >
              {acc ? short(acc.account.vault) : loading ? <span className="skel">XXXX…XXXX</span> : "—"} <Icon name="copy" size={12} />
            </button>
          </div>
          <div className="big" style={{ fontSize: 40 }}>
            {balance === null ? (loading ? <span className="skel">0,0000</span> : "—") : sol(balance)} <span style={{ fontSize: 20, color: "var(--muted)" }}>SOL</span>
          </div>
          <div className="status">
            <div className="dots">
              <div className="dot" style={{ background: "var(--accent)" }}>
                <Icon name="key" size={13} color="#0B0D10" sw={2} />
              </div>
              <div className="dot" style={{ background: "var(--accent)" }}>
                <Icon name="finger" size={13} color="#0B0D10" sw={2} />
              </div>
              <div className="dot" style={{ background: "var(--text)" }}>
                <Icon name="server" size={13} color="#0B0D10" sw={2} />
              </div>
            </div>
            <div className="grow">
              {acc?.account.frozenBy ? (
                trn(
                  <>
                    <b>Troca de carteira em andamento.</b> <span className="muted">Envios pausados.</span>
                  </>,
                  <>
                    <b>Wallet change in progress.</b> <span className="muted">Sends are paused.</span>
                  </>,
                )
              ) : acc && !acc.invariantOk ? (
                <span style={{ color: "var(--danger)" }}>{tr("Configuração on-chain diferente do esperado. Não assine nada.", "On-chain setup is not what we expected. Do not sign anything.")}</span>
              ) : (
                trn(
                  <>
                    <b>Proteção 2 de 3.</b> <span className="muted">Sua {walletWord(s.walletName)} + a biometria; o serviço confere e executa.</span>
                  </>,
                  <>
                    <b>2-of-3 protection.</b> <span className="muted">Your {walletWord(s.walletName)} + biometrics; the service checks and executes.</span>
                  </>,
                )
              )}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button type="button" className="btn primary" style={{ flex: 1 }} disabled={!acc || Boolean(acc.account.frozenBy)} onClick={() => ctx.go("/send")}>
            <Icon name="send" color="#0B0D10" sw={2} /> {tr("Enviar", "Send")}
          </button>
          <button type="button" className="btn" style={{ flex: 1 }} disabled={!acc} onClick={() => ctx.go("/deposit")}>
            <Icon name="arrowdown" /> {tr("Depositar", "Deposit")}
          </button>
        </div>

        {pendingChanges.length > 0 && (
          <button type="button" className="banner warn" style={{ textAlign: "left", cursor: "pointer", border: 0 }} onClick={() => ctx.go("/security")}>
            <Icon name="clock" size={18} color="#F2B33D" />
            {trn(
              <div>
                <b>Há uma troca de chave pendente.</b> Executa em até 72 h. Não foi você? Abra e toque em "Não fui eu". <u>Abrir</u>
              </div>,
              <div>
                <b>A key change is pending.</b> It runs within 72 h. Wasn't you? Open it and tap "It wasn't me". <u>Open</u>
              </div>,
            )}
          </button>
        )}

        {acc && acc.alertEmail === null && (
          <button type="button" className="banner warn" style={{ textAlign: "left", cursor: "pointer", border: 0 }} onClick={() => ctx.go("/security")}>
            <Icon name="shieldalert" size={18} color="#F2B33D" />
            {trn(
              <div>
                <b>Cadastre um e-mail de alerta.</b> Se alguém pedir para trocar uma chave da sua conta, é ele que avisa a tempo de você tocar em "Não fui eu". <u>Cadastrar</u>
              </div>,
              <div>
                <b>Add an alert email.</b> If someone asks to change a key on your account, it warns you in time to tap "It wasn't me". <u>Add</u>
              </div>,
            )}
          </button>
        )}

        {acc && BigInt(acc.walletLamports) < WALLET_NEEDS && (
          <div className="banner warn">
            <Icon name="shieldalert" size={18} color="#F2B33D" />
            <div>
              {tr(
                `Sua ${walletWord(s.walletName)} tem ${sol(acc.walletLamports, 6)} SOL. Ela paga as taxas: para assinar, precisa ter ~0,007 SOL (quase tudo volta na mesma transação; o custo real é ~0,000015 SOL).`,
                `Your ${walletWord(s.walletName)} has ${sol(acc.walletLamports, 6)} SOL. It pays the fees: to sign, it needs ~0.007 SOL (almost all of it comes back in the same transaction; the real cost is ~0.000015 SOL).`,
              )}
            </div>
          </div>
        )}

        {pending.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="section-title">
              <span>{tr("Aguardando sua assinatura", "Waiting for your signature")}</span>
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
                    <div className="t">{rot ? tr("Alteração de segurança", "Security change") : intentTitle(i)}</div>
                    <div className="s">
                      {i.intent.type === "ROTATE_MEMBER" ? intentTitle(i) : tr(`Para ${short(i.intent.destination)}`, `To ${short(i.intent.destination)}`)} · {i.status === "APPROVED_PENDING_EXECUTION" ? tr("aguardando execução", "waiting to execute") : tr(`expira em ${mins} min`, `expires in ${mins} min`)}
                    </div>
                  </div>
                  <Icon name="chev" size={18} color="var(--muted)" />
                </button>
              );
            })}
          </div>
        )}

        <div>
          <div className="section-title" style={{ paddingBottom: 6 }}>
            {tr("Recentes", "Recent")}
          </div>
          {acc && recent.length === 0 && (
            <div className="stack" style={{ padding: "10px 0", alignItems: "flex-start" }}>
              <div className="hint" style={{ fontSize: 13 }}>{tr("Nada por aqui ainda. Comece depositando SOL no seu Vault.", "Nothing here yet. Start by depositing SOL into your Vault.")}</div>
              <button type="button" className="linkbtn small" onClick={() => ctx.go("/deposit")}>
                {tr("Depositar SOL", "Deposit SOL")}
              </button>
            </div>
          )}
          {recent.map((i) => (
            <IntentRow key={i.intent.id} i={i} />
          ))}
        </div>

        {ctx.config.devTools && acc && (
          <Suspense fallback={null}>
            <DevTools vault={acc.account.vault} accountId={acc.account.id} reload={reload} />
          </Suspense>
        )}
      </div>
      <Tabs />
    </>
  );
}
