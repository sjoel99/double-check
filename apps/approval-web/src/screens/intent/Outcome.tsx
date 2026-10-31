import { useApp } from "../../app";
import { walletWord } from "../../lib/wallets";
import { short, sol } from "../../lib/chain";
import { Icon } from "../../icons";
import type { IntentView } from "../home";
import { tr } from "../../lib/i18n";

/** Resultado final de um envio ou de uma troca: executado, cancelado, expirado ou com falha. */
export function Outcome({ record, onAgain }: { record: IntentView; onAgain: () => void }) {
  const { go, config, session } = useApp();
  const ok = record.status === "EXECUTED";
  const intent = record.intent;
  const rot = intent.type === "ROTATE_MEMBER";
  // Explorer por cluster: devnet e mainnet têm parâmetro próprio; localnet aponta para o validador local.
  const explorer = (sig: string) => {
    const c = config.cluster as string;
    const q = c === "devnet" ? "?cluster=devnet" : c === "mainnet" || c === "mainnet-beta" ? "" : `?cluster=custom&customUrl=${encodeURIComponent("http://127.0.0.1:8899")}`;
    return `https://explorer.solana.com/tx/${sig}${q}`;
  };
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
          <div className="h1">{ok ? (rot ? tr("Chave trocada", "Key changed") : tr("Envio executado", "Transfer executed")) : title[record.status] ?? record.status}</div>
          <div className="muted" style={{ fontSize: 15 }}>
            {rot ? (
              <>
                <span className="mono">{short(intent.oldKey)}</span> → <span className="mono" style={{ color: "var(--text)" }}>{short(intent.newKey)}</span>
              </>
            ) : (
              <>
                <span className="mono" style={{ color: "var(--text)" }}>{sol(intent.type === "TRANSFER_SOL" ? intent.amountLamports : "0", 9)} SOL</span> {tr("para", "to")} <span className="mono">{short(intent.destination)}</span>
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
