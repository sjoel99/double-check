import { useCallback, useEffect, useState } from "react";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { readMultisig, type MultisigState } from "@duplachave/squads";
import { emailBindingMessage, emailInput, reviewSecurityRequest, verifyAuthorized, vetoMessage, type SecurityChangeDesc } from "@duplachave/custody/src/client";
import { accountKeyBlobs, errorText, unlockAccountKey, useApp } from "../app";
import { api } from "../lib/api";
import { now, short } from "../lib/chain";
import { type ConnectedWallet, type StandardWallet, walletDisplay } from "../lib/wallets";
import { createWebappKey, deviceName, signatureB58 } from "../lib/webappKey";
import { Icon } from "../icons";
import { IntentRow, Tabs, useAccount } from "./home";
import { WalletList } from "./welcome";
import { TopBar } from "../components/TopBar";
import { fmtWhen, lang, tr } from "../lib/i18n";

type ChangeView = {
  id: string;
  role: "CLIENT" | "WEBAPP" | "SERVER";
  oldKey: string;
  newKey: string;
  status: "PREPARED" | "PENDING" | "EXECUTED" | "VETOED" | "FAILED";
  index: string | null;
  createdAt: number;
  executeAfter: number | null;
};

const ROLE_NAME: Record<ChangeView["role"], string> = { CLIENT: tr("carteira", "wallet"), WEBAPP: tr("chave do webapp", "webapp key"), SERVER: tr("chave do serviço", "service key") };
const fromB64 = (b: string) => VersionedTransaction.deserialize(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));

/** Trocas de chave da conta. */
export function useChanges(pollMs = 8000) {
  const ctx = useApp();
  const [changes, setChanges] = useState<ChangeView[]>([]);
  const load = useCallback(async () => {
    if (!ctx.session) return;
    try {
      setChanges((await api<{ changes: ChangeView[] }>("GET", `/v1/accounts/${ctx.session.accountId}/security-changes`)).changes);
    } catch {
      /* tenta de novo */
    }
  }, [ctx.session]);
  useEffect(() => {
    void load();
    const i = setInterval(load, pollMs);
    return () => clearInterval(i);
  }, [load, pollMs]);
  return { changes, pending: changes.filter((c) => c.status === "PENDING"), reload: load };
}

/** Conferência local: o webapp lê a multisig pela RPC dele e checa o modelo 2 de 3. */
function useOnchainCheck(multisig: string | undefined) {
  const ctx = useApp();
  const [state, setState] = useState<MultisigState | null>(null);
  useEffect(() => {
    if (!multisig) return;
    let on = true;
    const run = () => readMultisig(ctx.chain, new PublicKey(multisig)).then((s) => on && setState(s)).catch(() => {});
    void run();
    const i = setInterval(run, 10_000);
    return () => {
      on = false;
      clearInterval(i);
    };
  }, [multisig, ctx.chain]);
  const voters = state?.members.filter((m) => m.vote) ?? [];
  const ok = Boolean(state && state.threshold === 2 && voters.length === 3 && voters.every((v) => v.mask === 2) && state.members.filter((m) => m.mask & 4).length === 1 && state.configAuthority === PublicKey.default.toBase58());
  return { state, ok };
}

function Countdown({ until }: { until: number }) {
  const [t, setT] = useState(now());
  useEffect(() => {
    const i = setInterval(() => setT(now()), 1000);
    return () => clearInterval(i);
  }, []);
  const left = Math.max(0, until - t);
  return <span className="mono">{left === 0 ? tr("agora", "now") : `${Math.floor(left / 3600)} h ${String(Math.floor((left % 3600) / 60)).padStart(2, "0")} min`}</span>;
}

/**
 * Troca pendente: o que vai mudar, quando executa, "Não fui eu" (assinado pela
 * chave que seria trocada) e "Concluir" depois do prazo.
 */
function PendingChange({ c, onDone }: { c: ChangeView; onDone: () => void }) {
  const ctx = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pickPayer, setPickPayer] = useState(false);
  const due = c.executeAfter !== null && now() >= c.executeAfter;

  const veto = async () => {
    setErr(null);
    try {
      const sec = await api("GET", `/v1/accounts/${ctx.session!.accountId}/security`);
      const text = vetoMessage({ id: c.id, multisig: sec.account.multisig, role: c.role, newKey: c.newKey });
      let publicKey: string;
      let signature: string;
      if (c.role === "CLIENT") {
        setBusy(tr("Assine o veto na carteira atual…", "Sign the veto in your current wallet…"));
        const w = await ctx.accountWallet();
        publicKey = w.publicKey;
        signature = await w.signMessage(text);
      } else {
        setBusy(tr("Confirme com a biometria para vetar…", "Confirm with biometrics to veto…"));
        const key = await unlockAccountKey(ctx, await accountKeyBlobs(`/v1/accounts/${ctx.session!.accountId}/webapp-keys`), tr("Não fui eu: cancelar a troca de chave", "It wasn't me: cancel the key change"));
        try {
          publicKey = key.publicKey.toBase58();
          signature = signatureB58(key.sign(new TextEncoder().encode(text)));
        } finally {
          key.wipe();
        }
      }
      await api("POST", `/v1/security-changes/${c.id}/veto`, { publicKey, signature }, { auth: false });
      ctx.toast(tr("Troca cancelada.", "Change cancelled."));
      onDone();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const execute = async (payerWallet?: ConnectedWallet) => {
    setErr(null);
    try {
      setBusy(tr("Preparando a execução…", "Preparing to execute…"));
      const r = await api<{ transaction: string; payer: string }>("POST", `/v1/security-changes/${c.id}/execute-prepare`, {});
      const w = payerWallet ?? (c.role === "CLIENT" ? null : await ctx.accountWallet());
      if (!w || w.publicKey !== r.payer) {
        setPickPayer(true);
        throw new Error(tr(`Quem paga a conclusão é a carteira ${short(r.payer)}: conecte essa carteira abaixo.`, `The wallet ${short(r.payer)} pays to complete this: connect that wallet below.`));
      }
      setBusy(tr(`Confirme na ${w.name} (ela paga a taxa)…`, `Confirm in ${walletDisplay(w.name)} (it pays the fee)…`));
      const signed = await w.signTransaction(fromB64(r.transaction));
      setBusy(tr("Executando na Solana…", "Executing on Solana…"));
      await api("POST", `/v1/security-changes/${c.id}/execute`, { transaction: signed });
      ctx.toast(tr("Troca concluída.", "Change complete."));
      if (c.role === "CLIENT") {
        await ctx.setSession(null);
        ctx.go("/");
        return;
      }
      onDone();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card" style={{ gap: 10, borderColor: "#5a4a1a" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--warn)", fontSize: 12, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase" }}>
        <Icon name="clock" size={14} color="#F2B33D" /> {tr("Troca de chave pendente", "Pending key change")}
      </div>
      <div style={{ fontSize: 15, lineHeight: 1.45 }}>
        {tr("Trocar a", "Replace the")} <b>{ROLE_NAME[c.role]}</b> <span className="mono">{short(c.oldKey)}</span> → <span className="mono">{short(c.newKey)}</span>
      </div>
      <div className="muted" style={{ fontSize: 13 }}>
        {due ? tr("O prazo passou: pode concluir.", "The wait is over: you can complete it.") : lang === "pt" ? (
          <>
            Executa em <Countdown until={c.executeAfter!} /> ({fmtWhen(c.executeAfter!)}). Não foi você? Vete.
          </>
        ) : (
          <>
            Runs in <Countdown until={c.executeAfter!} /> ({fmtWhen(c.executeAfter!)}). Wasn't you? Veto it.
          </>
        )}
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <button type="button" className="btn" style={{ flex: 1 }} disabled={Boolean(busy)} onClick={veto}>
          {tr("Não fui eu", "It wasn't me")}
        </button>
        {due && (
          <button type="button" className="btn primary" style={{ flex: 1 }} disabled={Boolean(busy)} onClick={() => execute()}>
            {tr("Concluir troca", "Complete change")}
          </button>
        )}
      </div>
      {pickPayer && (
        <WalletList
          busy={Boolean(busy)}
          onPick={async (sw: StandardWallet) => {
            try {
              await execute(await ctx.connect(sw));
            } catch (e) {
              setErr(errorText(e));
            }
          }}
        />
      )}
      {busy && (
        <div className="status">
          <span className="spinner" /> {busy}
        </div>
      )}
      {err && <div className="banner danger">{err}</div>}
    </div>
  );
}

/**
 * E-mail de alerta. Cadastrar ou trocar exige a chave do webapp (biometria) e o
 * código que chega no endereço novo: quem só tem a seed da carteira não desvia os alertas.
 */
function AlertEmail() {
  const ctx = useApp();
  const [current, setCurrent] = useState<string | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<{ challengeId: string; email: string } | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const accountId = ctx.session?.accountId;
  const load = useCallback(() => {
    if (accountId) void api("GET", `/v1/accounts/${accountId}/security`).then((r) => setCurrent(r.alertEmail ?? null)).catch(() => {});
  }, [accountId]);
  useEffect(load, [load]);

  const start = async () => {
    setErr(null);
    const e = emailInput(email);
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e)) return setErr(tr("E-mail inválido.", "Invalid email."));
    try {
      setBusy(tr("Confirme com a biometria…", "Confirm with biometrics…"));
      const sec = await api("GET", `/v1/accounts/${accountId}/security`);
      const key = await unlockAccountKey(ctx, await accountKeyBlobs(`/v1/accounts/${accountId}/webapp-keys`), tr(`Enviar os alertas da conta para ${e}`, `Send account alerts to ${e}`));
      let signature: string;
      try {
        signature = signatureB58(key.sign(new TextEncoder().encode(emailBindingMessage(sec.account.multisig, e))));
      } finally {
        key.wipe();
      }
      setBusy(tr("Enviando o código…", "Sending the code…"));
      const r = await api("POST", `/v1/accounts/${accountId}/email/start`, { email: e, signature });
      setSent({ challengeId: r.challengeId, email: r.email });
      setCode("");
    } catch (x) {
      setErr(errorText(x));
    } finally {
      setBusy(null);
    }
  };

  const confirm = async () => {
    setErr(null);
    try {
      setBusy(tr("Confirmando…", "Confirming…"));
      const r = await api("POST", `/v1/accounts/${accountId}/email/confirm`, { challengeId: sent!.challengeId, code: code.trim() });
      ctx.toast(tr(`Alertas vão para ${r.email}.`, `Alerts go to ${r.email}.`));
      setSent(null);
      setEditing(false);
      setEmail("");
      load();
    } catch (x) {
      setErr(errorText(x));
      // Uma tentativa por código: errou, pede outro.
      setSent(null);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card">
      <div className="row-between">
        <div className="muted" style={{ fontSize: 13 }}>
          {tr("E-mail de alerta", "Alert email")}
        </div>
        {current === undefined ? <span className="spinner" /> : current ? <span className="pill">{tr("Confirmado", "Confirmed")}</span> : <span className="pill danger">{tr("Sem alerta", "No alerts")}</span>}
      </div>
      {!editing && (
        <>
          <div className="mono" style={{ fontSize: 15 }}>
            {current ?? tr("Nenhum", "None")}
          </div>
          <div style={{ fontSize: 13, color: "#b4bac4", lineHeight: 1.45 }}>{tr('Avisa pedidos de troca de chave (a tempo do "Não fui eu"), trocas concluídas e envios.', 'Warns you about key change requests (in time for "It wasn\'t me"), completed changes and sends.')}</div>
          <button type="button" className="btn" style={{ height: 44 }} onClick={() => setEditing(true)}>
            <Icon name="finger" size={16} /> {current ? tr("Trocar o e-mail", "Change email") : tr("Cadastrar e-mail", "Add email")}
          </button>
        </>
      )}
      {editing && !sent && (
        <>
          <div className="field">
            <label htmlFor="alert-email">{tr("E-mail", "Email")}</label>
            <input id="alert-email" className="input" type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={tr("voce@exemplo.com", "you@example.com")} />
          </div>
          <button type="button" className="btn primary" style={{ height: 44 }} disabled={!!busy || !email} onClick={start}>
            {busy ?? tr("Confirmar com a biometria e enviar código", "Confirm with biometrics and send code")}
          </button>
          <button type="button" className="linkbtn" onClick={() => (setEditing(false), setErr(null))}>
            {tr("Cancelar", "Cancel")}
          </button>
        </>
      )}
      {sent && (
        <>
          <div style={{ fontSize: 13, color: "#b4bac4" }}>{tr(`Enviamos um código de 6 dígitos para ${sent.email}. Vale por 10 minutos.`, `We sent a 6-digit code to ${sent.email}. It's valid for 10 minutes.`)}</div>
          <div className="field">
            <label htmlFor="alert-code">{tr("Código", "Code")}</label>
            <input id="alert-code" className="input mono" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="000000" />
          </div>
          <button type="button" className="btn primary" style={{ height: 44 }} disabled={!!busy || code.length !== 6} onClick={confirm}>
            {busy ?? tr("Confirmar", "Confirm")}
          </button>
        </>
      )}
      {err && <div className="err">{err}</div>}
    </div>
  );
}

export function Security() {
  const ctx = useApp();
  const { acc } = useAccount(8000);
  const { state, ok } = useOnchainCheck(acc?.account.multisig);
  const { pending, reload } = useChanges();
  const devices = acc?.webappDevices ?? [];
  const roles = acc?.account.roles;
  const label = (k: string) =>
    k === roles?.client
      ? { icon: "key", title: tr("Sua carteira", "Your wallet"), sub: tr("vota e paga", "votes and pays"), role: tr("Vota", "Votes"), accent: true }
      : k === roles?.webapp
        ? { icon: "finger", title: tr("Chave do webapp", "Webapp key"), sub: tr("aberta pela biometria", "unlocked by biometrics"), role: tr("Vota", "Votes"), accent: true }
        : k === roles?.server
          ? { icon: "server", title: tr("Chave do serviço", "Service key"), sub: tr("só em recuperação, com prazo", "recovery only, with a wait"), role: tr("Vota", "Votes"), accent: false }
          : k === roles?.operator
            ? { icon: "bolt", title: tr("Operador do serviço", "Service operator"), sub: tr("não vota", "doesn't vote"), role: tr("Executa", "Executes"), accent: false }
            : { icon: "shieldalert", title: tr("Chave desconhecida", "Unknown key"), sub: tr("não esperada", "not expected"), role: "?", accent: false };
  const order = (k: string) => [roles?.client, roles?.webapp, roles?.server, roles?.operator].indexOf(k) + 1 || 9;
  const open = pending.length > 0;

  return (
    <>
      <TopBar title={tr("Segurança", "Security")} back={null} />
      <div className="page">
        {pending.map((c) => (
          <PendingChange key={c.id} c={c} onDone={reload} />
        ))}
        <div className="card">
          <div className="row-between">
            <div className="muted" style={{ fontSize: 13 }}>
              {tr("Modo", "Mode")}
            </div>
            {state ? ok ? <span className="pill">{tr("Conferido na Solana", "Verified on Solana")}</span> : <span className="pill danger">{tr("Diferente do esperado", "Not as expected")}</span> : <span className="spinner" />}
          </div>
          <div className="big" style={{ fontSize: 34 }}>
            {tr("2 de 3", "2 of 3")}
          </div>
          <div style={{ fontSize: 13, color: "#b4bac4", lineHeight: 1.45 }}>
            {tr(
              "Envios: sua carteira + a chave do webapp (biometria), e só o operador do serviço executa, depois de conferir a política. Trocar qualquer chave leva 72 h e pode ser vetado.",
              "Sends: your wallet + the webapp key (biometrics), and only the service operator executes, after checking the policy. Changing any key takes 72 h and can be vetoed.",
            )}
          </div>
        </div>
        <div>
          <div className="section-title" style={{ paddingBottom: 4 }}>
            {tr("Chaves da conta", "Account keys")}
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
        <AlertEmail />
        {devices.length > 0 && (
          <div className="subtle" style={{ fontSize: 12 }}>
            {tr("Chave do webapp guardada para:", "Webapp key stored for:")} {devices.map((d) => d.deviceName).join(", ")}
          </div>
        )}
        <button type="button" className="btn" style={{ height: 52 }} disabled={open} onClick={() => ctx.go("/change/client")}>
          <Icon name="key" size={18} /> {tr("Trocar a carteira", "Replace the wallet")}
        </button>
        <button type="button" className="btn" style={{ height: 52 }} disabled={open || ctx.session?.via === "webapp"} onClick={() => ctx.go("/change/webapp")}>
          <Icon name="finger" size={18} /> {tr("Recuperar o webapp neste aparelho", "Recover the webapp on this device")}
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
          {tr("Sair", "Sign out")}
        </button>
      </div>
      <Tabs />
    </>
  );
}

/** Conta: chave atual do webapp e multisig (do serviço; a conferência dos bytes usa a chain). */
async function accountInfo(accountId: string) {
  const sec = await api("GET", `/v1/accounts/${accountId}/security`);
  return { multisig: sec.account.multisig as string, client: sec.account.roles.client as string, webapp: sec.account.roles.webapp as string };
}

/**
 * Trocar a carteira (perdeu, vazou, ou quer outra). A chave do webapp (biometria)
 * e o serviço votam o pedido; a carteira NOVA paga e prova que é sua assinando.
 * Executa em 72 h, se a carteira atual não vetar.
 */
export function ChangeClient() {
  const ctx = useApp();
  const s = ctx.session!;
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<ChangeView | null>(null);

  const pick = async (w: StandardWallet) => {
    setErr(null);
    try {
      setBusy(tr(`Conectando à ${walletDisplay(w.name)}…`, `Connecting to ${walletDisplay(w.name)}…`));
      const next = await ctx.connect(w);
      if (next.publicKey === s.publicKey) throw new Error(tr("Essa é a carteira atual da conta. Na carteira, mude para a conta nova (ou use outra carteira).", "That's the account's current wallet. In the wallet, switch to the new account (or use another wallet)."));
      const info = await accountInfo(s.accountId);
      setBusy(tr("Preparando o pedido…", "Preparing the request…"));
      const r = await api<{ change: ChangeView; desc: SecurityChangeDesc; transaction: string }>("POST", `/v1/accounts/${s.accountId}/security-changes`, { role: "CLIENT", newKey: next.publicKey });
      const review = await reviewSecurityRequest(ctx.chain, r.desc, r.transaction, { client: new PublicKey(info.client), webapp: new PublicKey(info.webapp) });
      setBusy(tr("Confirme com a biometria (a chave do webapp vota o pedido)…", "Confirm with biometrics (the webapp key votes on the request)…"));
      const key = await unlockAccountKey(ctx, await accountKeyBlobs(`/v1/accounts/${s.accountId}/webapp-keys`), tr(`Trocar a carteira por ${short(next.publicKey)} (executa em 72 h)`, `Replace the wallet with ${short(next.publicKey)} (runs in 72 h)`));
      let webappSignature: string;
      try {
        webappSignature = signatureB58(key.sign(review.message));
      } finally {
        key.wipe();
      }
      const auth = await api<{ transaction: string }>("POST", `/v1/security-changes/${r.change.id}/authorize`, { message: Buffer.from(review.message).toString("base64"), webappSignature });
      const tx = verifyAuthorized(review, auth.transaction, [review.roles.operator, review.roles.webapp, review.roles.server]);
      setBusy(tr(`Confirme na ${next.name} (a carteira nova paga ~0,006 SOL, que voltam na conclusão)…`, `Confirm in ${walletDisplay(next.name)} (the new wallet pays ~0.006 SOL, returned when the change completes)…`));
      const signed = await next.signTransaction(tx);
      setDone(await api<ChangeView>("POST", `/v1/security-changes/${r.change.id}/submit`, { transaction: signed }));
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <TopBar title={tr("Trocar a carteira", "Replace the wallet")} back="/security" />
      <div className="page">
        {done ? (
          <div className="banner ok">
            <Icon name="check" size={18} color="var(--accent)" />
            {lang === "pt" ? (
              <div>
                Pedido feito. A carteira nova passa a valer em <b>{fmtWhen(done.executeAfter!)}</b>, se a atual não vetar. Depois disso, toque em "Concluir troca" em Segurança.
              </div>
            ) : (
              <div>
                Request made. The new wallet takes effect on <b>{fmtWhen(done.executeAfter!)}</b>, unless the current one vetoes. After that, tap "Complete change" in Security.
              </div>
            )}
          </div>
        ) : (
          <>
            {lang === "pt" ? (
              <div className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
                A chave do webapp (com a sua biometria) e o serviço aprovam o pedido. A carteira nova paga a taxa e o depósito das contas (~0,006 SOL, que voltam). A troca só executa em <b>72 h</b>: se alguém pedir no seu lugar, a carteira atual veta.
              </div>
            ) : (
              <div className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
                The webapp key (with your biometrics) and the service approve the request. The new wallet pays the fee and the account deposit (~0.006 SOL, returned). The change only runs after <b>72 h</b>: if someone else asks in your place, the current wallet vetoes it.
              </div>
            )}
            <div className="section-title">{tr("Conecte a carteira NOVA", "Connect the NEW wallet")}</div>
            <WalletList onPick={pick} busy={Boolean(busy)} exclude={s.walletName} />
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

/**
 * Recuperar o webapp neste aparelho (perdeu o aparelho ou trocou de celular):
 * uma chave nova do webapp nasce aqui, cifrada pela biometria deste aparelho;
 * a carteira e o serviço votam o pedido; executa em 72 h, se a chave antiga não vetar.
 */
export function ChangeWebapp() {
  const ctx = useApp();
  const s = ctx.session!;
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<ChangeView | null>(null);

  const run = async () => {
    setErr(null);
    try {
      const w = await ctx.accountWallet();
      const info = await accountInfo(s.accountId);
      setBusy(tr("Confirme a biometria deste aparelho (ela protege a chave nova)…", "Confirm biometrics on this device (it protects the new key)…"));
      const key = await createWebappKey({ devTools: ctx.config.devTools, confirm: ctx.biometric, what: tr("Criar a chave nova do webapp", "Create the new webapp key") });
      try {
        setBusy(tr("Preparando o pedido…", "Preparing the request…"));
        const r = await api<{ change: ChangeView; desc: SecurityChangeDesc; transaction: string }>("POST", `/v1/accounts/${s.accountId}/security-changes`, {
          role: "WEBAPP",
          newKey: key.publicKey.toBase58(),
          newKeyBlob: { ...key.blob, deviceName: deviceName() },
        });
        const review = await reviewSecurityRequest(ctx.chain, r.desc, r.transaction, { client: new PublicKey(info.client), webapp: new PublicKey(info.webapp) });
        const auth = await api<{ transaction: string }>("POST", `/v1/security-changes/${r.change.id}/authorize`, { message: Buffer.from(review.message).toString("base64") });
        const tx = verifyAuthorized(review, auth.transaction, [review.roles.operator, review.roles.server]);
        tx.addSignature(key.publicKey, key.sign(tx.message.serialize())); // a chave nova prova que existe (memo)
        setBusy(tr(`Confirme na ${w.name} (ela vota e paga)…`, `Confirm in ${walletDisplay(w.name)} (it votes and pays)…`));
        const signed = await w.signTransaction(tx);
        setDone(await api<ChangeView>("POST", `/v1/security-changes/${r.change.id}/submit`, { transaction: signed }));
      } finally {
        key.wipe();
      }
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <TopBar title={tr("Recuperar o webapp", "Recover the webapp")} back="/security" />
      <div className="page">
        {done ? (
          <div className="banner ok">
            <Icon name="check" size={18} color="var(--accent)" />
            {lang === "pt" ? (
              <div>
                Pedido feito. A chave nova (neste aparelho) passa a valer em <b>{fmtWhen(done.executeAfter!)}</b>, se a antiga não vetar. Depois, toque em "Concluir troca" em Segurança.
              </div>
            ) : (
              <div>
                Request made. The new key (on this device) takes effect on <b>{fmtWhen(done.executeAfter!)}</b>, unless the old one vetoes. Then tap "Complete change" in Security.
              </div>
            )}
          </div>
        ) : (
          <>
            {lang === "pt" ? (
              <div className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
                Use quando perder o aparelho com a chave do webapp. Uma chave nova nasce aqui, protegida pela sua biometria. A sua carteira e o serviço aprovam; a troca só executa em <b>72 h</b>. Se alguém com a sua carteira tentar isso, a chave atual do webapp veta.
              </div>
            ) : (
              <div className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
                Use this if you lose the device with the webapp key. A new key is created here, protected by your biometrics. Your wallet and the service approve; the change only runs after <b>72 h</b>. If someone with your wallet tries this, the current webapp key vetoes it.
              </div>
            )}
            <button type="button" className="btn primary" disabled={Boolean(busy)} onClick={run}>
              <Icon name="finger" color="#0B0D10" sw={2} /> {tr("Criar a chave nova aqui e pedir a troca", "Create the new key here and request the change")}
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

/** Eventos da auditoria no idioma do app (o código fica no `title`, para quem conferir a cadeia). */
const AUDIT_LABEL: Record<string, string> = {
  SMART_ACCOUNT_CREATED: tr("Conta 2 de 3 criada na Solana", "2-of-3 account created on Solana"),
  TRANSACTION_PROPOSED: tr("Envio criado", "Send created"),
  TRANSACTION_POLICY_DENIED: tr("Envio recusado pela política", "Send denied by policy"),
  CLIENT_APPROVED: tr("Você assinou na carteira", "You signed in your wallet"),
  CLIENT_REJECTED: tr("Você cancelou um envio", "You cancelled a send"),
  SERVER_APPROVED: tr("Biometria conferida; o serviço assinou", "Biometrics checked; the service signed"),
  SERVER_REJECTED: tr("O serviço recusou", "The service refused"),
  TRANSACTION_APPROVED: tr("Envio aprovado", "Send approved"),
  TRANSACTION_EXECUTED: tr("Envio executado na Solana", "Send executed on Solana"),
  TRANSACTION_REJECTED: tr("Envio cancelado", "Send cancelled"),
  TRANSACTION_EXPIRED: tr("Envio expirou (prazo de 10 min)", "Send expired (10 min limit)"),
  TRANSACTION_CANCELLED: tr("Envio cancelado", "Send cancelled"),
  EXECUTION_FAILED: tr("Execução falhou", "Execution failed"),
  APPROVAL_REFUSED: tr("Tentativa de envio não aceita", "Send attempt not accepted"),
  ALERT_EMAIL_CHANGED: tr("E-mail de alerta alterado", "Alert email changed"),
  SECURITY_CHANGE_REQUESTED: tr("Pedido de troca de chave (72 h)", "Key change requested (72 h)"),
  SECURITY_CHANGE_VETOED: tr("Troca de chave vetada (\"Não fui eu\")", "Key change vetoed (\"It wasn't me\")"),
  SECURITY_CHANGE_EXECUTED: tr("Troca de chave concluída", "Key change completed"),
  PASSKEY_ADDED: tr("Biometria de outro aparelho adicionada", "Biometrics from another device added"),
  INVARIANT_VIOLATION: tr("Conta diferente do esperado na Solana", "Account on Solana is not as expected"),
  CLIENT_KEY_ROTATION_REQUESTED: tr("Pedido de troca da carteira", "Wallet change requested"),
  SERVER_KEY_ROTATION_REQUESTED: tr("Pedido de troca da chave do serviço", "Service key change requested"),
  ROTATION_COMPLETED: tr("Troca de chave concluída", "Key change completed"),
  ROTATION_REJECTED: tr("Troca de chave recusada", "Key change refused"),
  ROTATION_EXPIRED: tr("Troca de chave expirou", "Key change expired"),
  ROTATION_FAILED: tr("Troca de chave falhou", "Key change failed"),
  OPERATIONS_FROZEN: tr("Envios pausados", "Sends paused"),
  OPERATIONS_UNFROZEN: tr("Envios liberados", "Sends resumed"),
};
const AUDIT_ALERT = new Set(["INVARIANT_VIOLATION", "SECURITY_CHANGE_REQUESTED", "ALERT_EMAIL_CHANGED", "TRANSACTION_POLICY_DENIED", "APPROVAL_REFUSED", "EXECUTION_FAILED"]);

export function Activity() {
  const ctx = useApp();
  const { intents, intentsLoaded, err } = useAccount(6000);
  const [audit, setAudit] = useState<{ seq: number; type: string; at: number; hash: string }[]>([]);
  useEffect(() => {
    const id = ctx.session?.accountId;
    if (id) void api("GET", `/v1/accounts/${id}/audit`).then((r) => setAudit(r.events.slice().reverse())).catch(() => {});
  }, [ctx.session, intents.length]);
  return (
    <>
      <TopBar title={tr("Atividade", "Activity")} back={null} />
      <div className="page">
        <div>
          {!intentsLoaded && !err && <span className="spinner" />}
          {intentsLoaded && intents.length === 0 && <div className="subtle" style={{ fontSize: 13 }}>{tr("Nenhuma transação ainda.", "No transactions yet.")}</div>}
          {intents.map((i) => (
            <IntentRow key={i.intent.id} i={i} />
          ))}
        </div>
        <div>
          <div className="section-title" style={{ paddingBottom: 6 }}>
            {tr("Histórico da conta", "Account history")}
          </div>
          <div className="subtle" style={{ fontSize: 12, paddingBottom: 6 }}>
            {tr(
              "Tudo o que aconteceu na conta, na ordem. O registro só aceita inclusões e é encadeado: apagar ou editar um evento quebra a cadeia.",
              "Everything that happened on the account, in order. The log is append-only and chained: deleting or editing an event breaks the chain.",
            )}
          </div>
          {audit.slice(0, 30).map((e) => (
            <div className="list-row" key={e.seq} style={{ padding: "9px 0" }}>
              <div className="grow">
                <div className="t" style={{ fontSize: 14, color: AUDIT_ALERT.has(e.type) ? "var(--warn)" : undefined }} title={e.type}>
                  {AUDIT_LABEL[e.type] ?? e.type}
                </div>
                <div className="s">{fmtWhen(e.at, "medium")}</div>
              </div>
              <div className="subtle mono" style={{ fontSize: 11 }}>
                #{e.seq} {e.hash.slice(0, 8)}
              </div>
            </div>
          ))}
        </div>
        {err && <div className="err">{err}</div>}
      </div>
      <Tabs />
    </>
  );
}
