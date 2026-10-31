import { useCallback, useEffect, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { inspectPrepared, verifyAuthorized, type ApprovalRequest, type Inspection } from "@duplachave/custody/src/client";
import { signatureB58, type WebappKeyBlob } from "../lib/webappKey";
import { KNOWN_PROGRAM_NAMES } from "@duplachave/solana";
import { accountKeyBlobs, errorText, unlockAccountKey, useApp } from "../app";
import { api, ApiError } from "../lib/api";
import { ConnectedWallet, MWA_NAME, PHONE_WALLET, walletDisplay, walletWord } from "../lib/wallets";
import { now, short, sol, solInput } from "../lib/chain";
import { Icon } from "../icons";
import type { IntentView } from "./home";
import { PhoneQrSheet, SCAN_STEPS } from "../components/PhoneQr";
import { TopBar } from "../components/TopBar";
import { Countdown } from "../components/Countdown";
import { Detail } from "../components/Detail";
import { tr } from "../lib/i18n";
import { RotationApproval } from "./intent/RotationApproval";
import { Blocked } from "./intent/Blocked";
import { Outcome } from "./intent/Outcome";
import { HandedOver, Loading, PrepareFailed } from "./intent/states";

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
/** Opções estáveis para os pedidos sem sessão (pelo token do QR). */
const NO_AUTH = { auth: false } as const;

type Loaded = { record: IntentView; request: ApprovalRequest | null; preparedAt: number; prepareErr: string | null; prepareCode?: string };

/**
 * `handoff`: aberta pelo QR no celular, sem entrar na conta. O token do QR dá
 * acesso a esta intenção; a biometria e a carteira da conta continuam sendo
 * quem autoriza. A carteira do celular conecta e assina na mesma abertura.
 */
export function IntentScreen({ id, handoff }: { id: string; handoff?: { token: string; wallet: string } }) {
  const ctx = useApp();
  const base = handoff ? `/v1/handoff/${handoff.token}` : `/v1/intents/${id}`;
  // Os hooks abaixo dependem só de valores estáveis (o objeto `handoff` vem novo a cada render do pai).
  const isHandoff = Boolean(handoff);
  const opt = isHandoff ? NO_AUTH : undefined;
  const accountId = ctx.session?.accountId;
  const myWallet = handoff?.wallet ?? ctx.session!.publicKey;
  /** A carteira que assina: a da sessão, ou (pelo QR) a carteira do celular já sabendo qual conta esperar. */
  const signer = async () => {
    if (!handoff) return ctx.accountWallet();
    const w = ctx.wallets.find((x) => x.name === MWA_NAME);
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
  /** O blockhash venceu na carteira: nada entrou na chain, e dá para assinar de novo (a biometria vem antes de preparar outra). */
  const [resign, setResign] = useState(false);
  const viaPhone = !handoff && ctx.session?.via === "phone";
  const keysRef = useRef<{ publicKey: string; blob: WebappKeyBlob }[] | null>(null);
  /** As cópias cifradas da chave do webapp (a chave pública dela entra na conferência). */
  const keys = useCallback(async () => {
    keysRef.current ??= await accountKeyBlobs(isHandoff ? `${base}/key` : `/v1/accounts/${accountId}/webapp-keys`, !isHandoff);
    return keysRef.current;
  }, [base, isHandoff, accountId]);

  /** Pede a transação atômica (ainda sem assinaturas) e confere: o webapp remonta os bytes sozinho. */
  const malicious = ctx.dev.malicious;
  const prepare = useCallback(async () => {
    const path = malicious && !isHandoff ? `/v1/dev/intents/${id}/prepare-tampered` : `${base}/prepare`;
    const k = await keys();
    if (!k.length) throw new Error(tr("Esta conta não tem a chave do webapp guardada.", "This account has no webapp key stored."));
    const request = await api<ApprovalRequest>("POST", path, {}, opt);
    const inspection = await inspectPrepared(ctx.chain, request, { client: new PublicKey(myWallet), webapp: new PublicKey(k[0]!.publicKey) }, now());
    return { request, inspection };
  }, [id, base, isHandoff, opt, malicious, myWallet, keys, ctx.chain]);

  /**
   * Cada `load` tem um número; só o mais recente escreve no estado. Assim um
   * carregamento atrasado não sobrescreve o que a assinatura em andamento já conferiu.
   */
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const fresh = () => seq === loadSeq.current;
    try {
      const r = await api<{ record: IntentView }>("GET", isHandoff ? `${base}/intent` : base, undefined, opt);
      if (!fresh()) return;
      if (r.record.status !== "AWAITING_CLIENT") return setData({ record: r.record, request: null, preparedAt: 0, prepareErr: null });
      try {
        const { request, inspection } = await prepare();
        if (!fresh()) return;
        setData({ record: r.record, request, preparedAt: Date.now(), prepareErr: null });
        setCheck(inspection);
      } catch (e) {
        if (!fresh()) return;
        setData({ record: r.record, request: null, preparedAt: 0, prepareErr: errorText(e), prepareCode: e instanceof ApiError ? e.code : undefined });
      }
    } catch (e) {
      if (fresh()) setErr(errorText(e));
    }
  }, [base, isHandoff, opt, prepare]);

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
    if (i.type !== "TRANSFER_SOL") return;
    ctx.go(`/send?${new URLSearchParams({ to: i.destination, amount: solInput(BigInt(i.amountLamports)) })}`);
  };

  // Primeiro envio para este endereço? (Endereço já usado não precisa de alerta.)
  const [firstTime, setFirstTime] = useState<boolean | null>(null);
  const destination = data?.record.intent.kind === "OPERATION" ? data.record.intent.destination : undefined;
  useEffect(() => {
    if (isHandoff || !destination || !accountId) return;
    void api<{ intents: IntentView[] }>("GET", `/v1/accounts/${accountId}/intents`)
      .then((r) => setFirstTime(!r.intents.some((x) => x.intent.id !== id && x.status === "EXECUTED" && x.intent.kind === "OPERATION" && x.intent.destination === destination)))
      .catch(() => {});
  }, [destination, isHandoff, accountId, id]);

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
    setResign(false);
    setBusy("sign");
    // Um `load` que ainda esteja no ar não deve mexer no estado durante a assinatura.
    loadSeq.current++;
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
      // A pessoa demorou na carteira: a transação preparada venceu, nada saiu. "Assinar de novo"
      // refaz biometria → preparar → serviço → carteira (sign() prepara de novo quando passou da janela).
      if (e instanceof ApiError && (e.code === "TX_EXPIRED" || e.code === "PREPARED_EXPIRED")) setResign(true);
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
  const walletName = walletWord(handoff ? PHONE_WALLET : ctx.session!.walletName);
  const primaryClass = `btn ${intent.type === "ROTATE_MEMBER" ? "amber" : "primary"}`;
  const actions = (
    <>
      <div className="actions" style={{ flexWrap: "wrap" }}>
        <button type="button" className="btn" disabled={Boolean(busy)} aria-busy={busy === "reject"} onClick={reject}>
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
          <button type="button" className={primaryClass} disabled={Boolean(busy)} aria-busy={busy === "sign"} onClick={sign}>
            {busy === "sign" ? <span className="spinner" /> : <Icon name="finger" color="#0B0D10" sw={2} />}
            {resign ? tr("Assinar de novo", "Sign again") : tr("Assinar", "Sign")}
          </button>
        )}
        {stepText && (
          <div className="status" role="status" aria-live="polite" style={{ flexBasis: "100%", justifyContent: "center" }}>
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
          <div className="eyebrow" style={{ justifyContent: "center" }}>
            {tr("Enviar", "Send")}
          </div>
          <div className="big amount-xl">
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
