import type { ReactNode } from "react";
import type { ApprovalRequest } from "@duplachave/custody/src/client";
import { useApp } from "../../app";
import { NO_WALLET, walletDisplay } from "../../lib/wallets";
import { short } from "../../lib/chain";
import { Icon } from "../../icons";
import { Countdown } from "../../components/Countdown";
import { Detail } from "../../components/Detail";
import { TopBar } from "../../components/TopBar";
import { fmtWhen, tr, trn } from "../../lib/i18n";

/** Troca de chave (carteira ou chave do serviço) à espera da assinatura. */
export function RotationApproval({ request, header, actions, err }: { request: ApprovalRequest; header: ReactNode; actions: ReactNode; err: string | null }) {
  const { session } = useApp();
  const intent = request.intent;
  if (intent.type !== "ROTATE_MEMBER") return null;
  const isClient = intent.role === "CLIENT";
  const currentWallet = session?.walletName && session.walletName !== NO_WALLET ? walletDisplay(session.walletName) : null;
  return (
    <>
      <TopBar title={tr("Segurança", "Security")} right={<Countdown until={intent.expiresAt} />} />
      <div className="page">
        <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 4 }}>
          <div className="eyebrow warn">
            <Icon name="shieldalert" size={16} color="#F2B33D" /> {tr("Alteração de segurança", "Security change")}
          </div>
          <div className="h1">
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
              {trn(
                <>
                  Assine com a carteira <b>atual</b> (<span className="mono">{short(intent.oldKey)}</span>). Ela paga a taxa e, na mesma transação, perde o acesso; a nova passa a assinar.
                </>,
                <>
                  Sign with the <b>current</b> wallet (<span className="mono">{short(intent.oldKey)}</span>). It pays the fee and, in the same transaction, loses access; the new one becomes the signer.
                </>,
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
