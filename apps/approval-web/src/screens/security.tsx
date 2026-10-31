import { useCallback, useEffect, useState } from "react";
import { type ChangeView, useChanges } from "../hooks/useChanges";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { readMultisig, type MultisigState } from "@duplachave/squads";
import { emailBindingMessage, emailInput, vetoMessage } from "@duplachave/custody/src/client";
import { accountKeyBlobs, errorText, unlockAccountKey, useApp } from "../app";
import { api } from "../lib/api";
import { now, short } from "../lib/chain";
import { ConnectedWallet, type StandardWallet, walletDisplay } from "../lib/wallets";
import { signatureB58 } from "../lib/webappKey";
import { Icon } from "../icons";
import { Tabs, useAccount } from "./home";
import { WalletList } from "./welcome";
import { TopBar } from "../components/TopBar";
import { CountdownHours } from "../components/Countdown";
import { fmtWhen, tr, trn } from "../lib/i18n";
import { usePolling } from "../hooks/usePolling";

const ROLE_NAME: Record<ChangeView["role"], string> = { CLIENT: tr("carteira", "wallet"), WEBAPP: tr("chave do webapp", "webapp key"), SERVER: tr("chave do serviço", "service key") };
const fromB64 = (b: string) => VersionedTransaction.deserialize(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));

/** Conferência local: o webapp lê a multisig pela RPC dele e checa o modelo 2 de 3. */
function useOnchainCheck(multisig: string | undefined) {
  const ctx = useApp();
  const [state, setState] = useState<MultisigState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Muda para forçar uma leitura nova ("Tentar de novo").
  const [attempt, setAttempt] = useState(0);
  const { chain } = ctx;
  // `attempt` entra nas dependências para "Tentar de novo" reiniciar o ciclo na hora.
  const run = useCallback(
    () =>
      multisig
        ? readMultisig(chain, new PublicKey(multisig))
            .then((s) => {
              setState(s);
              setErr(null);
            })
            .catch((e) => setErr(errorText(e)))
        : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [multisig, chain, attempt],
  );
  // Só com a aba visível; a leitura mais recente sempre prevalece.
  usePolling(run, 10_000, Boolean(multisig));
  const voters = state?.members.filter((m) => m.vote) ?? [];
  const ok = Boolean(state && state.threshold === 2 && voters.length === 3 && voters.every((v) => v.mask === 2) && state.members.filter((m) => m.mask & 4).length === 1 && state.configAuthority === PublicKey.default.toBase58());
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, ok, err, retry };
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

  const execute = async (picked?: StandardWallet) => {
    setErr(null);
    try {
      setBusy(tr("Preparando a execução…", "Preparing to execute…"));
      const r = await api<{ transaction: string; payer: string }>("POST", `/v1/security-changes/${c.id}/execute-prepare`, {});
      // Carteira escolhida na lista: a do celular conecta e assina numa abertura só, já
      // sabendo qual conta esperar (a pagadora); as extensões conectam primeiro.
      const w = picked
        ? picked.features["duplachave:connectAndSignMessage"]
          ? ConnectedWallet.forAddress(picked, r.payer, ctx.config.cluster)
          : await ctx.connect(picked)
        : c.role === "CLIENT"
          ? null
          : await ctx.accountWallet();
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
        {due
          ? tr("O prazo passou: pode concluir.", "The wait is over: you can complete it.")
          : trn(
              <>
                Executa em <CountdownHours until={c.executeAfter!} /> ({fmtWhen(c.executeAfter!)}). Não foi você? Vete.
              </>,
              <>
                Runs in <CountdownHours until={c.executeAfter!} /> ({fmtWhen(c.executeAfter!)}). Wasn't you? Veto it.
              </>,
            )}
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <button type="button" className="btn" style={{ flex: 1 }} disabled={Boolean(busy)} aria-busy={Boolean(busy)} onClick={veto}>
          {tr("Não fui eu", "It wasn't me")}
        </button>
        {due && (
          <button type="button" className="btn primary" style={{ flex: 1 }} disabled={Boolean(busy)} aria-busy={Boolean(busy)} onClick={() => execute()}>
            {tr("Concluir troca", "Complete change")}
          </button>
        )}
      </div>
      {pickPayer && (
        <WalletList
          busy={Boolean(busy)}
          onPick={(sw: StandardWallet) => void execute(sw)}
        />
      )}
      {busy && (
        <div className="status" role="status">
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
  const [loadErr, setLoadErr] = useState(false);
  const accountId = ctx.session?.accountId;
  const load = useCallback(() => {
    if (!accountId) return;
    setLoadErr(false);
    void api("GET", `/v1/accounts/${accountId}/security`)
      .then((r) => setCurrent(r.alertEmail ?? null))
      .catch(() => setLoadErr(true));
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
        {current === undefined ? loadErr ? null : <span className="spinner" /> : current ? <span className="pill">{tr("Confirmado", "Confirmed")}</span> : <span className="pill danger">{tr("Sem alerta", "No alerts")}</span>}
      </div>
      {current === undefined && loadErr && (
        <div className="subtle" style={{ fontSize: 13 }}>
          {tr("Não deu para carregar.", "Couldn't load.")}{" "}
          <button type="button" className="linkbtn small" onClick={load}>
            {tr("Tentar de novo", "Try again")}
          </button>
        </div>
      )}
      {!editing && (
        <>
          <div className="mono" style={{ fontSize: 15 }}>
            {current === undefined ? "—" : (current ?? tr("Nenhum", "None"))}
          </div>
          <div style={{ fontSize: 13, color: "#b4bac4", lineHeight: 1.45 }}>{tr('Avisa pedidos de troca de chave (a tempo do "Não fui eu"), trocas concluídas e envios.', 'Warns you about key change requests (in time for "It wasn\'t me"), completed changes and sends.')}</div>
          <button type="button" className="btn" style={{ height: 44 }} onClick={() => setEditing(true)}>
            <Icon name="finger" size={16} /> {current ? tr("Trocar o e-mail", "Change email") : tr("Cadastrar e-mail", "Add email")}
          </button>
        </>
      )}
      {editing && !sent && (
        // <form>: o Enter no campo envia, como o botão.
        <form
          className="stack"
          style={{ gap: 14 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && email) void start();
          }}
        >
          <div className="field">
            <label htmlFor="alert-email">{tr("E-mail", "Email")}</label>
            <input id="alert-email" className="input" type="email" inputMode="email" autoComplete="email" enterKeyHint="send" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={tr("voce@exemplo.com", "you@example.com")} />
          </div>
          <button type="submit" className="btn primary" style={{ height: 44 }} disabled={!!busy || !email} aria-busy={!!busy}>
            {busy ?? tr("Confirmar com a biometria e enviar código", "Confirm with biometrics and send code")}
          </button>
          <button type="button" className="linkbtn" onClick={() => (setEditing(false), setErr(null))}>
            {tr("Cancelar", "Cancel")}
          </button>
        </form>
      )}
      {sent && (
        <form
          className="stack"
          style={{ gap: 14 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && code.length === 6) void confirm();
          }}
        >
          <div style={{ fontSize: 13, color: "#b4bac4" }}>{tr(`Enviamos um código de 6 dígitos para ${sent.email}. Vale por 10 minutos.`, `We sent a 6-digit code to ${sent.email}. It's valid for 10 minutes.`)}</div>
          <div className="field">
            <label htmlFor="alert-code">{tr("Código", "Code")}</label>
            <input id="alert-code" className="input mono" inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code" enterKeyHint="done" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="000000" />
          </div>
          <button type="submit" className="btn primary" style={{ height: 44 }} disabled={!!busy || code.length !== 6} aria-busy={!!busy}>
            {busy ?? tr("Confirmar", "Confirm")}
          </button>
        </form>
      )}
      {err && <div className="err" role="alert">{err}</div>}
    </div>
  );
}

export function Security() {
  const ctx = useApp();
  const { acc } = useAccount(8000);
  const { state, ok, err: onchainErr, retry: retryOnchain } = useOnchainCheck(acc?.account.multisig);
  const { changes, pending, err: changesErr, reload } = useChanges();
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
        {changesErr && changes.length === 0 && (
          <div className="subtle" style={{ fontSize: 13 }}>
            {tr("Não deu para carregar as trocas de chave.", "Couldn't load the key changes.")}{" "}
            <button type="button" className="linkbtn small" onClick={() => void reload()}>
              {tr("Tentar de novo", "Try again")}
            </button>
          </div>
        )}
        <div className="card">
          <div className="row-between">
            <div className="muted" style={{ fontSize: 13 }}>
              {tr("Modo", "Mode")}
            </div>
            {state ? (
              ok ? (
                <span className="pill">{tr("Conferido na Solana", "Verified on Solana")}</span>
              ) : (
                <span className="pill danger">{tr("Diferente do esperado", "Not as expected")}</span>
              )
            ) : onchainErr ? (
              <button type="button" className="linkbtn small" onClick={retryOnchain}>
                {tr("Não deu para ler a Solana. Tentar de novo", "Couldn't read Solana. Try again")}
              </button>
            ) : (
              <span className="spinner" />
            )}
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
        {/* Botão desabilitado sem explicação é um beco: um só motivo, o que se aplica. */}
        {open ? (
          <div className="hint">{tr("Com uma troca pendente, outra não pode ser pedida.", "While a change is pending, another can't be requested.")}</div>
        ) : ctx.session?.via === "webapp" ? (
          <div className="hint">{tr("Entre com a carteira para recuperar o webapp.", "Sign in with the wallet to recover the webapp.")}</div>
        ) : null}
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
