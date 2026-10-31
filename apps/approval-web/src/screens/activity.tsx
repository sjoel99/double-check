import { useCallback, useEffect, useState } from "react";
import { useApp } from "../app";
import { api } from "../lib/api";
import { IntentRow, Tabs, useAccount } from "./home";
import { TopBar } from "../components/TopBar";
import { fmtWhen, tr } from "../lib/i18n";

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
  const [audit, setAudit] = useState<{ seq: number; type: string; at: number; hash: string }[] | null>(null);
  const [auditErr, setAuditErr] = useState(false);
  /** Quantos eventos do histórico aparecem; "Mostrar mais" soma 30. */
  const [shown, setShown] = useState(30);
  const accountId = ctx.session?.accountId;
  const intentCount = intents.length;
  const loadAudit = useCallback(() => {
    if (!accountId) return;
    setAuditErr(false);
    void api("GET", `/v1/accounts/${accountId}/audit`)
      .then((r) => setAudit(r.events.slice().reverse()))
      .catch(() => setAuditErr(true));
  }, [accountId]);
  // Recarrega também quando a lista de transações muda.
  useEffect(loadAudit, [loadAudit, intentCount]);
  return (
    <>
      <TopBar title={tr("Atividade", "Activity")} back={null} />
      <div className="page">
        <div>
          {!intentsLoaded && !err && (
            <div role="status" aria-label={tr("Carregando", "Loading")}>
              <span className="spinner" />
            </div>
          )}
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
          {audit === null && !auditErr && <span className="spinner" />}
          {audit === null && auditErr && (
            <div className="subtle" style={{ fontSize: 13 }}>
              {tr("Não deu para carregar o histórico.", "Couldn't load the history.")}{" "}
              <button type="button" className="linkbtn small" onClick={loadAudit}>
                {tr("Tentar de novo", "Try again")}
              </button>
            </div>
          )}
          {(audit ?? []).slice(0, shown).map((e) => (
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
          {audit && audit.length > shown && (
            <button type="button" className="btn small" style={{ width: "100%", marginTop: 10 }} onClick={() => setShown((n) => n + 30)}>
              {tr(`Mostrar mais (${audit.length - shown})`, `Show more (${audit.length - shown})`)}
            </button>
          )}
        </div>
        {err && <div className="err">{err}</div>}
      </div>
      <Tabs />
    </>
  );
}
