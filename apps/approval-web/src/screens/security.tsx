import { useCallback, useEffect, useState } from "react";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { readMultisig, type MultisigState } from "@duplachave/squads";
import { emailBindingMessage, emailInput, reviewSecurityRequest, verifyAuthorized, vetoMessage, type SecurityChangeDesc } from "@duplachave/custody/src/client";
import { accountKeyBlobs, errorText, unlockAccountKey, useApp } from "../app";
import { api } from "../lib/api";
import { now, short } from "../lib/chain";
import type { ConnectedWallet, StandardWallet } from "../lib/wallets";
import { createWebappKey, deviceName, signatureB58 } from "../lib/webappKey";
import { Icon } from "../icons";
import { IntentRow, Tabs, useAccount } from "./home";
import { WalletList } from "./welcome";

/** `back={null}`: tela de aba (a barra de abas já navega). */
function TopBar({ title, back = "/" }: { title: string; back?: string | null }) {
  const { go } = useApp();
  return (
    <div className="topbar">
      {back !== null && (
        <button type="button" className="iconbtn" aria-label="Voltar" onClick={() => go(back)}>
          <Icon name="back" />
        </button>
      )}
      <h1>{title}</h1>
    </div>
  );
}

export type ChangeView = {
  id: string;
  role: "CLIENT" | "WEBAPP" | "SERVER";
  oldKey: string;
  newKey: string;
  status: "PREPARED" | "PENDING" | "EXECUTED" | "VETOED" | "FAILED";
  index: string | null;
  createdAt: number;
  executeAfter: number | null;
};

const ROLE_NAME: Record<ChangeView["role"], string> = { CLIENT: "carteira", WEBAPP: "chave do webapp", SERVER: "chave do serviço" };
const when = (t: number) => new Date(t * 1000).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
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
  return <span className="mono">{left === 0 ? "agora" : `${Math.floor(left / 3600)} h ${String(Math.floor((left % 3600) / 60)).padStart(2, "0")} min`}</span>;
}

/**
 * Troca pendente: o que vai mudar, quando executa, "Não fui eu" (assinado pela
 * chave que seria trocada) e "Concluir" depois do prazo.
 */
export function PendingChange({ c, onDone }: { c: ChangeView; onDone: () => void }) {
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
        setBusy("Assine o veto na carteira atual…");
        const w = await ctx.accountWallet();
        publicKey = w.publicKey;
        signature = await w.signMessage(text);
      } else {
        setBusy("Confirme com a biometria para vetar…");
        const key = await unlockAccountKey(ctx, await accountKeyBlobs(`/v1/accounts/${ctx.session!.accountId}/webapp-keys`), "Não fui eu: cancelar a troca de chave");
        try {
          publicKey = key.publicKey.toBase58();
          signature = signatureB58(key.sign(new TextEncoder().encode(text)));
        } finally {
          key.wipe();
        }
      }
      await api("POST", `/v1/security-changes/${c.id}/veto`, { publicKey, signature }, { auth: false });
      ctx.toast("Troca cancelada.");
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
      setBusy("Preparando a execução…");
      const r = await api<{ transaction: string; payer: string }>("POST", `/v1/security-changes/${c.id}/execute-prepare`, {});
      const w = payerWallet ?? (c.role === "CLIENT" ? null : await ctx.accountWallet());
      if (!w || w.publicKey !== r.payer) {
        setPickPayer(true);
        throw new Error(`Quem paga a conclusão é a carteira ${short(r.payer)}: conecte essa carteira abaixo.`);
      }
      setBusy(`Confirme na ${w.name} (ela paga a taxa)…`);
      const signed = await w.signTransaction(fromB64(r.transaction));
      setBusy("Executando na Solana…");
      await api("POST", `/v1/security-changes/${c.id}/execute`, { transaction: signed });
      ctx.toast("Troca concluída.");
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
        <Icon name="clock" size={14} color="#F2B33D" /> Troca de chave pendente
      </div>
      <div style={{ fontSize: 15, lineHeight: 1.45 }}>
        Trocar a <b>{ROLE_NAME[c.role]}</b> <span className="mono">{short(c.oldKey)}</span> → <span className="mono">{short(c.newKey)}</span>
      </div>
      <div className="muted" style={{ fontSize: 13 }}>
        {due ? "O prazo passou: pode concluir." : (
          <>
            Executa em <Countdown until={c.executeAfter!} /> ({when(c.executeAfter!)}). Não foi você? Vete.
          </>
        )}
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <button type="button" className="btn" style={{ flex: 1 }} disabled={Boolean(busy)} onClick={veto}>
          Não fui eu
        </button>
        {due && (
          <button type="button" className="btn primary" style={{ flex: 1 }} disabled={Boolean(busy)} onClick={() => execute()}>
            Concluir troca
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
 * código que chega no endereço novo: quem só tem a seed da Phantom não desvia os alertas.
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
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e)) return setErr("E-mail inválido.");
    try {
      setBusy("Confirme com a biometria…");
      const sec = await api("GET", `/v1/accounts/${accountId}/security`);
      const key = await unlockAccountKey(ctx, await accountKeyBlobs(`/v1/accounts/${accountId}/webapp-keys`), `Enviar os alertas da conta para ${e}`);
      let signature: string;
      try {
        signature = signatureB58(key.sign(new TextEncoder().encode(emailBindingMessage(sec.account.multisig, e))));
      } finally {
        key.wipe();
      }
      setBusy("Enviando o código…");
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
      setBusy("Confirmando…");
      const r = await api("POST", `/v1/accounts/${accountId}/email/confirm`, { challengeId: sent!.challengeId, code: code.trim() });
      ctx.toast(`Alertas vão para ${r.email}.`);
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
          E-mail de alerta
        </div>
        {current === undefined ? <span className="spinner" /> : current ? <span className="pill">Confirmado</span> : <span className="pill danger">Sem alerta</span>}
      </div>
      {!editing && (
        <>
          <div className="mono" style={{ fontSize: 15 }}>
            {current ?? "Nenhum"}
          </div>
          <div style={{ fontSize: 13, color: "#b4bac4", lineHeight: 1.45 }}>Avisa pedidos de troca de chave (a tempo do "Não fui eu"), trocas concluídas e envios.</div>
          <button type="button" className="btn" style={{ height: 44 }} onClick={() => setEditing(true)}>
            <Icon name="finger" size={16} /> {current ? "Trocar o e-mail" : "Cadastrar e-mail"}
          </button>
        </>
      )}
      {editing && !sent && (
        <>
          <div className="field">
            <label htmlFor="alert-email">E-mail</label>
            <input id="alert-email" className="input" type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="voce@exemplo.com" />
          </div>
          <button type="button" className="btn primary" style={{ height: 44 }} disabled={!!busy || !email} onClick={start}>
            {busy ?? "Confirmar com a biometria e enviar código"}
          </button>
          <button type="button" className="linkbtn" onClick={() => (setEditing(false), setErr(null))}>
            Cancelar
          </button>
        </>
      )}
      {sent && (
        <>
          <div style={{ fontSize: 13, color: "#b4bac4" }}>Enviamos um código de 6 dígitos para {sent.email}. Vale por 10 minutos.</div>
          <div className="field">
            <label htmlFor="alert-code">Código</label>
            <input id="alert-code" className="input mono" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="000000" />
          </div>
          <button type="button" className="btn primary" style={{ height: 44 }} disabled={!!busy || code.length !== 6} onClick={confirm}>
            {busy ?? "Confirmar"}
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
  const { changes, pending, reload } = useChanges();
  const [devices, setDevices] = useState<{ deviceName: string; createdAt: number }[]>([]);
  useEffect(() => {
    if (ctx.session) void api("GET", `/v1/accounts/${ctx.session.accountId}/security`).then((r) => setDevices(r.webappDevices ?? [])).catch(() => {});
  }, [ctx.session]);
  const roles = acc?.account.roles as unknown as { client: string; webapp: string; server: string; operator: string } | undefined;
  const label = (k: string) =>
    k === roles?.client
      ? { icon: "key", title: "Sua carteira", sub: "vota e paga", role: "Vota", accent: true }
      : k === roles?.webapp
        ? { icon: "finger", title: "Chave do webapp", sub: "aberta pela biometria", role: "Vota", accent: true }
        : k === roles?.server
          ? { icon: "server", title: "Chave do serviço", sub: "só em recuperação, com prazo", role: "Vota", accent: false }
          : k === roles?.operator
            ? { icon: "bolt", title: "Operador do serviço", sub: "não vota", role: "Executa", accent: false }
            : { icon: "shieldalert", title: "Chave desconhecida", sub: "não esperada", role: "?", accent: false };
  const order = (k: string) => [roles?.client, roles?.webapp, roles?.server, roles?.operator].indexOf(k) + 1 || 9;
  const open = changes.some((c) => c.status === "PENDING");

  return (
    <>
      <TopBar title="Segurança" back={null} />
      <div className="page">
        {pending.map((c) => (
          <PendingChange key={c.id} c={c} onDone={reload} />
        ))}
        <div className="card">
          <div className="row-between">
            <div className="muted" style={{ fontSize: 13 }}>
              Modo
            </div>
            {state ? ok ? <span className="pill">Conferido na Solana</span> : <span className="pill danger">Diferente do esperado</span> : <span className="spinner" />}
          </div>
          <div className="big" style={{ fontSize: 34 }}>
            2 de 3
          </div>
          <div style={{ fontSize: 13, color: "#b4bac4", lineHeight: 1.45 }}>
            Envios: sua carteira + a chave do webapp (biometria), e só o operador do serviço executa, depois de conferir a política. Trocar qualquer chave leva 72 h e pode ser vetado.
          </div>
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
        <AlertEmail />
        {devices.length > 0 && (
          <div className="subtle" style={{ fontSize: 12 }}>
            Chave do webapp guardada para: {devices.map((d) => d.deviceName).join(", ")}
          </div>
        )}
        <button type="button" className="btn" style={{ height: 52 }} disabled={open} onClick={() => ctx.go("/change/client")}>
          <Icon name="key" size={18} /> Trocar a carteira
        </button>
        <button type="button" className="btn" style={{ height: 52 }} disabled={open || ctx.session?.via === "webapp"} onClick={() => ctx.go("/change/webapp")}>
          <Icon name="finger" size={18} /> Recuperar o webapp neste aparelho
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
 * Trocar a Phantom (perdeu, vazou, ou quer outra). A chave do webapp (biometria)
 * e o serviço votam o pedido; a Phantom NOVA paga e prova que é sua assinando.
 * Executa em 72 h, se a Phantom atual não vetar.
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
      setBusy(`Conectando à ${w.name}…`);
      const next = await ctx.connect(w);
      if (next.publicKey === s.publicKey) throw new Error("Essa é a carteira atual da conta. Na carteira, mude para a conta nova (ou use outra carteira).");
      const info = await accountInfo(s.accountId);
      setBusy("Preparando o pedido…");
      const r = await api<{ change: ChangeView; desc: SecurityChangeDesc; transaction: string }>("POST", `/v1/accounts/${s.accountId}/security-changes`, { role: "CLIENT", newKey: next.publicKey });
      const review = await reviewSecurityRequest(ctx.chain, r.desc, r.transaction, { client: new PublicKey(info.client), webapp: new PublicKey(info.webapp) });
      setBusy("Confirme com a biometria (a chave do webapp vota o pedido)…");
      const key = await unlockAccountKey(ctx, await accountKeyBlobs(`/v1/accounts/${s.accountId}/webapp-keys`), `Trocar a carteira por ${short(next.publicKey)} (executa em 72 h)`);
      let webappSignature: string;
      try {
        webappSignature = signatureB58(key.sign(review.message));
      } finally {
        key.wipe();
      }
      const auth = await api<{ transaction: string }>("POST", `/v1/security-changes/${r.change.id}/authorize`, { message: Buffer.from(review.message).toString("base64"), webappSignature });
      const tx = verifyAuthorized(review, auth.transaction, [review.roles.operator, review.roles.webapp, review.roles.server]);
      setBusy(`Confirme na ${next.name} (a carteira nova paga ~0,006 SOL, que voltam na conclusão)…`);
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
      <TopBar title="Trocar a carteira" back="/security" />
      <div className="page">
        {done ? (
          <div className="banner ok">
            <Icon name="check" size={18} color="var(--accent)" />
            <div>
              Pedido feito. A carteira nova passa a valer em <b>{when(done.executeAfter!)}</b>, se a atual não vetar. Depois disso, toque em "Concluir troca" em Segurança.
            </div>
          </div>
        ) : (
          <>
            <div className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
              A chave do webapp (com a sua biometria) e o serviço aprovam o pedido. A carteira nova paga a taxa e o depósito das contas (~0,006 SOL, que voltam). A troca só executa em <b>72 h</b>: se alguém pedir no seu lugar, a carteira atual veta.
            </div>
            <div className="section-title">Conecte a carteira NOVA</div>
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
 * a Phantom e o serviço votam o pedido; executa em 72 h, se a chave antiga não vetar.
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
      setBusy("Confirme a biometria deste aparelho (ela protege a chave nova)…");
      const key = await createWebappKey({ devTools: ctx.config.devTools, confirm: ctx.biometric, what: "Criar a chave nova do webapp" });
      try {
        setBusy("Preparando o pedido…");
        const r = await api<{ change: ChangeView; desc: SecurityChangeDesc; transaction: string }>("POST", `/v1/accounts/${s.accountId}/security-changes`, {
          role: "WEBAPP",
          newKey: key.publicKey.toBase58(),
          newKeyBlob: { ...key.blob, deviceName: deviceName() },
        });
        const review = await reviewSecurityRequest(ctx.chain, r.desc, r.transaction, { client: new PublicKey(info.client), webapp: new PublicKey(info.webapp) });
        const auth = await api<{ transaction: string }>("POST", `/v1/security-changes/${r.change.id}/authorize`, { message: Buffer.from(review.message).toString("base64") });
        const tx = verifyAuthorized(review, auth.transaction, [review.roles.operator, review.roles.server]);
        tx.addSignature(key.publicKey, key.sign(tx.message.serialize())); // a chave nova prova que existe (memo)
        setBusy(`Confirme na ${w.name} (ela vota e paga)…`);
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
      <TopBar title="Recuperar o webapp" back="/security" />
      <div className="page">
        {done ? (
          <div className="banner ok">
            <Icon name="check" size={18} color="var(--accent)" />
            <div>
              Pedido feito. A chave nova (neste aparelho) passa a valer em <b>{when(done.executeAfter!)}</b>, se a antiga não vetar. Depois, toque em "Concluir troca" em Segurança.
            </div>
          </div>
        ) : (
          <>
            <div className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
              Use quando perder o aparelho com a chave do webapp. Uma chave nova nasce aqui, protegida pela sua biometria. A sua carteira e o serviço aprovam; a troca só executa em <b>72 h</b>. Se alguém com a sua carteira tentar isso, a chave atual do webapp veta.
            </div>
            <button type="button" className="btn primary" disabled={Boolean(busy)} onClick={run}>
              <Icon name="finger" color="#0B0D10" sw={2} /> Criar a chave nova aqui e pedir a troca
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

/** Eventos da auditoria em português (o código fica no registro, para quem conferir a cadeia). */
const AUDIT_LABEL: Record<string, string> = {
  SMART_ACCOUNT_CREATED: "Conta 2 de 3 criada na Solana",
  TRANSACTION_PROPOSED: "Envio criado",
  TRANSACTION_POLICY_DENIED: "Envio recusado pela política",
  CLIENT_APPROVED: "Você assinou na carteira",
  CLIENT_REJECTED: "Você cancelou um envio",
  SERVER_APPROVED: "Biometria conferida; o serviço assinou",
  SERVER_REJECTED: "O serviço recusou",
  TRANSACTION_APPROVED: "Envio aprovado",
  TRANSACTION_EXECUTED: "Envio executado na Solana",
  TRANSACTION_REJECTED: "Envio cancelado",
  TRANSACTION_EXPIRED: "Envio expirou (prazo de 10 min)",
  TRANSACTION_CANCELLED: "Envio cancelado",
  EXECUTION_FAILED: "Execução falhou",
  APPROVAL_REFUSED: "Tentativa de envio não aceita",
  ALERT_EMAIL_CHANGED: "E-mail de alerta alterado",
  SECURITY_CHANGE_REQUESTED: "Pedido de troca de chave (72 h)",
  SECURITY_CHANGE_VETOED: "Troca de chave vetada (\"Não fui eu\")",
  SECURITY_CHANGE_EXECUTED: "Troca de chave concluída",
  PASSKEY_ADDED: "Biometria de outro aparelho adicionada",
  INVARIANT_VIOLATION: "Conta diferente do esperado na Solana",
  CLIENT_KEY_ROTATION_REQUESTED: "Pedido de troca da carteira",
  SERVER_KEY_ROTATION_REQUESTED: "Pedido de troca da chave do serviço",
  ROTATION_COMPLETED: "Troca de chave concluída",
  ROTATION_REJECTED: "Troca de chave recusada",
  ROTATION_EXPIRED: "Troca de chave expirou",
  ROTATION_FAILED: "Troca de chave falhou",
  OPERATIONS_FROZEN: "Envios pausados",
  OPERATIONS_UNFROZEN: "Envios liberados",
};
const AUDIT_ALERT = new Set(["INVARIANT_VIOLATION", "SECURITY_CHANGE_REQUESTED", "ALERT_EMAIL_CHANGED", "TRANSACTION_POLICY_DENIED", "APPROVAL_REFUSED", "EXECUTION_FAILED"]);

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
            Histórico da conta
          </div>
          <div className="subtle" style={{ fontSize: 12, paddingBottom: 6 }}>
            Tudo o que aconteceu na conta, na ordem. O registro só aceita inclusões e é encadeado: apagar ou editar um evento quebra a cadeia.
          </div>
          {audit.slice(0, 30).map((e) => (
            <div className="list-row" key={e.seq} style={{ padding: "9px 0" }}>
              <div className="grow">
                <div className="t" style={{ fontSize: 14, color: AUDIT_ALERT.has(e.type) ? "var(--warn)" : undefined }} title={e.type}>
                  {AUDIT_LABEL[e.type] ?? e.type}
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
