import { useCallback, useEffect, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { inspectPrepared, verifyAuthorized, type ApprovalRequest, type Inspection } from "@duplachave/custody/src/client";
import { signatureB58, type WebappKeyBlob } from "../lib/webappKey";
import { KNOWN_PROGRAM_NAMES } from "@duplachave/solana";
import { accountKeyBlobs, errorText, unlockAccountKey, useApp } from "../app";
import { api, ApiError } from "../lib/api";
import { ConnectedWallet, walletDisplay, walletWord } from "../lib/wallets";
import { now, parseSol, short, sol, solInput } from "../lib/chain";
import { Icon } from "../icons";
import { type IntentView, useAccount } from "./home";
import { PhoneQrSheet, SCAN_STEPS } from "../components/PhoneQr";
import { TopBar } from "../components/TopBar";
import { fmtWhen, lang, tr } from "../lib/i18n";
import { errorEn } from "../lib/errors-en";

function Countdown({ until }: { until: number }) {
  const [t, setT] = useState(now());
  useEffect(() => {
    const i = setInterval(() => setT(now()), 1000);
    return () => clearInterval(i);
  }, []);
  const left = Math.max(0, until - t);
  return (
    <div className="pill mono" style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", border: "1px solid var(--line)", background: "var(--surface)", color: left < 60 ? "var(--warn)" : "var(--muted)", fontSize: 12 }}>
      <Icon name="clock" size={14} />
      {String(Math.floor(left / 60)).padStart(2, "0")}:{String(left % 60).padStart(2, "0")}
    </div>
  );
}

const Detail = ({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) => (
  <div className="detail">
    <div>{label}</div>
    <div className={mono ? "mono" : undefined}>{value}</div>
  </div>
);

// ---------------------------------------------------------------- Enviar

export function Send() {
  const ctx = useApp();
  // "Criar de novo" (envio que expirou) chega com destino e valor na rota.
  const q = new URLSearchParams(ctx.route.split("?")[1] ?? "");
  const [dest, setDest] = useState(q.get("to") ?? "");
  const [amount, setAmount] = useState(q.get("amount") ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { acc, balance } = useAccount(15000);
  const limit = acc?.limits ? BigInt(acc.limits.maxLamportsPerTx) : null;
  const max = balance === null ? null : limit !== null && limit < balance ? limit : balance;

  const destErr = (() => {
    if (!dest.trim()) return null;
    try {
      new PublicKey(dest.trim());
    } catch {
      return tr("Endereço Solana inválido. Confira se copiou inteiro.", "Invalid Solana address. Check that you copied all of it.");
    }
    if (acc && dest.trim() === acc.account.vault) return tr("Esse é o próprio Vault da conta.", "That is the account's own Vault.");
    return null;
  })();
  const lamports = parseSol(amount);
  const amountErr = (() => {
    if (!amount.trim()) return null;
    if (lamports === null) return tr("Use um número com até 9 casas decimais, por exemplo 0,5.", "Use a number with up to 9 decimal places, for example 0.5.");
    if (lamports === 0n) return tr("O valor precisa ser maior que zero.", "The amount must be greater than zero.");
    if (limit !== null && lamports > limit) return tr(`Acima do limite de ${sol(limit, 9)} SOL por envio.`, `Above the limit of ${sol(limit, 9)} SOL per transfer.`);
    if (balance !== null && lamports > balance) return tr(`Maior que o saldo do Vault (${sol(balance, 9)} SOL).`, `More than the Vault balance (${sol(balance, 9)} SOL).`);
    return null;
  })();
  const valid = Boolean(dest.trim() && lamports && !destErr && !amountErr);

  const paste = async () => {
    try {
      const t = (await navigator.clipboard.readText()).trim();
      if (t) setDest(t);
    } catch {
      ctx.toast(tr("O navegador não deixou ler a área de transferência. Cole no campo.", "The browser didn't allow reading the clipboard. Paste into the field."));
    }
  };

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api("POST", `/v1/accounts/${ctx.session!.accountId}/intents`, { type: "TRANSFER_SOL", destination: dest.trim(), amountSol: amount.trim() });
      ctx.go(`/intent/${r.intent.id}`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <TopBar title={tr("Enviar SOL", "Send SOL")} />
      <div className="page">
        <div className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
          {tr(
            `O serviço confere a sua política. Depois você revisa, confirma com a biometria e assina uma vez na ${walletWord(ctx.session!.walletName)}, que paga a taxa da rede (~0,000015 SOL).`,
            `The service checks your policy. Then you review, confirm with biometrics and sign once in ${walletWord(ctx.session!.walletName)}, which pays the network fee (~0.000015 SOL).`,
          )}
        </div>
        <div className="field">
          <div className="row-between">
            <label htmlFor="dest">{tr("Endereço de destino", "Destination address")}</label>
            <button type="button" className="linkbtn small" onClick={paste}>
              {tr("Colar", "Paste")}
            </button>
          </div>
          <input id="dest" className="input mono" value={dest} onChange={(e) => setDest(e.target.value)} placeholder={tr("Endereço Solana", "Solana address")} spellCheck={false} autoComplete="off" aria-invalid={Boolean(destErr)} />
          {destErr && <div className="err">{destErr}</div>}
        </div>
        <div className="field">
          <div className="row-between">
            <label htmlFor="amt">{tr("Quantidade (SOL)", "Amount (SOL)")}</label>
            <button type="button" className="linkbtn small" disabled={!max} onClick={() => max && setAmount(solInput(max))}>
              {tr("Máx", "Max")}
            </button>
          </div>
          <input id="amt" className="input mono" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={tr("0,5", "0.5")} aria-invalid={Boolean(amountErr)} />
          {amountErr ? (
            <div className="err">{amountErr}</div>
          ) : (
            <div className="subtle" style={{ fontSize: 12 }}>
              {tr("Saldo do Vault", "Vault balance")}: {balance === null ? "…" : `${sol(balance, 9)} SOL`}
              {limit !== null && tr(` · limite por envio: ${sol(limit, 9)} SOL`, ` · limit per transfer: ${sol(limit, 9)} SOL`)}
            </div>
          )}
        </div>
        {err && <div className="banner danger">{err}</div>}
      </div>
      <div className="actions">
        <button type="button" className="btn primary" disabled={!valid || busy} onClick={submit}>
          {busy ? <span className="spinner" /> : null} {tr("Revisar", "Review")}
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Revisar e assinar

/** O que a janela da biometria de teste mostra (no celular de verdade, o sistema mostra o nome do app). */
function summaryOf(r: ApprovalRequest): string {
  const i = r.intent;
  if (i.type === "TRANSFER_SOL") return tr(`Confirmar: enviar ${sol(i.amountLamports, 9)} SOL para ${short(i.destination)}`, `Confirm: send ${sol(i.amountLamports, 9)} SOL to ${short(i.destination)}`);
  if (i.type === "ROTATE_MEMBER") return i.role === "CLIENT" ? tr(`Confirmar: trocar a carteira da conta por ${short(i.newKey)}`, `Confirm: change the account wallet to ${short(i.newKey)}`) : tr("Confirmar: nova chave do serviço", "Confirm: new service key");
  return tr("Confirmar transação", "Confirm transaction");
}

/**
 * Uma transação preparada vale ~60–90 s (blockhash). O app prepara de novo
 * depois da biometria, se passou disso, para o tempo que resta ficar para a carteira.
 */
const PREPARED_FRESH_MS = 10_000;

type Loaded = { record: IntentView; request: ApprovalRequest | null; preparedAt: number; prepareErr: string | null; prepareCode?: string };

/**
 * `handoff`: aberta pelo QR no celular, sem entrar na conta. O token do QR dá
 * acesso a esta intenção; a biometria e a carteira da conta continuam sendo
 * quem autoriza. A carteira do celular conecta e assina na mesma abertura.
 */
export function IntentScreen({ id, handoff }: { id: string; handoff?: { token: string; wallet: string } }) {
  const ctx = useApp();
  const base = handoff ? `/v1/handoff/${handoff.token}` : `/v1/intents/${id}`;
  const opt = handoff ? { auth: false } : undefined;
  const myWallet = handoff?.wallet ?? ctx.session!.publicKey;
  /** A carteira que assina: a da sessão, ou (pelo QR) a carteira do celular já sabendo qual conta esperar. */
  const signer = async () => {
    if (!handoff) return ctx.accountWallet();
    const w = ctx.wallets.find((x) => x.name === "Mobile Wallet Adapter");
    if (!w) throw new Error(tr("Abra este link no Android, com o app de uma carteira Solana instalado (Phantom, Solflare…).", "Open this link on Android, with a Solana wallet app installed (Phantom, Solflare…)."));
    return ConnectedWallet.forAddress(w, handoff.wallet, ctx.config.cluster);
  };
  const [data, setData] = useState<Loaded | null>(null);
  const [check, setCheck] = useState<Inspection | null>(null);
  const [busy, setBusy] = useState<null | "sign" | "reject">(null);
  const [stepText, setStepText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [handedOver, setHandedOver] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const viaPhone = !handoff && ctx.session?.via === "phone";
  const keysRef = useRef<{ publicKey: string; blob: WebappKeyBlob }[] | null>(null);
  /** As cópias cifradas da chave do webapp (a chave pública dela entra na conferência). */
  const keys = useCallback(async () => {
    keysRef.current ??= await accountKeyBlobs(handoff ? `${base}/key` : `/v1/accounts/${ctx.session!.accountId}/webapp-keys`, !handoff);
    return keysRef.current;
  }, [base]);

  /** Pede a transação atômica (ainda sem assinaturas) e confere: o webapp remonta os bytes sozinho. */
  const prepare = useCallback(async () => {
    const path = ctx.dev.malicious && !handoff ? `/v1/dev/intents/${id}/prepare-tampered` : `${base}/prepare`;
    const k = await keys();
    if (!k.length) throw new Error(tr("Esta conta não tem a chave do webapp guardada.", "This account has no webapp key stored."));
    const request = await api<ApprovalRequest>("POST", path, {}, opt);
    const inspection = await inspectPrepared(ctx.chain, request, { client: new PublicKey(myWallet), webapp: new PublicKey(k[0]!.publicKey) }, now());
    return { request, inspection };
  }, [id, ctx, base, myWallet, keys]);

  const load = useCallback(async () => {
    try {
      const r = await api<{ record: IntentView }>("GET", handoff ? `${base}/intent` : base, undefined, opt);
      if (r.record.status !== "AWAITING_CLIENT") return setData({ record: r.record, request: null, preparedAt: 0, prepareErr: null });
      try {
        const { request, inspection } = await prepare();
        setData({ record: r.record, request, preparedAt: Date.now(), prepareErr: null });
        setCheck(inspection);
      } catch (e) {
        setData({ record: r.record, request: null, preparedAt: 0, prepareErr: errorText(e), prepareCode: e instanceof ApiError ? e.code : undefined });
      }
    } catch (e) {
      setErr(errorText(e));
    }
  }, [id, prepare]);

  useEffect(() => {
    void load();
  }, [load]);

  // Passou do prazo da intenção: não adianta assinar; a tela oferece criar de novo.
  const expiresAt: number | undefined = data?.record.intent.expiresAt;
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (!expiresAt) return;
    const left = expiresAt - now();
    if (left <= 0) return setExpired(true);
    const t = setTimeout(() => setExpired(true), left * 1000);
    return () => clearTimeout(t);
  }, [expiresAt]);
  /** O mesmo envio, para criar de novo depois que expirou. */
  const again = () => {
    const i = data!.record.intent;
    ctx.go(`/send?${new URLSearchParams({ to: i.destination, amount: solInput(BigInt(i.amountLamports)) })}`);
  };

  // Primeiro envio para este endereço? (Endereço já usado não precisa de alerta.)
  const [firstTime, setFirstTime] = useState<boolean | null>(null);
  useEffect(() => {
    const destination = data?.record.intent.destination;
    if (handoff || !destination) return;
    void api<{ intents: IntentView[] }>("GET", `/v1/accounts/${ctx.session!.accountId}/intents`)
      .then((r) => setFirstTime(!r.intents.some((x) => x.intent.id !== id && x.status === "EXECUTED" && x.intent.destination === destination)))
      .catch(() => {});
  }, [data?.record.intent.destination]);

  /**
   * 1. biometria: abre a chave do webapp (antes de preparar de novo: a pessoa
   *    pode demorar aqui, e o blockhash não pode envelhecer nesse tempo);
   * 2. prepara de novo e confere os bytes; a chave assina na hora e é apagada;
   * 3. o serviço assina; o app confere que é a mesma transação e a assinatura;
   * 4. a carteira assina por último e paga.
   */
  const sign = async () => {
    if (!data?.request || !check?.ok) return;
    setErr(null);
    setBusy("sign");
    try {
      const c = await signer();
      let review = check.review;
      let request = data.request;
      setStepText(tr("Confirme com a biometria…", "Confirm with biometrics…"));
      const key = await unlockAccountKey(ctx, await keys(), summaryOf(request));
      let webappSignature: string;
      try {
        if (Date.now() - data.preparedAt > PREPARED_FRESH_MS) {
          setStepText(tr("Conferindo de novo…", "Checking again…"));
          const again = await prepare();
          setCheck(again.inspection);
          setData({ ...data, request: again.request, preparedAt: Date.now() });
          if (!again.inspection.ok) return;
          review = again.inspection.review;
          request = again.request;
        }
        // A chave do webapp assina só estes bytes conferidos.
        webappSignature = signatureB58(key.sign(review.message));
      } finally {
        key.wipe();
      }
      setStepText(tr("O serviço está assinando…", "The service is signing…"));
      const auth = await api<{ transaction: string }>("POST", `${base}/authorize`, { message: Buffer.from(review.message).toString("base64"), webappSignature }, opt);
      const tx = verifyAuthorized(review, auth.transaction);
      setStepText(tr(`Confirme na ${c.name}…`, `Confirm in ${walletDisplay(c.name)}…`));
      const signed = await c.signTransaction(tx);
      setStepText(tr("Enviando para a Solana…", "Sending to Solana…"));
      const out = await api<IntentView>("POST", `${base}/submit`, { transaction: signed }, opt);
      const intent = request.intent;
      if (intent.type === "ROTATE_MEMBER" && intent.role === "CLIENT" && out.status === "EXECUTED") return setHandedOver(true);
      await load();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
      setStepText(null);
    }
  };

  const reject = async () => {
    setErr(null);
    setBusy("reject");
    try {
      await api("POST", `${base}/reject`, undefined, opt);
      ctx.toast(data?.record.intent.type === "TRANSFER_SOL" ? tr("Envio cancelado. Nada foi para a Solana.", "Transfer cancelled. Nothing went to Solana.") : tr("Recusada. Nada foi para a Solana.", "Rejected. Nothing went to Solana."));
      await load();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const phoneDone = async (result: { status: string }) => {
    setQrOpen(false);
    const intent = data?.request?.intent;
    if (intent?.type === "ROTATE_MEMBER" && intent.role === "CLIENT" && result.status === "EXECUTED") return setHandedOver(true);
    await load();
  };
  const qrSheet = qrOpen && (
    <PhoneQrSheet
      create={() => api("POST", `/v1/intents/${id}/pay`, {})}
      title={data?.request?.intent.type === "ROTATE_MEMBER" && data.request.intent.role === "CLIENT" ? tr("Continue no celular (com a carteira ATUAL)", "Continue on your phone (with the CURRENT wallet)") : tr("Continue no celular", "Continue on your phone")}
      steps={SCAN_STEPS}
      onDone={phoneDone}
      onClose={() => setQrOpen(false)}
    />
  );

  if (handedOver) return <HandedOver />;
  if (!data) return <Loading err={err} />;
  const { record, request } = data;
  if (data.prepareErr) {
    const late = data.prepareCode === "INTENT_EXPIRED" || expired;
    return <PrepareFailed message={data.prepareErr} busy={busy} onRetry={late ? again : load} retryLabel={late ? tr("Criar de novo", "Create again") : tr("Tentar de novo", "Try again")} onReject={late ? undefined : reject} />;
  }
  if (!request) return <Outcome record={record} onAgain={again} />;
  if (!check) return <Loading err={err} label={tr("Conferindo…", "Checking…")} />;
  if (!check.ok) return <Blocked check={check} request={request} />;

  const intent = request.intent;
  const walletName = walletWord(handoff ? "Carteira do celular" : ctx.session!.walletName);
  const primaryClass = `btn ${intent.type === "ROTATE_MEMBER" ? "amber" : "primary"}`;
  const actions = (
    <>
      <div className="actions" style={{ flexWrap: "wrap" }}>
        <button type="button" className="btn" disabled={Boolean(busy)} onClick={reject}>
          {busy === "reject" ? <span className="spinner" /> : null}
          {intent.type === "TRANSFER_SOL" ? tr("Cancelar", "Cancel") : tr("Recusar", "Reject")}
        </button>
        {expired ? (
          <button type="button" className={primaryClass} onClick={again}>
            {tr("Criar de novo", "Create again")}
          </button>
        ) : viaPhone ? (
          <button type="button" className={primaryClass} disabled={Boolean(busy)} onClick={() => setQrOpen(true)}>
            <Icon name="phone" color="#0B0D10" sw={2} /> {tr("Continuar no celular", "Continue on your phone")}
          </button>
        ) : (
          <button type="button" className={primaryClass} disabled={Boolean(busy)} onClick={sign}>
            {busy === "sign" ? <span className="spinner" /> : <Icon name="finger" color="#0B0D10" sw={2} />}
            {tr("Assinar", "Sign")}
          </button>
        )}
        {stepText && (
          <div className="status" style={{ flexBasis: "100%", justifyContent: "center" }}>
            <span className="spinner" /> {stepText}
          </div>
        )}
        {!viaPhone && !busy && !handoff && !expired && (
          <button type="button" className="linkbtn" style={{ flexBasis: "100%", padding: "2px 0 0" }} onClick={() => setQrOpen(true)}>
            {tr("Ou continuar no celular (QR)", "Or continue on your phone (QR)")}
          </button>
        )}
      </div>
      {qrSheet}
    </>
  );
  const serverOk = (
    <div className="banner ok">
      <Icon name="shieldcheck" size={18} color="var(--accent)" />
      <div className="grow">
        {tr(
          "Conferido: a transação faz exatamente isto. O serviço conferiu a política e assina depois da sua biometria.",
          "Verified: the transaction does exactly this. The service checked the policy and signs after your biometrics.",
        )}
      </div>
      <div className="mono" style={{ color: "#8fa36b" }}>
        #{intent.transactionIndex}
      </div>
    </div>
  );
  if (intent.type === "ROTATE_MEMBER") return <RotationApproval request={request} header={serverOk} actions={actions} err={err} />;
  if (intent.type !== "TRANSFER_SOL") return <Loading err={tr("tipo de intenção ainda não suportado no app", "This intent type is not supported in the app yet")} />;

  const flags = record.riskFlags;
  const external = intent.destination !== intent.vault;
  return (
    <>
      <TopBar title={tr("Confirmar transação", "Confirm transaction")} right={<Countdown until={intent.expiresAt} />} />
      <div className="page">
        {serverOk}
        <div className="center" style={{ gap: 6, padding: "10px 0 2px" }}>
          <div className="muted" style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: "0.12em" }}>
            {tr("Enviar", "Send")}
          </div>
          <div className="big" style={{ fontSize: 52, letterSpacing: "-0.04em" }}>
            {sol(intent.amountLamports, 9)} <span style={{ fontSize: 24, color: "var(--muted)" }}>SOL</span>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="muted" style={{ fontSize: 13 }}>
            {tr("Para", "To")}
          </div>
          <div className="card" style={{ borderRadius: 18, padding: "14px 16px", gap: 10 }}>
            <div className="row-between">
              <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>
                {external ? short(intent.destination) : tr("Seu próprio Vault", "Your own Vault")}
              </div>
              {firstTime ? <span className="pill warn">{tr("Endereço novo", "New address")}</span> : handoff && flags.includes("EXTERNAL_DESTINATION") ? <span className="pill warn">{tr("Endereço externo", "External address")}</span> : null}
            </div>
            <div className="mono subtle" style={{ fontSize: 12, lineHeight: 1.5, wordBreak: "break-all" }}>
              {intent.destination}
            </div>
          </div>
        </div>
        <div>
          <Detail label={tr("De", "From")} value={tr(`Seu Vault · ${short(intent.vault)}`, `Your Vault · ${short(intent.vault)}`)} mono />
          <Detail label={tr("Programa", "Program")} value={intent.programs.map((p: string) => KNOWN_PROGRAM_NAMES[p] ?? short(p)).join(", ")} />
          <Detail label={tr("Assinaturas", "Signatures")} value={tr(`Biometria (chave do webapp) · ${walletName} · o serviço executa`, `Biometrics (webapp key) · ${walletName} · the service executes`)} />
          <Detail label={tr("Taxa de rede", "Network fee")} value={tr(`~0,000015 SOL · paga pela ${viaPhone ? "carteira" : walletName}`, `~0.000015 SOL · paid by ${viaPhone ? "the wallet" : walletName}`)} />
        </div>
        <div className="banner info">
          <Icon name="key" size={18} />
          <div>
            {tr(
              `Primeiro a sua biometria confirma exatamente esta transação; só então o serviço assina e ${viaPhone ? "a carteira do celular" : `a ${walletName}`} abre para assinar uma vez. Se algo falhar, nada acontece na Solana.`,
              `First your biometrics confirm exactly this transaction; only then does the service sign and ${viaPhone ? "the phone wallet" : walletName} open for you to sign once. If anything fails, nothing happens on Solana.`,
            )}
          </div>
        </div>
        {expired && (
          <div className="banner warn">
            <Icon name="clock" size={18} color="#F2B33D" />
            <div>{tr('O prazo de 10 minutos para assinar acabou. Nada foi assinado nem saiu do Vault. Toque em "Criar de novo" para refazer o mesmo envio.', 'The 10-minute window to sign is over. Nothing was signed and nothing left the Vault. Tap "Create again" to redo the same transfer.')}</div>
          </div>
        )}
        {firstTime && (
          <div className="banner warn">
            <Icon name="shieldalert" size={18} color="#F2B33D" />
            <div>{tr("Você nunca enviou para este endereço. Confira os primeiros e os últimos caracteres com quem vai receber.", "You have never sent to this address. Check the first and last characters with the recipient.")}</div>
          </div>
        )}
        {flags.includes("POSSIBLE_FULL_BALANCE") && (
          <div className="banner warn">
            <Icon name="shieldalert" size={18} color="#F2B33D" />
            <div>{tr("Esta transação envia quase todo o saldo do Vault.", "This transaction sends almost the entire Vault balance.")}</div>
          </div>
        )}
        {err && <div className="banner danger">{err}</div>}
      </div>
      {actions}
    </>
  );
}

function RotationApproval({ request, header, actions, err }: { request: ApprovalRequest; header: React.ReactNode; actions: React.ReactNode; err: string | null }) {
  const { session } = useApp();
  const intent = request.intent;
  if (intent.type !== "ROTATE_MEMBER") return null;
  const isClient = intent.role === "CLIENT";
  const currentWallet = session?.walletName && session.walletName !== "sem carteira" ? walletDisplay(session.walletName) : null;
  return (
    <>
      <TopBar title={tr("Segurança", "Security")} right={<Countdown until={intent.expiresAt} />} />
      <div className="page">
        <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 600, color: "var(--warn)", letterSpacing: "0.12em", textTransform: "uppercase" }}>
            <Icon name="shieldalert" size={16} color="#F2B33D" /> {tr("Alteração de segurança", "Security change")}
          </div>
          <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.2 }}>
            {isClient ? tr("Trocar a carteira da conta?", "Change the account wallet?") : tr("O serviço está pedindo para trocar a chave de segurança dele.", "The service is asking to change its security key.")}
          </div>
        </div>
        <div className="card" style={{ borderRadius: 20, padding: 16, gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div className="key-ico">
              <Icon name="key" size={18} />
            </div>
            <div className="grow">
              <div className="muted" style={{ fontSize: 12 }}>
                {isClient ? tr(`Atual (${currentWallet ?? "carteira da conta"})`, `Current (${currentWallet ?? "account wallet"})`) : tr("Chave atual do serviço", "Current service key")}
              </div>
              <div className="mono" style={{ fontSize: 17, color: "var(--muted)", textDecoration: "line-through", textDecorationColor: "#5b6270" }}>
                {short(intent.oldKey)}
              </div>
            </div>
          </div>
          <div style={{ paddingLeft: 12 }}>
            <Icon name="arrowdown" size={18} color="#F2B33D" />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div className="key-ico warn">
              <Icon name="key" size={18} color="#F2B33D" />
            </div>
            <div className="grow">
              <div className="muted" style={{ fontSize: 12 }}>
                {isClient ? tr("Carteira nova", "New wallet") : tr("Nova chave do serviço", "New service key")}
              </div>
              <div className="mono" style={{ fontSize: 17, fontWeight: 600 }}>
                {short(intent.newKey)}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--ok-text)" }}>
              <Icon name="check" size={14} color="#C8F169" sw={2.2} />
              {tr("posse conferida", "ownership verified")}
            </div>
          </div>
        </div>
        {header}
        <div>
          <Detail label={tr("Solicitado", "Requested")} value={fmtWhen(intent.createdAt)} />
          <Detail label={tr("Quem aprova", "Who approves")} value={isClient ? tr("Carteira atual + serviço", "Current wallet + service") : tr("Você + chave atual do serviço", "You + current service key")} />
        </div>
        {isClient ? (
          <div className="banner warn">
            <Icon name="shieldalert" size={18} color="#F2B33D" />
            <div>
              {lang === "pt" ? (
                <>
                  Assine com a carteira <b>atual</b> (<span className="mono">{short(intent.oldKey)}</span>). Ela paga a taxa e, na mesma transação, perde o acesso; a nova passa a assinar.
                </>
              ) : (
                <>
                  Sign with the <b>current</b> wallet (<span className="mono">{short(intent.oldKey)}</span>). It pays the fee and, in the same transaction, loses access; the new one becomes the signer.
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="banner danger" style={{ flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{tr("Não reconhece este pedido? Recuse.", "Don't recognize this request? Reject it.")}</div>
            <div style={{ color: "#d9a69e" }}>{tr("Sem a sua assinatura a chave do serviço não muda. Recusar não afeta seus fundos.", "Without your signature the service key doesn't change. Rejecting doesn't affect your funds.")}</div>
          </div>
        )}
        {err && <div className="banner danger">{err}</div>}
      </div>
      {actions}
    </>
  );
}

function PrepareFailed({ message, busy, onRetry, retryLabel, onReject }: { message: string; busy: null | string; onRetry: () => void; retryLabel: string; onReject?: () => void }) {
  return (
    <>
      <TopBar title={tr("Confirmar transação", "Confirm transaction")} />
      <div className="page" style={{ gap: 18 }}>
        <div className="banner warn">
          <Icon name="shieldalert" size={18} color="#F2B33D" />
          <div>
            <b>{tr("Não deu para preparar a transação.", "Couldn't prepare the transaction.")}</b> {message}
          </div>
        </div>
        <div className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
          {tr(
            "Nada foi assinado nem enviado. Taxa e depósito saem da sua carteira: o depósito das contas volta na mesma transação.",
            "Nothing was signed or sent. The fee and deposit come from your wallet: the account deposit comes back in the same transaction.",
          )}
        </div>
      </div>
      <div className="actions">
        {onReject && (
          <button type="button" className="btn" disabled={Boolean(busy)} onClick={onReject}>
            {busy === "reject" ? <span className="spinner" /> : null}
            {tr("Cancelar", "Cancel")}
          </button>
        )}
        <button type="button" className="btn primary" disabled={Boolean(busy)} onClick={onRetry}>
          {retryLabel}
        </button>
      </div>
    </>
  );
}

/** Motivos do bloqueio em inglês (mesmos códigos da tabela em português abaixo). */
const REASON_EN: Record<string, string> = {
  INTENT_MISMATCH: "What the server showed is not what the transaction does.",
  STALE_INDEX: "Another transaction got in before this one. Go back and open it again.",
  SERVER_NOT_SIGNED: "The service signature is missing from the transaction.",
  TX_MALFORMED: "The received transaction is unreadable.",
  INTENT_HASH_INVALID: "The received data doesn't match the intent signature.",
  INTENT_EXPIRED: "The time to sign is over.",
  PROPOSAL_NOT_ACTIVE: "The proposal is no longer open on Solana.",
  NOT_A_VOTER: "This wallet is no longer the account's wallet.",
  PROPOSAL_STALE: "The proposal became stale after a key change.",
  ROTATION_NOT_REQUESTED_HERE: "You didn't request this wallet change in this app.",
  ROTATION_PROOF_INVALID: "The proof that the new key belongs to who it claims doesn't check out.",
  ROTATION_PROOF_MISSING: "The proof that the new key belongs to who it claims is missing.",
};

function Blocked({ check, request }: { check: Extract<Inspection, { ok: false }>; request: ApprovalRequest }) {
  const { go } = useApp();
  const intent = request.intent;
  // O que a transação recebida faria de verdade (decodificada aqui, não dita pelo servidor).
  const op = check.actual?.length === 1 && check.actual[0]!.kind === "SYSTEM_TRANSFER" ? check.actual[0]! : null;
  const rows: [string, string, string][] = [];
  if (intent.type === "TRANSFER_SOL" && op?.kind === "SYSTEM_TRANSFER") {
    if (intent.amountLamports !== op.lamports.toString()) rows.push([tr("Valor", "Amount"), `${sol(intent.amountLamports, 9)} SOL`, `${sol(op.lamports, 9)} SOL`]);
    if (intent.destination !== op.to) rows.push([tr("Destino", "Destination"), short(intent.destination), short(op.to)]);
  }
  const reason: Record<string, string> = lang === "en" ? REASON_EN : {
    INTENT_MISMATCH: "O que o servidor mostrou não é o que a transação faz.",
    STALE_INDEX: "Outra transação entrou antes desta. Volte e abra de novo.",
    SERVER_NOT_SIGNED: "Falta a assinatura do serviço na transação.",
    TX_MALFORMED: "A transação recebida está ilegível.",
    INTENT_HASH_INVALID: "Os dados recebidos não batem com a assinatura da intenção.",
    INTENT_EXPIRED: "O prazo para assinar acabou.",
    PROPOSAL_NOT_ACTIVE: "A proposta não está mais aberta na Solana.",
    NOT_A_VOTER: "Esta carteira não é mais a carteira da conta.",
    PROPOSAL_STALE: "A proposta ficou obsoleta depois de uma troca de chave.",
    ROTATION_NOT_REQUESTED_HERE: "Você não pediu esta troca de carteira neste app.",
    ROTATION_PROOF_INVALID: "A prova de que a chave nova pertence a quem diz não confere.",
    ROTATION_PROOF_MISSING: "Falta a prova de que a chave nova pertence a quem diz.",
  };
  return (
    <>
      <div className="page" style={{ paddingTop: 56, gap: 24 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="danger-ico">
            <Icon name="shieldalert" size={32} color="#FF8F80" />
          </div>
          <div style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.15 }}>{tr("Transação bloqueada", "Transaction blocked")}</div>
          <div style={{ fontSize: 15, color: "#b4bac4", lineHeight: 1.5 }}>{reason[check.code] ?? (lang === "en" ? errorEn(check.code, check.message) : null) ?? check.message} {tr("Nada foi assinado e seus fundos não se moveram.", "Nothing was signed and your funds did not move.")}</div>
        </div>
        {rows.length > 0 && (
          <div className="diff-box">
            <div className="diff head">
              <div>{tr("Campo", "Field")}</div>
              <div>{tr("Mostrado", "Shown")}</div>
              <div>{tr("Na transação", "In the transaction")}</div>
            </div>
            {rows.map(([f, a, b]) => (
              <div className="diff" key={f}>
                <div className="muted">{f}</div>
                <div className="mono">{a}</div>
                <div className="mono" style={{ color: "var(--danger)" }}>
                  {b}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
          {tr("Código", "Code")}: <span className="mono">{check.code}</span>.
        </div>
      </div>
      <div className="actions">
        <button type="button" className="btn light" onClick={() => go("/")}>
          {tr("Entendi", "Got it")}
        </button>
      </div>
    </>
  );
}

function Outcome({ record, onAgain }: { record: IntentView; onAgain: () => void }) {
  const { go, config, session } = useApp();
  const ok = record.status === "EXECUTED";
  const intent = record.intent;
  const rot = intent.type === "ROTATE_MEMBER";
  const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=${config.cluster === "devnet" ? "devnet" : `custom&customUrl=${encodeURIComponent("http://127.0.0.1:8899")}`}`;
  // Uma transação só (criar, aprovar, executar, fechar): os passos não têm assinaturas separadas.
  const steps = rot
    ? [tr("O serviço conferiu e assinou", "The service checked and signed"), tr(`Você assinou e pagou na ${walletWord(session?.walletName)}`, `You signed and paid in ${walletWord(session?.walletName)}`), tr("Chaves trocadas na Solana", "Keys changed on Solana")]
    : [
        tr("Sua biometria confirmou (chave do webapp)", "Your biometrics confirmed (webapp key)"),
        tr("O serviço conferiu a política e assinou", "The service checked the policy and signed"),
        tr(`Você assinou e pagou na ${walletWord(session?.walletName)}`, `You signed and paid in ${walletWord(session?.walletName)}`),
        tr("Executada na Solana", "Executed on Solana"),
      ];
  const sig = record.signatures.execute;
  const title: Record<string, string> = {
    REJECTED: rot ? tr("Recusada", "Rejected") : tr("Envio cancelado", "Transfer cancelled"),
    EXPIRED: tr("Prazo expirado", "Expired"),
    FAILED: tr("Falhou", "Failed"),
    CANCELLED: tr("Cancelada", "Cancelled"),
  };
  const why: Record<string, string> = {
    REJECTED: tr("Você cancelou antes de assinar.", "You cancelled before signing."),
    EXPIRED: tr("O prazo de 10 minutos acabou antes da assinatura.", "The 10-minute window ran out before signing."),
    FAILED: tr("A transação não foi aceita pela Solana.", "Solana did not accept the transaction."),
    CANCELLED: tr("O pedido foi cancelado.", "The request was cancelled."),
  };
  const canRedo = !ok && !rot && (record.status === "EXPIRED" || record.status === "FAILED" || record.status === "REJECTED");
  return (
    <>
      <div className="page" style={{ paddingTop: 56, gap: 26 }}>
        <div className="center">
          <div className="hero-ico" style={{ background: ok ? "var(--accent)" : "var(--surface-2)", border: ok ? 0 : "1px solid var(--line)" }}>
            <Icon name={ok ? "check" : "x"} size={44} color={ok ? "#0B0D10" : "var(--muted)"} sw={2.4} />
          </div>
          <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em" }}>{ok ? (rot ? tr("Chave trocada", "Key changed") : tr("Envio executado", "Transfer executed")) : title[record.status] ?? record.status}</div>
          <div className="muted" style={{ fontSize: 15 }}>
            {rot ? (
              <>
                <span className="mono">{short(intent.oldKey)}</span> → <span className="mono" style={{ color: "var(--text)" }}>{short(intent.newKey)}</span>
              </>
            ) : (
              <>
                <span className="mono" style={{ color: "var(--text)" }}>{sol(intent.amountLamports, 9)} SOL</span> {tr("para", "to")} <span className="mono">{short(intent.destination)}</span>
              </>
            )}
          </div>
          {!ok && (
            <div className="muted" style={{ fontSize: 14, lineHeight: 1.5, textAlign: "center" }}>
              {why[record.status] ?? ""} {rot ? tr("Nada mudou na conta.", "Nothing changed in the account.") : tr("Nada saiu do Vault.", "Nothing left the Vault.")}
            </div>
          )}
          {record.status === "FAILED" && record.reasons.length > 0 && <div className="banner warn" style={{ textAlign: "left" }}>{record.reasons.join(" · ")}</div>}
        </div>
        {ok && (
          <div className="card" style={{ padding: "8px 16px", gap: 0 }}>
            {steps.map((t) => (
              <div key={t} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0" }}>
                <div className="dot" style={{ background: "var(--accent)" }}>
                  <Icon name="check" size={14} color="#0B0D10" sw={2.4} />
                </div>
                <div className="grow" style={{ fontSize: 14 }}>
                  {t}
                </div>
              </div>
            ))}
            {sig && (
              <a href={explorer(sig)} target="_blank" rel="noreferrer" style={{ fontSize: 13, textDecoration: "none", display: "flex", gap: 6, alignItems: "center", justifyContent: "center", padding: "12px 0 8px", borderTop: "1px solid var(--line-soft)" }}>
                {tr("Ver na Solana", "View on Solana")} <span className="mono">{short(sig)}</span> <Icon name="ext" size={12} />
              </a>
            )}
          </div>
        )}
      </div>
      <div className="actions">
        <button type="button" className="btn" onClick={() => go("/")}>
          {tr("Voltar ao início", "Back to home")}
        </button>
        {canRedo && (
          <button type="button" className="btn primary" onClick={onAgain}>
            {tr("Criar de novo", "Create again")}
          </button>
        )}
      </div>
    </>
  );
}

function HandedOver() {
  const ctx = useApp();
  return (
    <>
      <div className="page" style={{ paddingTop: 56, gap: 22 }}>
        <div className="center">
          <div className="hero-ico" style={{ background: "var(--accent)" }}>
            <Icon name="check" size={44} color="#0B0D10" sw={2.4} />
          </div>
          <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em" }}>{tr("Carteira trocada", "Wallet changed")}</div>
          <div className="muted" style={{ fontSize: 15, lineHeight: 1.5 }}>
            {tr(
              "A carteira nova agora assina pela conta. A antiga saiu da multisig na Solana e não volta a valer.",
              "The new wallet now signs for the account. The old one was removed from the multisig on Solana and won't work again.",
            )}
          </div>
        </div>
      </div>
      <div className="actions">
        <button
          type="button"
          className="btn primary"
          onClick={async () => {
            await ctx.setSession(null);
            ctx.go("/");
          }}
        >
          {tr("Entrar com a carteira nova", "Sign in with the new wallet")}
        </button>
      </div>
    </>
  );
}

function Loading({ err, label = tr("Carregando…", "Loading…") }: { err: string | null; label?: string }) {
  return (
    <>
      <TopBar title="" />
      <div className="page" style={{ alignItems: "center", justifyContent: "center" }}>
        {err ? (
          <div className="banner danger">{err}</div>
        ) : (
          <div className="status">
            <span className="spinner" /> {label}
          </div>
        )}
      </div>
    </>
  );
}
