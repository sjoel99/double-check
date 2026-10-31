import type { ApprovalRequest, Inspection } from "@duplachave/custody/src/client";
import { useApp } from "../../app";
import { short, sol } from "../../lib/chain";
import { Icon } from "../../icons";
import { errorMessage } from "../../lib/errors";
import { tr } from "../../lib/i18n";

/** A conferência local falhou: o que foi mostrado × o que a transação recebida faria. Nada é assinado. */
export function Blocked({ check, request }: { check: Extract<Inspection, { ok: false }>; request: ApprovalRequest }) {
  const { go } = useApp();
  const intent = request.intent;
  // O que a transação recebida faria de verdade (decodificada aqui, não dita pelo servidor).
  const op = check.actual?.length === 1 && check.actual[0]!.kind === "SYSTEM_TRANSFER" ? check.actual[0]! : null;
  const rows: [string, string, string][] = [];
  if (intent.type === "TRANSFER_SOL" && op?.kind === "SYSTEM_TRANSFER") {
    if (intent.amountLamports !== op.lamports.toString()) rows.push([tr("Valor", "Amount"), `${sol(intent.amountLamports, 9)} SOL`, `${sol(op.lamports, 9)} SOL`]);
    if (intent.destination !== op.to) rows.push([tr("Destino", "Destination"), short(intent.destination), short(op.to)]);
  }
  // O motivo vem do código e dos parâmetros da conferência (client.ts), no idioma do app.
  const reason = errorMessage(check.code, check.params, check.message);
  return (
    <>
      <div className="page" style={{ paddingTop: 56, gap: 24 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="danger-ico">
            <Icon name="shieldalert" size={32} color="#FF8F80" />
          </div>
          <div className="h1" style={{ fontSize: 28, lineHeight: 1.15 }}>{tr("Transação bloqueada", "Transaction blocked")}</div>
          <div role="alert" style={{ fontSize: 15, color: "#b4bac4", lineHeight: 1.5 }}>{reason} {tr("Nada foi assinado e seus fundos não se moveram.", "Nothing was signed and your funds did not move.")}</div>
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
