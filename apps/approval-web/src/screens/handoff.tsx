import { useEffect, useState } from "react";
import { errorText, loginOrEnroll, useApp } from "../app";
import { api } from "../lib/api";
import type { StandardWallet } from "../lib/wallets";
import { Icon, Logo } from "../icons";
import { IosNotice, WalletList } from "./welcome";
import { isIOS } from "../lib/activation";
import { IntentScreen } from "./intent";

type Info = { kind: "CONNECT" | "SIGN_INTENT"; label: string; intentId: string | null; accountId: string | null; wallet: string | null };

/**
 * O que o QR do computador abre no celular. Aqui (e não na carteira direto) a
 * transação é conferida e a biometria confirmada; só então a carteira assina.
 */
export function MobileHandoff({ token }: { token: string }) {
  const ctx = useApp();
  const [info, setInfo] = useState<Info | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [login, setLogin] = useState(false);

  useEffect(() => {
    api<Info>("GET", `/v1/handoff/${token}`, undefined, { auth: false })
      .then((i) => {
        setInfo(i);
        // Já entrou com a carteira desta conta neste celular: vai direto para a conferência.
        if (i.kind === "SIGN_INTENT" && ctx.session?.accountId === i.accountId) ctx.go(`/intent/${i.intentId}`);
      })
      .catch((e) => setErr(errorText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const pick = async (w: StandardWallet) => {
    if (!info) return;
    setErr(null);
    try {
      setStep(`Conectando à ${w.name}…`);
      const c = await ctx.connect(w);
      const s = await loginOrEnroll(ctx, c, setStep);
      if (info.kind === "SIGN_INTENT") {
        if (s.accountId !== info.accountId) throw new Error("Esta carteira não é a da conta que pediu a assinatura. Troque de conta na carteira e tente de novo.");
        return ctx.go(`/intent/${info.intentId}`);
      }
      await api("POST", `/v1/handoff/${token}/claim`, { accountId: s.accountId });
      setDone("Pronto. O computador entrou na sua conta.");
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setStep(null);
    }
  };

  // Assinar pelo QR, sem entrar na conta: uma abertura só da Phantom (conecta e assina juntos).
  const mwa = ctx.wallets.some((w) => w.name === "Mobile Wallet Adapter");
  if (info?.kind === "SIGN_INTENT" && info.wallet && mwa && !login && ctx.session?.accountId !== info.accountId)
    return (
      <>
        <IntentScreen id={info.intentId!} handoff={{ token, wallet: info.wallet }} />
        <div style={{ display: "flex", justifyContent: "center", padding: "0 16px 16px" }}>
          <button type="button" className="linkbtn" onClick={() => setLogin(true)}>
            Biometria não ativa neste celular? Entrar e ativar
          </button>
        </div>
      </>
    );

  const title =
    info?.kind === "SIGN_INTENT" ? "Entre com a carteira da conta" : "Entre com a sua carteira";
  return (
    <div className="page" style={{ paddingTop: 36, gap: 20 }}>
      <Logo size={44} />
      {info && (
        <div className="card" style={{ gap: 6 }}>
          <div className="muted" style={{ fontSize: 12 }}>
            Pedido do computador
          </div>
          <div style={{ fontSize: 18, fontWeight: 600, lineHeight: 1.3 }}>{info.label}</div>
        </div>
      )}
      {done ? (
        <div className="center" style={{ padding: "16px 0", gap: 12 }}>
          <div className="dot" style={{ background: "var(--accent)", width: 48, height: 48 }}>
            <Icon name="check" size={26} color="#0B0D10" sw={2.6} />
          </div>
          <div style={{ fontSize: 16, lineHeight: 1.5, textAlign: "center" }}>{done}</div>
        </div>
      ) : info && isIOS() ? (
        <IosNotice />
      ) : (
        info && (
          <>
            <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>{title}</div>
            <div className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
              O webapp confere a transação aqui no celular e pede a sua biometria antes de abrir a carteira.
            </div>
            <WalletList onPick={pick} busy={Boolean(step)} />
          </>
        )
      )}
      {step && (
        <div className="status">
          <span className="spinner" /> {step}
        </div>
      )}
      {err && <div className="banner danger">{err}</div>}
    </div>
  );
}
