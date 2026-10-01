import { useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { inspectOnChain, signClientDecision, type ApprovalRequest, type Inspection } from "@duplachave/custody/src/client";
import { KNOWN_PROGRAM_NAMES } from "@duplachave/solana";
import { errorText, useApp } from "../app";
import { api } from "../lib/api";
import { now, short, sol } from "../lib/chain";
import { Icon } from "../icons";
import type { IntentView } from "./home";

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
  const mm = String(Math.floor(left / 60)).padStart(2, "0");
  const ss = String(left % 60).padStart(2, "0");
  return (
    <div className="pill mono" style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", border: "1px solid var(--line)", background: "var(--surface)", color: left < 60 ? "var(--warn)" : "var(--muted)", fontSize: 12 }}>
      <Icon name="clock" size={14} />
      {mm}:{ss}
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
      const r = await api("POST", `/v1/accounts/${ctx.device!.session!.accountId}/intents`, { type: "TRANSFER_SOL", destination: dest.trim(), amountSol: amount.trim() });
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
          O serviço monta a transação e confere a política. Depois você revisa o que está na Solana e aprova.
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
          {busy ? <span className="spinner" /> : null} Continuar
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Intenção

type Loaded = { record: IntentView; approvalRequest: ApprovalRequest | null; tampered: boolean };

export function IntentScreen({ id }: { id: string }) {
  const ctx = useApp();
  const [data, setData] = useState<Loaded | null>(null);
  const [check, setCheck] = useState<Inspection | null>(null);
  const [busy, setBusy] = useState<null | "APPROVE" | "REJECT">(null);
  const [err, setErr] = useState<string | null>(null);
  const [handedOver, setHandedOver] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<{ record: IntentView; approvalRequest: ApprovalRequest | null }>("GET", `/v1/intents/${id}`);
      let request = r.approvalRequest;
      let tampered = false;
      if (request && ctx.dev.malicious && r.record.intent.type === "TRANSFER_SOL") {
        request = await api<ApprovalRequest>("GET", `/v1/dev/intents/${id}/tampered`);
        tampered = true;
      }
      setData({ record: r.record, approvalRequest: request, tampered });
      if (request) {
        // A conferência é do app: lê a transação pela RPC dele e compara com o que vai mostrar.
        setCheck(await inspectOnChain(ctx.chain, request.intent, new PublicKey(ctx.device!.publicKey), now()));
      }
    } catch (e) {
      setErr(errorText(e));
    }
  }, [id, ctx]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (decision: "APPROVE" | "REJECT") => {
    if (!data?.approvalRequest) return;
    setErr(null);
    const intent = data.approvalRequest.intent;
    const summary =
      intent.type === "ROTATE_MEMBER" ? `${decision === "APPROVE" ? "Aprovar" : "Rejeitar"} troca de chave · #${intent.transactionIndex}` : `${decision === "APPROVE" ? "Aprovar" : "Rejeitar"} ${sol(intent.type === "TRANSFER_SOL" ? intent.amountLamports : "0")} SOL · #${intent.transactionIndex}`;
    try {
      await ctx.unlock(summary);
    } catch {
      return;
    }
    setBusy(decision);
    try {
      const payload = await signClientDecision({ chain: ctx.chain, request: data.approvalRequest, signer: ctx.signer(), decision, now: now() });
      const out = await api<IntentView>("POST", `/v1/intents/${id}/decision`, payload);
      if (decision === "REJECT") ctx.toast("Rejeitada. A proposta foi encerrada na Solana.");
      // Este aparelho acabou de aprovar a própria saída: a sessão dele morre aqui.
      if (intent.type === "ROTATE_MEMBER" && intent.role === "CLIENT" && out.status === "EXECUTED") return setHandedOver(true);
      await load();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  if (handedOver) return <HandedOver />;
  if (!data) return <Loading err={err} />;
  const { record } = data;

  if (record.status !== "AWAITING_CLIENT") return <Outcome record={record} />;
  if (!check) return <Loading err={err} label="Conferindo na Solana…" />;
  if (!check.ok) return <Blocked check={check} request={data.approvalRequest!} />;

  const intent = data.approvalRequest!.intent;
  if (intent.type === "ROTATE_MEMBER") return <RotationApproval request={data.approvalRequest!} busy={busy} err={err} onDecide={decide} />;
  if (intent.type !== "TRANSFER_SOL") return <Loading err="tipo de intenção ainda não suportado no app" />;

  const flags = record.riskFlags;
  const external = intent.destination !== intent.vault;
  return (
    <>
      <TopBar title="Confirmar transação" right={<Countdown until={intent.expiresAt} />} />
      <div className="page">
        <div className="banner ok">
          <Icon name="shieldcheck" size={18} color="var(--accent)" />
          <div className="grow">Conferido na Solana: idêntico ao que você vê.</div>
          <div className="mono" style={{ color: "#8fa36b" }}>
            #{intent.transactionIndex}
          </div>
        </div>
        <div className="center" style={{ gap: 6, padding: "14px 0 4px" }}>
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
          <Detail label="Rede" value={`Solana ${intent.cluster}`} />
          <Detail label="Taxa de rede" value="Paga pelo serviço" />
        </div>
        {flags.includes("POSSIBLE_FULL_BALANCE") && (
          <div className="banner warn">
            <Icon name="shieldalert" size={18} color="#F2B33D" />
            <div>Esta transação envia quase todo o saldo do Vault.</div>
          </div>
        )}
        {external && (
          <div className="banner warn">
            <Icon name="shieldalert" size={18} color="#F2B33D" />
            <div>Confira os últimos caracteres do endereço com quem vai receber.</div>
          </div>
        )}
        {err && <div className="banner danger">{err}</div>}
      </div>
      <div className="actions">
        <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => decide("REJECT")}>
          {busy === "REJECT" ? <span className="spinner" /> : null}Rejeitar
        </button>
        <button type="button" className="btn primary" disabled={Boolean(busy)} onClick={() => decide("APPROVE")}>
          {busy === "APPROVE" ? <span className="spinner" /> : <Icon name="finger" color="#0B0D10" sw={2} />}Aprovar
        </button>
      </div>
    </>
  );
}

function RotationApproval({ request, busy, err, onDecide }: { request: ApprovalRequest; busy: null | "APPROVE" | "REJECT"; err: string | null; onDecide: (d: "APPROVE" | "REJECT") => void }) {
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
            {isClient ? "Substituir chave de aprovação?" : "O serviço está pedindo para trocar a chave de segurança dele."}
          </div>
        </div>
        <div className="card" style={{ borderRadius: 20, padding: 16, gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 12, background: "var(--surface-2)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--subtle)" }}>
              <Icon name="key" size={18} />
            </div>
            <div className="grow">
              <div className="muted" style={{ fontSize: 12 }}>
                {isClient ? "Atual (este aparelho)" : "Chave atual do serviço"}
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
            <div style={{ width: 40, height: 40, borderRadius: 12, background: "#2a2312", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Icon name="key" size={18} color="#F2B33D" />
            </div>
            <div className="grow">
              <div className="muted" style={{ fontSize: 12 }}>
                {isClient ? "Nova" : "Nova chave do serviço"}
              </div>
              <div className="mono" style={{ fontSize: 17, fontWeight: 600 }}>
                {short(intent.newKey)}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--ok-text)" }}>
              <Icon name="check" size={14} color="#C8F169" sw={2.2} />
              posse provada
            </div>
          </div>
        </div>
        <div className="banner ok">
          <Icon name="shieldcheck" size={18} color="var(--accent)" />
          <div className="grow">Conferido na Solana: a proposta troca exatamente estas chaves, numa única transação.</div>
        </div>
        <div>
          {isClient && request.deviceName && <Detail label="Dispositivo novo" value={request.deviceName} />}
          <Detail label="Solicitado" value={when} />
          <Detail label="Quem aprova" value={isClient ? "Esta chave + serviço" : "Você + chave atual do serviço"} />
        </div>
        {isClient ? (
          <div className="banner warn">
            <Icon name="shieldalert" size={18} color="#F2B33D" />
            <div>Este aparelho perderá acesso após a conclusão. Envios ficam pausados até a troca terminar.</div>
          </div>
        ) : (
          <div className="banner danger" style={{ flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>Não reconhece este pedido? Rejeite.</div>
            <div style={{ color: "#d9a69e" }}>Sem a sua aprovação a chave do serviço não muda. Rejeitar não afeta seus fundos.</div>
          </div>
        )}
        {err && <div className="banner danger">{err}</div>}
      </div>
      <div className="actions">
        <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => onDecide("REJECT")}>
          {busy === "REJECT" ? <span className="spinner" /> : null}Rejeitar
        </button>
        <button type="button" className="btn amber" disabled={Boolean(busy)} onClick={() => onDecide("APPROVE")}>
          {busy === "APPROVE" ? <span className="spinner" /> : <Icon name="finger" color="#0B0D10" sw={2} />}
          {isClient ? "Confirmar troca" : "Aprovar"}
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
    INTENT_EXPIRED: "O prazo para aprovar acabou.",
    PROPOSAL_NOT_ACTIVE: "A proposta não está mais aberta na Solana.",
    NOT_A_VOTER: "Esta chave não é mais votante desta conta.",
    PROPOSAL_STALE: "A proposta ficou obsoleta depois de uma troca de chave.",
  };
  return (
    <>
      <div className="page" style={{ paddingTop: 56, gap: 24 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ width: 64, height: 64, borderRadius: 20, background: "#2a1413", border: "1px solid var(--danger-line)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Icon name="shieldalert" size={32} color="#FF8F80" />
          </div>
          <div style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1.15 }}>Transação bloqueada</div>
          <div style={{ fontSize: 15, color: "#b4bac4", lineHeight: 1.5 }}>{reason[check.code] ?? check.message} Nada foi assinado e seus fundos não se moveram.</div>
        </div>
        {rows.length > 0 && (
          <div style={{ borderRadius: 18, background: "#170f0f", border: "1px solid #3b2220", padding: "6px 16px 4px" }}>
            <div className="diff" style={{ borderTop: 0, fontSize: 11, color: "var(--subtle)", textTransform: "uppercase", letterSpacing: "0.1em" }}>
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
          Código: <span className="mono">{check.code}</span>. Se isso se repetir, troque a chave do serviço em Segurança.
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
  const { go, config } = useApp();
  const ok = record.status === "EXECUTED";
  const intent = record.intent;
  const rot = intent.type === "ROTATE_MEMBER";
  const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=${config.cluster === "devnet" ? "devnet" : `custom&customUrl=${encodeURIComponent("http://127.0.0.1:8899")}`}`;
  const steps: [string, string | undefined][] = [
    ["Proposta criada na Solana", record.signatures.create],
    ["Você aprovou", record.signatures.clientApprove],
    ["Serviço conferiu a política e aprovou", record.signatures.serverApprove],
    [rot ? "Chaves trocadas na Solana" : "Executada na Solana", record.signatures.execute],
  ];
  const label: Record<string, string> = { REJECTED: "Transação rejeitada", EXPIRED: "Prazo expirado", FAILED: "Falhou", AWAITING_SERVER: "Com o serviço", EXECUTING: "Executando" };
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
        {record.signatures.reject && (
          <div className="detail">
            <div>Rejeição on-chain</div>
            <div className="mono">{short(record.signatures.reject)}</div>
          </div>
        )}
      </div>
      <div className="actions">
        <button type="button" className="btn" onClick={() => go("/")}>
          Voltar ao início
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

function HandedOver() {
  const ctx = useApp();
  return (
    <>
      <div className="page" style={{ paddingTop: 56, gap: 22 }}>
        <div className="center">
          <div className="hero-ico" style={{ background: "var(--accent)" }}>
            <Icon name="check" size={44} color="#0B0D10" sw={2.4} />
          </div>
          <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em" }}>Chave trocada</div>
          <div className="muted" style={{ fontSize: 15, lineHeight: 1.5 }}>
            O aparelho novo agora aprova suas transações. A chave deste aparelho saiu da multisig na Solana e não volta a valer.
          </div>
        </div>
      </div>
      <div className="actions">
        <button
          type="button"
          className="btn"
          onClick={async () => {
            const { wipeDevice } = await import("../lib/device");
            await wipeDevice();
            await ctx.setDevice(null);
            ctx.go("/");
          }}
        >
          Apagar chave deste aparelho
        </button>
      </div>
    </>
  );
}
