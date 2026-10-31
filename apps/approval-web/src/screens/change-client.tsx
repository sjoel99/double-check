import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import type { ChangeView } from "../hooks/useChanges";
import { reviewSecurityRequest, verifyAuthorized, type SecurityChangeDesc } from "@duplachave/custody/src/client";
import { accountKeyBlobs, errorText, unlockAccountKey, useApp } from "../app";
import { api } from "../lib/api";
import { accountInfo } from "../lib/account";
import { short } from "../lib/chain";
import { type StandardWallet, walletDisplay } from "../lib/wallets";
import { signatureB58 } from "../lib/webappKey";
import { Icon } from "../icons";
import { WalletList } from "./welcome";
import { TopBar } from "../components/TopBar";
import { fmtWhen, tr, trn } from "../lib/i18n";

/**
 * Trocar a carteira (perdeu, vazou, ou quer outra). A chave do webapp (biometria)
 * e o serviço votam o pedido; a carteira NOVA paga e prova que é sua assinando.
 * Executa em 72 h, se a carteira atual não vetar.
 */
export function ChangeClient() {
  const ctx = useApp();
  const s = ctx.session!;
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<ChangeView | null>(null);

  const pick = async (w: StandardWallet) => {
    setErr(null);
    try {
      setBusy(tr(`Conectando à ${walletDisplay(w.name)}…`, `Connecting to ${walletDisplay(w.name)}…`));
      const next = await ctx.connect(w);
      if (next.publicKey === s.publicKey) throw new Error(tr("Essa é a carteira atual da conta. Na carteira, mude para a conta nova (ou use outra carteira).", "That's the account's current wallet. In the wallet, switch to the new account (or use another wallet)."));
      const info = await accountInfo(s.accountId);
      setBusy(tr("Preparando o pedido…", "Preparing the request…"));
      const r = await api<{ change: ChangeView; desc: SecurityChangeDesc; transaction: string }>("POST", `/v1/accounts/${s.accountId}/security-changes`, { role: "CLIENT", newKey: next.publicKey });
      const review = await reviewSecurityRequest(ctx.chain, r.desc, r.transaction, { client: new PublicKey(info.client), webapp: new PublicKey(info.webapp) });
      setBusy(tr("Confirme com a biometria (a chave do webapp vota o pedido)…", "Confirm with biometrics (the webapp key votes on the request)…"));
      const key = await unlockAccountKey(ctx, await accountKeyBlobs(`/v1/accounts/${s.accountId}/webapp-keys`), tr(`Trocar a carteira por ${short(next.publicKey)} (executa em 72 h)`, `Replace the wallet with ${short(next.publicKey)} (runs in 72 h)`));
      let webappSignature: string;
      try {
        webappSignature = signatureB58(key.sign(review.message));
      } finally {
        key.wipe();
      }
      const auth = await api<{ transaction: string }>("POST", `/v1/security-changes/${r.change.id}/authorize`, { message: Buffer.from(review.message).toString("base64"), webappSignature });
      const tx = verifyAuthorized(review, auth.transaction, [review.roles.operator, review.roles.webapp, review.roles.server]);
      setBusy(tr(`Confirme na ${next.name} (a carteira nova paga ~0,006 SOL, que voltam na conclusão)…`, `Confirm in ${walletDisplay(next.name)} (the new wallet pays ~0.006 SOL, returned when the change completes)…`));
      const signed = await next.signTransaction(tx);
      setDone(await api<ChangeView>("POST", `/v1/security-changes/${r.change.id}/submit`, { transaction: signed }));
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <TopBar title={tr("Trocar a carteira", "Replace the wallet")} back="/security" />
      <div className="page">
        {done ? (
          <div className="banner ok">
            <Icon name="check" size={18} color="var(--accent)" />
            {trn(
              <div>
                Pedido feito. A carteira nova passa a valer em <b>{fmtWhen(done.executeAfter!)}</b>, se a atual não vetar. Depois disso, toque em "Concluir troca" em Segurança.
              </div>,
              <div>
                Request made. The new wallet takes effect on <b>{fmtWhen(done.executeAfter!)}</b>, unless the current one vetoes. After that, tap "Complete change" in Security.
              </div>,
            )}
          </div>
        ) : (
          <>
            {trn(
              <div className="lead">
                A chave do webapp (com a sua biometria) e o serviço aprovam o pedido. A carteira nova paga a taxa e o depósito das contas (~0,006 SOL, que voltam). A troca só executa em <b>72 h</b>: se alguém pedir no seu lugar, a carteira atual veta.
              </div>,
              <div className="lead">
                The webapp key (with your biometrics) and the service approve the request. The new wallet pays the fee and the account deposit (~0.006 SOL, returned). The change only runs after <b>72 h</b>: if someone else asks in your place, the current wallet vetoes it.
              </div>,
            )}
            <div className="section-title">{tr("Conecte a carteira NOVA", "Connect the NEW wallet")}</div>
            <WalletList onPick={pick} busy={Boolean(busy)} exclude={s.walletName} />
          </>
        )}
        {busy && (
          <div className="status">
            <span className="spinner" /> {busy}
          </div>
        )}
        {err && <div className="banner danger">{err}</div>}
      </div>
    </>
  );
}
