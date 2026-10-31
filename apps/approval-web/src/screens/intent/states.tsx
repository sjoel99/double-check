import { useApp } from "../../app";
import { Icon } from "../../icons";
import { TopBar } from "../../components/TopBar";
import { tr } from "../../lib/i18n";

/** Estados auxiliares da tela de confirmação: preparar falhou, carteira trocada, carregando. */
export function PrepareFailed({ message, busy, onRetry, retryLabel, onReject }: { message: string; busy: null | string; onRetry: () => void; retryLabel: string; onReject?: () => void }) {
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

export function HandedOver() {
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

export function Loading({ err, label = tr("Carregando…", "Loading…") }: { err: string | null; label?: string }) {
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
