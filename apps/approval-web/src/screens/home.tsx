import { useCallback, useEffect, useState } from "react";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { errorText, useApp } from "../app";
import { api, ApiError } from "../lib/api";
import { now, sendSigned, short, sol } from "../lib/chain";
import { verifyAccountOnChain } from "@duplachave/custody/src/client";
import { Icon, Logo } from "../icons";
import QRCode from "qrcode";
import type { VersionedTransaction as VTx } from "@solana/web3.js";
import { reviewSecurityRequest, verifyAuthorized } from "@duplachave/custody/src/client";
import { useChanges } from "./security";

export type AccountView = {
  account: { id: string; multisig: string; vault: string; roles: { client: string; server: string; executor: string; proposer: string }; frozenBy: string | null };
  invariantOk: boolean;
  vaultLamports: string;
  walletLamports: string;
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
    <nav className="tabs" aria-label="Navegação">
      {tab("/", "home", "Início")}
      {tab("/activity", "list", "Atividade")}
      {tab("/security", "shield", "Segurança")}
    </nav>
  );
}

const STATUS: Record<string, string> = {
  AWAITING_CLIENT: "Aguardando você",
  EXECUTING: "Executando",
  APPROVED_PENDING_EXECUTION: "Aguardando execução",
  CANCELLED: "Cancelada",
  EXECUTED: "Executada",
  REJECTED: "Recusada",
  EXPIRED: "Expirada",
  FAILED: "Falhou",
};

export function intentTitle(i: IntentView) {
  if (i.intent.type === "ROTATE_MEMBER") return i.intent.role === "CLIENT" ? "Troca da sua carteira" : "Troca da chave do serviço";
  return `Enviar ${sol(i.intent.amountLamports)} SOL`;
}

export function IntentRow({ i }: { i: IntentView }) {
  const { go } = useApp();
  const rot = i.intent.type === "ROTATE_MEMBER";
  const icon = rot ? "key" : i.status === "EXECUTED" ? "arrowup" : i.status === "REJECTED" || i.status === "EXPIRED" ? "x" : "send";
  const when = new Date(i.updatedAt * 1000).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  return (
    <button type="button" className="list-row as-button" onClick={() => go(`/intent/${i.intent.id}`)}>
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
          <div style={{ fontSize: 16, fontWeight: 600 }}>Dupla Chave</div>
        </div>
        <button type="button" className="wallet-chip" onClick={() => ctx.go("/security")} aria-label="Carteira e segurança">
          <Icon name="key" size={14} />
          {s.walletName} · <span className="mono">{short(s.publicKey)}</span>
        </button>
      </div>
      <div className="page">
        <div className="card" style={{ borderRadius: 24, padding: 20, gap: 16 }}>
          <div className="row-between">
            <div className="muted" style={{ fontSize: 13 }}>
              Seu Vault
            </div>
            <button
              type="button"
              className="mono subtle copy"
              onClick={async () => {
                if (!acc) return;
                await navigator.clipboard.writeText(acc.account.vault);
                ctx.toast("Endereço do Vault copiado");
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
              <div className="dot" style={{ background: "var(--text)" }}>
                <Icon name="server" size={13} color="#0B0D10" sw={2} />
              </div>
            </div>
            <div className="grow">
              {acc?.account.frozenBy ? (
                <>
                  <b>Troca de carteira em andamento.</b> <span className="muted">Envios pausados.</span>
                </>
              ) : acc && !acc.invariantOk ? (
                <span style={{ color: "var(--danger)" }}>Configuração on-chain diferente do esperado. Não assine nada.</span>
              ) : (
                <>
                  <b>Proteção 2 de 3.</b> <span className="muted">Sua {s.walletName} + a biometria; o serviço confere e executa.</span>
                </>
              )}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button type="button" className="btn primary" style={{ flex: 1 }} disabled={!acc || Boolean(acc.account.frozenBy)} onClick={() => ctx.go("/send")}>
            <Icon name="send" color="#0B0D10" sw={2} /> Enviar
          </button>
          <button type="button" className="btn" style={{ flex: 1 }} disabled={!acc} onClick={() => ctx.go("/deposit")}>
            <Icon name="arrowdown" /> Depositar
          </button>
        </div>

        {pendingChanges.length > 0 && (
          <button type="button" className="banner warn" style={{ textAlign: "left", cursor: "pointer", border: 0 }} onClick={() => ctx.go("/security")}>
            <Icon name="clock" size={18} color="#F2B33D" />
            <div>
              <b>Há uma troca de chave pendente.</b> Executa em até 72 h. Não foi você? Abra e toque em "Não fui eu". <u>Abrir</u>
            </div>
          </button>
        )}

        {acc && BigInt(acc.walletLamports) < WALLET_NEEDS && (
          <div className="banner warn">
            <Icon name="shieldalert" size={18} color="#F2B33D" />
            <div>
              Sua {s.walletName} tem {sol(acc.walletLamports, 6)} SOL. Ela paga as taxas: para assinar, precisa ter ~0,007 SOL (quase tudo volta na mesma transação; o custo real é ~0,000015 SOL).
            </div>
          </div>
        )}

        {pending.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="section-title">
              <span>Aguardando sua assinatura</span>
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
                      {rot ? intentTitle(i) : `Para ${short(i.intent.destination)}`} · {i.status === "APPROVED_PENDING_EXECUTION" ? "aguardando execução" : `expira em ${mins} min`}
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
            Recentes
          </div>
          {recent.length === 0 && <div className="subtle" style={{ fontSize: 13, padding: "10px 0" }}>Nada por aqui ainda. Comece depositando SOL no seu Vault.</div>}
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
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="btn small" style={{ flex: 1 }} disabled={busy} onClick={() => run(async () => { await api("POST", "/v1/dev/airdrop", { address: vault, sol: 10 }); ctx.toast("10 SOL de teste no Vault"); })}>
          <Icon name="drop" size={16} /> 10 SOL no Vault
        </button>
        <button type="button" className="btn small" style={{ flex: 1 }} disabled={busy} onClick={() => run(async () => { await api("POST", "/v1/dev/airdrop", { address: ctx.session!.publicKey, sol: 5 }); ctx.toast("5 SOL de teste na sua carteira"); })}>
          <Icon name="drop" size={16} /> 5 SOL na carteira
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
            ctx.toast("Pedido feito: executa depois do prazo, em Segurança.");
            ctx.go("/security");
          })
        }
      >
        <Icon name="server" size={16} /> Simular pedido de troca da chave do serviço
      </button>
      <label className="toggle">
        <input type="checkbox" checked={ctx.dev.malicious} onChange={(e) => ctx.dev.setMalicious(e.target.checked)} />
        Simular servidor malicioso (mostra 1/10 do valor real)
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
    const params = new URLSearchParams({ label: "Dupla Chave", message: "Depósito no seu Vault" });
    if (/^\d+(\.\d{1,9})?$/.test(amt)) params.set("amount", amt);
    void QRCode.toDataURL(`solana:${acc.account.vault}?${params.toString()}`, { margin: 1, width: 480 }).then(setQr);
  }, [viaPhone, acc, amount]);

  const submit = async () => {
    if (!acc) return;
    setBusy(true);
    setErr(null);
    try {
      const s = amount.trim().replace(",", ".");
      if (!/^\d+(\.\d{1,9})?$/.test(s)) throw new Error("valor inválido");
      const [i, f = ""] = s.split(".");
      const lamports = BigInt(i!) * BigInt(LAMPORTS_PER_SOL) + BigInt(f.padEnd(9, "0"));
      const c = await ctx.accountWallet();
      // O Vault de destino é conferido na chain: 2-de-2 com esta carteira, não um endereço que o servidor disse.
      const vault = await verifyAccountOnChain(ctx.chain, acc.account.multisig, new PublicKey(c.publicKey));
      if (vault !== acc.account.vault) throw new Error("o Vault informado não é o desta conta");
      const msg = new TransactionMessage({
        payerKey: new PublicKey(c.publicKey),
        recentBlockhash: await ctx.chain.getLatestBlockhash(),
        instructions: [SystemProgram.transfer({ fromPubkey: new PublicKey(c.publicKey), toPubkey: new PublicKey(acc.account.vault), lamports })],
      }).compileToV0Message();
      const signed = await c.signTransaction(new VersionedTransaction(msg));
      await sendSigned(signed);
      ctx.toast(`${sol(lamports, 9)} SOL depositados no Vault`);
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
        <button type="button" className="iconbtn" aria-label="Voltar" onClick={() => ctx.go("/")}>
          <Icon name="back" />
        </button>
        <h1>Depositar no Vault</h1>
      </div>
      <div className="page">
        <div className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
          Sai da sua {ctx.session!.walletName} para o Vault da conta, com a taxa (~0,000005 SOL) paga por ela. Depositar não precisa da aprovação do serviço; sacar, sim.
        </div>
        <div className="card" style={{ gap: 6 }}>
          <div className="muted" style={{ fontSize: 12 }}>
            Na sua carteira
          </div>
          <div className="big" style={{ fontSize: 24 }}>
            {walletBalance === null ? "—" : sol(walletBalance)} SOL
          </div>
        </div>
        <div className="field">
          <label htmlFor="amt">Quantidade (SOL)</label>
          <input id="amt" className="input mono" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1,5" />
        </div>
        {acc && (
          <div className="subtle" style={{ fontSize: 12 }}>
            Ou envie de qualquer lugar para o endereço do Vault: <span className="mono">{acc.account.vault}</span>
          </div>
        )}
        {viaPhone && qr && (
          <div className="card qr-box">
            <img className="qr" src={qr} alt="QR de depósito" />
            <div className="muted" style={{ fontSize: 13, textAlign: "center" }}>
              Escaneie com a carteira do celular. O saldo do Vault atualiza sozinho quando chegar.
            </div>
          </div>
        )}
        {err && <div className="banner danger">{err}</div>}
      </div>
      <div className="actions" style={viaPhone ? { display: "none" } : undefined}>
        <button type="button" className="btn primary" disabled={busy || !amount} onClick={submit}>
          {busy ? <span className="spinner" /> : <Icon name="key" color="#0B0D10" sw={2} />} {ctx.session!.walletName.length <= 12 ? `Assinar na ${ctx.session!.walletName}` : "Assinar na carteira"}
        </button>
      </div>
    </>
  );
}
