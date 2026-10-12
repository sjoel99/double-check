import { useCallback, useEffect, useState } from "react";
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { errorText, useApp } from "../app";
import { api, ApiError } from "../lib/api";
import { now, parseSol, sendSigned, short, sol } from "../lib/chain";
import { verifyAccountOnChain } from "@duplachave/custody/src/client";
import { Icon, Logo } from "../icons";
import { walletWord } from "../lib/wallets";
import QRCode from "qrcode";
import type { VersionedTransaction as VTx } from "@solana/web3.js";
import { reviewSecurityRequest, verifyAuthorized } from "@duplachave/custody/src/client";
import { useChanges } from "./security";
import { fmtWhen, lang, tr } from "../lib/i18n";

export type AccountView = {
  account: { id: string; multisig: string; vault: string; roles: { client: string; server: string; executor: string; proposer: string }; frozenBy: string | null };
  invariantOk: boolean;
  vaultLamports: string;
  walletLamports: string;
  /** E-mail de alerta (mascarado), ou null se não há. */
  alertEmail: string | null;
  limits?: { maxLamportsPerTx: string };
};

/** Saldo que a carteira precisa ter na hora de assinar: o depósito das contas volta na mesma transação. */
const WALLET_NEEDS = 7_000_000n;

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

/** Busca conta + intenções; sessão de carteira substituída volta para o início. */
export function useAccount(pollMs = 5000) {
  const ctx = useApp();
  const [acc, setAcc] = useState<AccountView | null>(null);
  const [intents, setIntents] = useState<IntentView[]>([]);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const accountId = ctx.session?.accountId;

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
      if (e instanceof ApiError && e.status === 401) return void (await ctx.setSession(null));
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

export function intentTitle(i: IntentView) {
  if (i.intent.type === "ROTATE_MEMBER") return i.intent.role === "CLIENT" ? tr("Troca da sua carteira", "Wallet change") : tr("Troca da chave do serviço", "Service key change");
  return tr(`Enviar ${sol(i.intent.amountLamports)} SOL`, `Send ${sol(i.intent.amountLamports)} SOL`);
}

export function IntentRow({ i }: { i: IntentView }) {
  const { go } = useApp();
  const rot = i.intent.type === "ROTATE_MEMBER";
  const icon = rot ? "key" : i.status === "EXECUTED" ? "arrowup" : i.status === "REJECTED" || i.status === "EXPIRED" ? "x" : "send";
  const when = fmtWhen(i.updatedAt);
  return (
    <button type="button" className="list-row as-button" onClick={() => go(`/intent/${i.intent.id}`)}>
      <div className="ico">
        <Icon name={icon} size={18} />
      </div>
      <div className="grow">
        <div className="t">{intentTitle(i)}</div>
        <div className="s">
          {rot ? short(i.intent.newKey) : tr(`Para ${short(i.intent.destination)}`, `To ${short(i.intent.destination)}`)} · {when}
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
                await navigator.clipboard.writeText(acc.account.vault);
                ctx.toast(tr("Endereço do Vault copiado", "Vault address copied"));
              }}
            >
              {acc ? short(acc.account.vault) : "…"} <Icon name="copy" size={12} />
            </button>
          </div>
          <div className="big" style={{ fontSize: 40 }}>
            {balance === null ? "—" : sol(balance)} <span style={{ fontSize: 20, color: "var(--muted)" }}>SOL</span>
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
                lang === "pt" ? (
                  <>
                    <b>Troca de carteira em andamento.</b> <span className="muted">Envios pausados.</span>
                  </>
                ) : (
                  <>
                    <b>Wallet change in progress.</b> <span className="muted">Sends are paused.</span>
                  </>
                )
              ) : acc && !acc.invariantOk ? (
                <span style={{ color: "var(--danger)" }}>{tr("Configuração on-chain diferente do esperado. Não assine nada.", "On-chain setup is not what we expected. Do not sign anything.")}</span>
              ) : (
                lang === "pt" ? (
                  <>
                    <b>Proteção 2 de 3.</b> <span className="muted">Sua {walletWord(s.walletName)} + a biometria; o serviço confere e executa.</span>
                  </>
                ) : (
                  <>
                    <b>2-of-3 protection.</b> <span className="muted">Your {walletWord(s.walletName)} + biometrics; the service checks and executes.</span>
                  </>
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
            {lang === "pt" ? (
              <div>
                <b>Há uma troca de chave pendente.</b> Executa em até 72 h. Não foi você? Abra e toque em "Não fui eu". <u>Abrir</u>
              </div>
            ) : (
              <div>
                <b>A key change is pending.</b> It runs within 72 h. Wasn't you? Open it and tap "It wasn't me". <u>Open</u>
              </div>
            )}
          </button>
        )}

        {acc && acc.alertEmail === null && (
          <button type="button" className="banner warn" style={{ textAlign: "left", cursor: "pointer", border: 0 }} onClick={() => ctx.go("/security")}>
            <Icon name="shieldalert" size={18} color="#F2B33D" />
            {lang === "pt" ? (
              <div>
                <b>Cadastre um e-mail de alerta.</b> Se alguém pedir para trocar uma chave da sua conta, é ele que avisa a tempo de você tocar em "Não fui eu". <u>Cadastrar</u>
              </div>
            ) : (
              <div>
                <b>Add an alert email.</b> If someone asks to change a key on your account, it warns you in time to tap "It wasn't me". <u>Add</u>
              </div>
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
                      {rot ? intentTitle(i) : tr(`Para ${short(i.intent.destination)}`, `To ${short(i.intent.destination)}`)} · {i.status === "APPROVED_PENDING_EXECUTION" ? tr("aguardando execução", "waiting to execute") : tr(`expira em ${mins} min`, `expires in ${mins} min`)}
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
          {recent.length === 0 && <div className="subtle" style={{ fontSize: 13, padding: "10px 0" }}>{tr("Nada por aqui ainda. Comece depositando SOL no seu Vault.", "Nothing here yet. Start by depositing SOL into your Vault.")}</div>}
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
      <div className="title">{tr("Ferramentas de teste (localnet)", "Test tools (localnet)")}</div>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="btn small" style={{ flex: 1 }} disabled={busy} onClick={() => run(async () => { await api("POST", "/v1/dev/airdrop", { address: vault, sol: 10 }); ctx.toast(tr("10 SOL de teste no Vault", "10 test SOL in the Vault")); })}>
          <Icon name="drop" size={16} /> {tr("10 SOL no Vault", "10 SOL to Vault")}
        </button>
        <button type="button" className="btn small" style={{ flex: 1 }} disabled={busy} onClick={() => run(async () => { await api("POST", "/v1/dev/airdrop", { address: ctx.session!.publicKey, sol: 5 }); ctx.toast(tr("5 SOL de teste na sua carteira", "5 test SOL in your wallet")); })}>
          <Icon name="drop" size={16} /> {tr("5 SOL na carteira", "5 SOL to wallet")}
        </button>
      </div>
      <button
        type="button"
        className="btn small"
        disabled={busy}
        onClick={() =>
          run(async () => {
            // Pedido de troca da chave do serviço: a Phantom vota e paga; executa depois do prazo.
            const r = await api("POST", `/v1/dev/accounts/${accountId}/security-changes/server`, {});
            const sec = await api("GET", `/v1/accounts/${accountId}/security`);
            const review = await reviewSecurityRequest(ctx.chain, r.desc, r.transaction, { client: new PublicKey(sec.account.roles.client), webapp: new PublicKey(sec.account.roles.webapp) });
            const auth = await api("POST", `/v1/security-changes/${r.change.id}/authorize`, { message: Buffer.from(review.message).toString("base64") });
            const tx: VTx = verifyAuthorized(review, auth.transaction, [review.roles.operator, review.roles.server, new PublicKey(r.desc.newKey)]);
            const w = await ctx.accountWallet();
            await api("POST", `/v1/security-changes/${r.change.id}/submit`, { transaction: await w.signTransaction(tx) });
            ctx.toast(tr("Pedido feito: executa depois do prazo, em Segurança.", "Request made: complete it after the wait, in Security."));
            ctx.go("/security");
          })
        }
      >
        <Icon name="server" size={16} /> {tr("Simular pedido de troca da chave do serviço", "Simulate a service key change request")}
      </button>
      <label className="toggle">
        <input type="checkbox" checked={ctx.dev.malicious} onChange={(e) => ctx.dev.setMalicious(e.target.checked)} />
        {tr("Simular servidor malicioso (mostra 1/10 do valor real)", "Simulate a malicious server (shows 1/10 of the real amount)")}
      </label>
    </div>
  );
}

/** Depósito: a carteira assina e paga uma transferência dela para o Vault; o app envia. */
export function Deposit() {
  const ctx = useApp();
  const { acc } = useAccount(15000);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [walletBalance, setWalletBalance] = useState<bigint | null>(null);
  useEffect(() => {
    void ctx.chain.getBalance(new PublicKey(ctx.session!.publicKey)).then(setWalletBalance).catch(() => {});
  }, [ctx.chain, ctx.session]);

  const viaPhone = ctx.session?.via === "phone";
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    // Celular: QR de transferência do Solana Pay — a carteira envia direto para o Vault.
    if (!viaPhone || !acc) return;
    const amt = amount.trim().replace(",", ".");
    const params = new URLSearchParams({ label: "Double Check", message: tr("Depósito no seu Vault", "Deposit to your Vault") });
    if (/^\d+(\.\d{1,9})?$/.test(amt)) params.set("amount", amt);
    void QRCode.toDataURL(`solana:${acc.account.vault}?${params.toString()}`, { margin: 1, width: 480 }).then(setQr);
  }, [viaPhone, acc, amount]);

  const submit = async () => {
    if (!acc) return;
    setBusy(true);
    setErr(null);
    try {
      const lamports = parseSol(amount);
      if (!lamports) throw new Error(tr("Use um número maior que zero, com até 9 casas decimais (por exemplo 0,5).", "Enter a number greater than zero, with up to 9 decimal places (for example 0.5)."));
      const c = await ctx.accountWallet();
      // O Vault de destino é conferido na chain: 2-de-2 com esta carteira, não um endereço que o servidor disse.
      const vault = await verifyAccountOnChain(ctx.chain, acc.account.multisig, new PublicKey(c.publicKey));
      if (vault !== acc.account.vault) throw new Error(tr("o Vault informado não é o desta conta", "the Vault given is not this account's Vault"));
      const msg = new TransactionMessage({
        payerKey: new PublicKey(c.publicKey),
        recentBlockhash: await ctx.chain.getLatestBlockhash(),
        instructions: [SystemProgram.transfer({ fromPubkey: new PublicKey(c.publicKey), toPubkey: new PublicKey(acc.account.vault), lamports })],
      }).compileToV0Message();
      const signed = await c.signTransaction(new VersionedTransaction(msg));
      await sendSigned(signed);
      ctx.toast(tr(`${sol(lamports, 9)} SOL depositados no Vault`, `${sol(lamports, 9)} SOL deposited to the Vault`));
      ctx.go("/");
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="topbar">
        <button type="button" className="iconbtn" aria-label={tr("Voltar", "Back")} onClick={() => ctx.go("/")}>
          <Icon name="back" />
        </button>
        <h1>{tr("Depositar no Vault", "Deposit to Vault")}</h1>
      </div>
      <div className="page">
        <div className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
          {tr(
            `Sai da sua ${walletWord(ctx.session!.walletName)} para o Vault da conta, com a taxa (~0,000005 SOL) paga por ela. Depositar não precisa da aprovação do serviço; sacar, sim.`,
            `Moves from your ${walletWord(ctx.session!.walletName)} to the account's Vault; it pays the fee (~0.000005 SOL). Deposits don't need the service's approval; withdrawals do.`,
          )}
        </div>
        <div className="card" style={{ gap: 6 }}>
          <div className="muted" style={{ fontSize: 12 }}>
            {tr("Na sua carteira", "In your wallet")}
          </div>
          <div className="big" style={{ fontSize: 24 }}>
            {walletBalance === null ? "—" : sol(walletBalance)} SOL
          </div>
        </div>
        <div className="field">
          <label htmlFor="amt">{tr("Quantidade (SOL)", "Amount (SOL)")}</label>
          <input id="amt" className="input mono" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={tr("1,5", "1.5")} />
        </div>
        {acc && (
          <div className="card" style={{ gap: 8 }}>
            <div className="row-between">
              <div className="muted" style={{ fontSize: 12 }}>
                {tr("Ou envie de qualquer carteira para o endereço do Vault", "Or send from any wallet to the Vault address")}
              </div>
              <button
                type="button"
                className="linkbtn small"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(acc.account.vault);
                    ctx.toast(tr("Endereço do Vault copiado", "Vault address copied"));
                  } catch {
                    ctx.toast(tr("Não deu para copiar; selecione o endereço.", "Couldn't copy; select the address."));
                  }
                }}
              >
                {tr("Copiar", "Copy")}
              </button>
            </div>
            <div className="mono" style={{ fontSize: 13, wordBreak: "break-all", lineHeight: 1.5 }}>
              {acc.account.vault}
            </div>
          </div>
        )}
        {viaPhone && qr && (
          <div className="card qr-box">
            <img className="qr" src={qr} alt={tr("QR de depósito", "Deposit QR code")} />
            <div className="muted" style={{ fontSize: 13, textAlign: "center" }}>
              {tr("Escaneie com a carteira do celular. O saldo do Vault atualiza sozinho quando chegar.", "Scan with your phone wallet. The Vault balance updates on its own when it arrives.")}
            </div>
          </div>
        )}
        {err && <div className="banner danger">{err}</div>}
      </div>
      <div className="actions" style={viaPhone ? { display: "none" } : undefined}>
        <button type="button" className="btn primary" disabled={busy || !amount} onClick={submit}>
          {busy ? <span className="spinner" /> : <Icon name="key" color="#0B0D10" sw={2} />} {walletWord(ctx.session!.walletName).length <= 12 ? tr(`Assinar na ${walletWord(ctx.session!.walletName)}`, `Sign with ${walletWord(ctx.session!.walletName)}`) : tr("Assinar na carteira", "Sign with wallet")}
        </button>
      </div>
    </>
  );
}
