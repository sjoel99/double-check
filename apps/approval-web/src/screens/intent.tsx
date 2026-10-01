import { useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { buildWalletTransaction, inspectOnChain, type ApprovalRequest, type Inspection } from "@duplachave/custody/src/client";
import { KNOWN_PROGRAM_NAMES } from "@duplachave/solana";
import { errorText, useApp } from "../app";
import { api } from "../lib/api";
import { now, short, sol } from "../lib/chain";
import { Icon } from "../icons";
import type { IntentView } from "./home";
import { PhoneQrSheet, SCAN_STEPS } from "../components/PhoneQr";

function TopBar({ title, right }: { title: string; right?: React.ReactNode }) {
  const { go } = useApp();
  return (
    <div className="topbar">
      <button type="button" className="iconbtn" aria-label="Voltar" onClick={() => go("/")}>
        <Icon name="back" />
      </button>
      <h1>{title}</h1>
      {right}
    </div>
  );
}

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
  const [dest, setDest] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const valid = (() => {
    try {
      new PublicKey(dest.trim());
      return /^\d+([.,]\d{1,9})?$/.test(amount.trim());
    } catch {
      return false;
    }
  })();
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
      <TopBar title="Enviar SOL" />
      <div className="page">
        <div className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
          O serviço monta a transação, confere a sua política e aprova. Depois você revisa e assina uma vez na {ctx.session!.walletName}.
        </div>
        <div className="field">
          <label htmlFor="dest">Endereço de destino</label>
          <input id="dest" className="input mono" value={dest} onChange={(e) => setDest(e.target.value)} placeholder="Endereço Solana" spellCheck={false} autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor="amt">Quantidade (SOL)</label>
          <input id="amt" className="input mono" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0,5" />
        </div>
        {err && <div className="banner danger">{err}</div>}
      </div>
      <div className="actions">
        <button type="button" className="btn primary" disabled={!valid || busy} onClick={submit}>
          {busy ? <span className="spinner" /> : null} Revisar
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Revisar e assinar

type Loaded = { record: IntentView; request: ApprovalRequest | null };

export function IntentScreen({ id }: { id: string }) {
  const ctx = useApp();
  const [data, setData] = useState<Loaded | null>(null);
  const [check, setCheck] = useState<Inspection | null>(null);
  const [busy, setBusy] = useState<null | "sign" | "reject" | "retry">(null);
  const [err, setErr] = useState<string | null>(null);
  const [handedOver, setHandedOver] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const viaPhone = ctx.session?.via === "phone";

  const load = useCallback(async () => {
    try {
      const r = await api<{ record: IntentView; approvalRequest: ApprovalRequest | null }>("GET", `/v1/intents/${id}`);
      let request = r.approvalRequest;
      if (request && ctx.dev.malicious && r.record.intent.type === "TRANSFER_SOL" && request.mode !== "CANCEL") {
        request = await api<ApprovalRequest>("GET", `/v1/dev/intents/${id}/tampered`);
      }
      setData({ record: r.record, request });
      // A conferência é do app: lê a transação pela RPC fixada no build e compara com o que vai mostrar.
      if (request) setCheck(await inspectOnChain(ctx.chain, request, new PublicKey(ctx.session!.publicKey), now(), { initiatedHere: ctx.initiatedHere }));
    } catch (e) {
      setErr(errorText(e));
    }
  }, [id, ctx]);

  useEffect(() => {
    void load();
  }, [load]);

  const sign = async () => {
    if (!data?.request) return;
    setErr(null);
    setBusy("sign");
    try {
      const c = await ctx.accountWallet();
      const { transaction } = await buildWalletTransaction({ chain: ctx.chain, request: data.request, wallet: new PublicKey(c.publicKey), now: now(), initiatedHere: ctx.initiatedHere });
      const signed = await c.signTransaction(transaction);
      const out = await api<IntentView>("POST", `/v1/intents/${id}/sign`, { transaction: signed });
      const intent = data.request.intent;
      if (intent.type === "ROTATE_MEMBER" && intent.role === "CLIENT" && out.status === "EXECUTED") return setHandedOver(true);
      if (data.request.mode === "CANCEL") ctx.toast("Cancelada na Solana. Nada mais pode executá-la.");
      await load();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    setErr(null);
    setBusy("reject");
    try {
      await api("POST", `/v1/intents/${id}/reject`);
      ctx.toast("Recusada. A proposta foi encerrada na Solana.");
      await load();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const retry = async () => {
    setErr(null);
    setBusy("retry");
    try {
      await api("POST", `/v1/intents/${id}/execute`);
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
    if (data?.request?.mode === "CANCEL") ctx.toast("Cancelada na Solana. Nada mais pode executá-la.");
    await load();
  };
  const qrSheet = qrOpen && (
    <PhoneQrSheet
      create={() => api("POST", `/v1/intents/${id}/pay`, {})}
      title={data?.request?.intent.type === "ROTATE_MEMBER" && data.request.intent.role === "CLIENT" ? "Escaneie com a carteira ATUAL" : "Escaneie com a carteira do celular"}
      steps={SCAN_STEPS}
      onDone={phoneDone}
      onClose={() => setQrOpen(false)}
    />
  );

  if (handedOver) return <HandedOver />;
  if (!data) return <Loading err={err} />;
  const { record, request } = data;
  if (!request) return <Outcome record={record} />;
  if (!check) return <Loading err={err} label="Conferindo na Solana…" />;
  if (!check.ok) return <Blocked check={check} request={request} />;
  if (request.mode === "CANCEL")
    return (
      <>
        <PendingExecution record={record} busy={busy} err={err} onRetry={retry} onCancel={viaPhone ? () => setQrOpen(true) : sign} />
        {qrSheet}
      </>
    );

  const intent = request.intent;
  const walletName = ctx.session!.walletName;
  const primaryClass = `btn ${intent.type === "ROTATE_MEMBER" ? "amber" : "primary"}`;
  const actions = (
    <>
      <div className="actions" style={{ flexWrap: "wrap" }}>
        <button type="button" className="btn" disabled={Boolean(busy)} onClick={reject}>
          {busy === "reject" ? <span className="spinner" /> : null}Recusar
        </button>
        {viaPhone ? (
          <button type="button" className={primaryClass} disabled={Boolean(busy)} onClick={() => setQrOpen(true)}>
            <Icon name="phone" color="#0B0D10" sw={2} /> Assinar no celular
          </button>
        ) : (
          <button type="button" className={primaryClass} disabled={Boolean(busy)} onClick={sign}>
            {busy === "sign" ? <span className="spinner" /> : <Icon name="key" color="#0B0D10" sw={2} />}
            {walletName.length <= 12 ? `Assinar na ${walletName}` : "Assinar na carteira"}
          </button>
        )}
        {!viaPhone && (
          <button type="button" className="linkbtn" style={{ flexBasis: "100%", padding: "2px 0 0" }} onClick={() => setQrOpen(true)}>
            Ou assinar no celular (QR)
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
        Conferido na Solana: idêntico ao que você vê.{check.serverApproved ? " O serviço já conferiu a política e aprovou." : ""}
      </div>
      <div className="mono" style={{ color: "#8fa36b" }}>
        #{intent.transactionIndex}
      </div>
    </div>
  );
  if (intent.type === "ROTATE_MEMBER") return <RotationApproval request={request} header={serverOk} actions={actions} err={err} />;
  if (intent.type !== "TRANSFER_SOL") return <Loading err="tipo de intenção ainda não suportado no app" />;

  const flags = record.riskFlags;
  const external = intent.destination !== intent.vault;
  return (
    <>
      <TopBar title="Confirmar transação" right={<Countdown until={intent.expiresAt} />} />
      <div className="page">
        {serverOk}
        <div className="center" style={{ gap: 6, padding: "10px 0 2px" }}>
          <div className="muted" style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: "0.12em" }}>
            Enviar
          </div>
          <div className="big" style={{ fontSize: 52, letterSpacing: "-0.04em" }}>
            {sol(intent.amountLamports, 9)} <span style={{ fontSize: 24, color: "var(--muted)" }}>SOL</span>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="muted" style={{ fontSize: 13 }}>
            Para
          </div>
          <div className="card" style={{ borderRadius: 18, padding: "14px 16px", gap: 10 }}>
            <div className="row-between">
              <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>
                {external ? short(intent.destination) : "Seu próprio Vault"}
              </div>
              {flags.includes("EXTERNAL_DESTINATION") && <span className="pill warn">Endereço externo</span>}
            </div>
            <div className="mono subtle" style={{ fontSize: 12, lineHeight: 1.5, wordBreak: "break-all" }}>
              {intent.destination}
            </div>
          </div>
        </div>
        <div>
          <Detail label="De" value={`Seu Vault · ${short(intent.vault)}`} mono />
          <Detail label="Programa" value={intent.programs.map((p: string) => KNOWN_PROGRAM_NAMES[p] ?? short(p)).join(", ")} />
          <Detail label="Assinaturas" value={`Serviço ✓ · você (${walletName})`} />
          <Detail label="Taxa de rede" value="Paga pelo serviço" />
        </div>
        <div className="banner info">
          <Icon name="key" size={18} />
          <div>{viaPhone ? "A carteira do celular" : `A ${walletName}`} assina uma vez a aprovação e a execução juntas: se a execução falhar, nada fica aprovado.</div>
        </div>
        {flags.includes("POSSIBLE_FULL_BALANCE") && (
          <div className="banner warn">
            <Icon name="shieldalert" size={18} color="#F2B33D" />
            <div>Esta transação envia quase todo o saldo do Vault.</div>
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
  const when = new Date(intent.createdAt * 1000).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  return (
    <>
      <TopBar title="Segurança" right={<Countdown until={intent.expiresAt} />} />
      <div className="page">
        <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 600, color: "var(--warn)", letterSpacing: "0.12em", textTransform: "uppercase" }}>
            <Icon name="shieldalert" size={16} color="#F2B33D" /> Alteração de segurança
          </div>
          <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.2 }}>
            {isClient ? "Trocar a carteira da conta?" : "O serviço está pedindo para trocar a chave de segurança dele."}
          </div>
        </div>
        <div className="card" style={{ borderRadius: 20, padding: 16, gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div className="key-ico">
              <Icon name="key" size={18} />
            </div>
            <div className="grow">
              <div className="muted" style={{ fontSize: 12 }}>
                {isClient ? `Atual (${session!.walletName})` : "Chave atual do serviço"}
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
                {isClient ? "Carteira nova" : "Nova chave do serviço"}
              </div>
              <div className="mono" style={{ fontSize: 17, fontWeight: 600 }}>
                {short(intent.newKey)}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--ok-text)" }}>
              <Icon name="check" size={14} color="#C8F169" sw={2.2} />
              posse conferida
            </div>
          </div>
        </div>
        {header}
        <div>
          <Detail label="Solicitado" value={when} />
          <Detail label="Quem aprova" value={isClient ? "Carteira atual + serviço" : "Você + chave atual do serviço"} />
        </div>
        {isClient ? (
          <div className="banner warn">
            <Icon name="shieldalert" size={18} color="#F2B33D" />
            <div>
              Assine com a carteira <b>atual</b> (<span className="mono">{short(intent.oldKey)}</span>). Depois disso ela perde o acesso, e a nova passa a assinar. Envios ficam pausados até terminar.
            </div>
          </div>
        ) : (
          <div className="banner danger" style={{ flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>Não reconhece este pedido? Recuse.</div>
            <div style={{ color: "#d9a69e" }}>Sem a sua assinatura a chave do serviço não muda. Recusar não afeta seus fundos.</div>
          </div>
        )}
        {err && <div className="banner danger">{err}</div>}
      </div>
      {actions}
    </>
  );
}

function PendingExecution({ record, busy, err, onRetry, onCancel }: { record: IntentView; busy: null | string; err: string | null; onRetry: () => void; onCancel: () => void }) {
  const { session } = useApp();
  return (
    <>
      <TopBar title="Aguardando execução" />
      <div className="page" style={{ gap: 18 }}>
        <div className="banner warn">
          <Icon name="shieldalert" size={18} color="#F2B33D" />
          <div>Você e o serviço aprovaram, mas a execução falhou. A proposta continua válida na Solana: execute de novo ou cancele (o cancelamento também precisa da sua {session!.walletName} e do serviço).</div>
        </div>
        <Detail label="Motivo" value={record.reasons.join(" · ") || "—"} />
        {err && <div className="banner danger">{err}</div>}
      </div>
      <div className="actions">
        <button type="button" className="btn" disabled={Boolean(busy)} onClick={onCancel}>
          {busy === "sign" ? <span className="spinner" /> : null}Cancelar
        </button>
        <button type="button" className="btn primary" disabled={Boolean(busy)} onClick={onRetry}>
          {busy === "retry" ? <span className="spinner" /> : null}Executar de novo
        </button>
      </div>
    </>
  );
}

function Blocked({ check, request }: { check: Extract<Inspection, { ok: false }>; request: ApprovalRequest }) {
  const { go } = useApp();
  const intent = request.intent;
  const op = check.view?.kind === "VAULT" ? check.view.operation : null;
  const rows: [string, string, string][] = [];
  if (intent.type === "TRANSFER_SOL" && op?.type === "TRANSFER_SOL") {
    if (intent.amountLamports !== op.amountLamports) rows.push(["Valor", `${sol(intent.amountLamports, 9)} SOL`, `${sol(op.amountLamports, 9)} SOL`]);
    if (intent.destination !== op.destination) rows.push(["Destino", short(intent.destination), short(op.destination)]);
  }
  const reason: Record<string, string> = {
    INTENT_MISMATCH: "O que o servidor mostrou não é o que está na Solana.",
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
          <div style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.15 }}>Transação bloqueada</div>
          <div style={{ fontSize: 15, color: "#b4bac4", lineHeight: 1.5 }}>{reason[check.code] ?? check.message} Nada foi assinado e seus fundos não se moveram.</div>
        </div>
        {rows.length > 0 && (
          <div className="diff-box">
            <div className="diff head">
              <div>Campo</div>
              <div>Mostrado</div>
              <div>Na Solana</div>
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
          Código: <span className="mono">{check.code}</span>.
        </div>
      </div>
      <div className="actions">
        <button type="button" className="btn light" onClick={() => go("/")}>
          Entendi
        </button>
      </div>
    </>
  );
}

function Outcome({ record }: { record: IntentView }) {
  const { go, config, session } = useApp();
  const ok = record.status === "EXECUTED";
  const intent = record.intent;
  const rot = intent.type === "ROTATE_MEMBER";
  const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=${config.cluster === "devnet" ? "devnet" : `custom&customUrl=${encodeURIComponent("http://127.0.0.1:8899")}`}`;
  const steps: [string, string | undefined][] = rot
    ? [
        ["Proposta criada na Solana", record.signatures.create],
        ["Serviço conferiu e aprovou", record.signatures.serverApprove],
        [`Você aprovou na ${session?.walletName ?? "carteira"}`, record.signatures.clientApprove],
        ["Chaves trocadas na Solana", record.signatures.execute],
      ]
    : [
        ["Proposta criada na Solana", record.signatures.create],
        ["Serviço conferiu a política e aprovou", record.signatures.serverApprove],
        [`Você assinou na ${session?.walletName ?? "carteira"} (aprovou e executou)`, record.signatures.clientApprove],
      ];
  const label: Record<string, string> = { REJECTED: "Transação recusada", EXPIRED: "Prazo expirado", FAILED: "Falhou", CANCELLED: "Cancelada", EXECUTING: "Executando" };
  return (
    <>
      <div className="page" style={{ paddingTop: 56, gap: 26 }}>
        <div className="center">
          <div className="hero-ico" style={{ background: ok ? "var(--accent)" : "var(--surface-2)", border: ok ? 0 : "1px solid var(--line)" }}>
            <Icon name={ok ? "check" : "x"} size={44} color={ok ? "#0B0D10" : "var(--muted)"} sw={2.4} />
          </div>
          <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em" }}>{ok ? (rot ? "Chave trocada" : "Transação executada") : label[record.status] ?? record.status}</div>
          <div className="muted" style={{ fontSize: 15 }}>
            {rot ? (
              <>
                <span className="mono">{short(intent.oldKey)}</span> → <span className="mono" style={{ color: "var(--text)" }}>{short(intent.newKey)}</span>
              </>
            ) : (
              <>
                <span className="mono" style={{ color: "var(--text)" }}>{sol(intent.amountLamports, 9)} SOL</span> para <span className="mono">{short(intent.destination)}</span>
              </>
            )}
          </div>
          {record.reasons.length > 0 && <div className="banner warn" style={{ textAlign: "left" }}>{record.reasons.join(" · ")}</div>}
        </div>
        <div className="card" style={{ padding: "8px 16px", gap: 0 }}>
          {steps.map(([t, sig]) => (
            <div key={t} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0" }}>
              <div className="dot" style={{ background: sig ? "var(--accent)" : "#343a44" }}>
                <Icon name={sig ? "check" : "x"} size={14} color="#0B0D10" sw={2.4} />
              </div>
              <div className="grow" style={{ fontSize: 14 }}>
                {t}
              </div>
              {sig && (
                <a href={explorer(sig)} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 12, textDecoration: "none", display: "flex", gap: 4, alignItems: "center" }}>
                  {short(sig)} <Icon name="ext" size={12} />
                </a>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="actions">
        <button type="button" className="btn" onClick={() => go("/")}>
          Voltar ao início
        </button>
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
          <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em" }}>Carteira trocada</div>
          <div className="muted" style={{ fontSize: 15, lineHeight: 1.5 }}>
            A carteira nova agora assina pela conta. A antiga saiu da multisig na Solana e não volta a valer.
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
          Entrar com a carteira nova
        </button>
      </div>
    </>
  );
}

function Loading({ err, label = "Carregando…" }: { err: string | null; label?: string }) {
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
