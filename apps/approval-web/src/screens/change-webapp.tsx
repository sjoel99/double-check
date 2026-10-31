import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import type { ChangeView } from "../hooks/useChanges";
import { reviewSecurityRequest, verifyAuthorized, type SecurityChangeDesc } from "@duplachave/custody/src/client";
import { errorText, useApp } from "../app";
import { api } from "../lib/api";
import { accountInfo } from "../lib/account";
import { walletDisplay } from "../lib/wallets";
import { createWebappKey, deviceName } from "../lib/webappKey";
import { Icon } from "../icons";
import { TopBar } from "../components/TopBar";
import { fmtWhen, tr, trn } from "../lib/i18n";

/**
 * Recuperar o webapp neste aparelho (perdeu o aparelho ou trocou de celular):
 * uma chave nova do webapp nasce aqui, cifrada pela biometria deste aparelho;
 * a carteira e o serviço votam o pedido; executa em 72 h, se a chave antiga não vetar.
 */
export function ChangeWebapp() {
  const ctx = useApp();
  const s = ctx.session!;
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<ChangeView | null>(null);

  const run = async () => {
    setErr(null);
    try {
      const w = await ctx.accountWallet();
      const info = await accountInfo(s.accountId);
      setBusy(tr("Confirme a biometria deste aparelho (ela protege a chave nova)…", "Confirm biometrics on this device (it protects the new key)…"));
      const key = await createWebappKey({ devTools: ctx.config.devTools, confirm: ctx.biometric, what: tr("Criar a chave nova do webapp", "Create the new webapp key") });
      try {
        setBusy(tr("Preparando o pedido…", "Preparing the request…"));
        const r = await api<{ change: ChangeView; desc: SecurityChangeDesc; transaction: string }>("POST", `/v1/accounts/${s.accountId}/security-changes`, {
          role: "WEBAPP",
          newKey: key.publicKey.toBase58(),
          newKeyBlob: { ...key.blob, deviceName: deviceName() },
        });
        const review = await reviewSecurityRequest(ctx.chain, r.desc, r.transaction, { client: new PublicKey(info.client), webapp: new PublicKey(info.webapp) });
        const auth = await api<{ transaction: string }>("POST", `/v1/security-changes/${r.change.id}/authorize`, { message: Buffer.from(review.message).toString("base64") });
        const tx = verifyAuthorized(review, auth.transaction, [review.roles.operator, review.roles.server]);
        tx.addSignature(key.publicKey, key.sign(tx.message.serialize())); // a chave nova prova que existe (memo)
        setBusy(tr(`Confirme na ${w.name} (ela vota e paga)…`, `Confirm in ${walletDisplay(w.name)} (it votes and pays)…`));
        const signed = await w.signTransaction(tx);
        setDone(await api<ChangeView>("POST", `/v1/security-changes/${r.change.id}/submit`, { transaction: signed }));
      } finally {
        key.wipe();
      }
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <TopBar title={tr("Recuperar o webapp", "Recover the webapp")} back="/security" />
      <div className="page">
        {done ? (
          <div className="banner ok">
            <Icon name="check" size={18} color="var(--accent)" />
            {trn(
              <div>
                Pedido feito. A chave nova (neste aparelho) passa a valer em <b>{fmtWhen(done.executeAfter!)}</b>, se a antiga não vetar. Depois, toque em "Concluir troca" em Segurança.
              </div>,
              <div>
                Request made. The new key (on this device) takes effect on <b>{fmtWhen(done.executeAfter!)}</b>, unless the old one vetoes. Then tap "Complete change" in Security.
              </div>,
            )}
          </div>
        ) : (
          <>
            {trn(
              <div className="lead">
                Use quando perder o aparelho com a chave do webapp. Uma chave nova nasce aqui, protegida pela sua biometria. A sua carteira e o serviço aprovam; a troca só executa em <b>72 h</b>. Se alguém com a sua carteira tentar isso, a chave atual do webapp veta.
              </div>,
              <div className="lead">
                Use this if you lose the device with the webapp key. A new key is created here, protected by your biometrics. Your wallet and the service approve; the change only runs after <b>72 h</b>. If someone with your wallet tries this, the current webapp key vetoes it.
              </div>,
            )}
            <button type="button" className="btn primary" disabled={Boolean(busy)} aria-busy={Boolean(busy)} onClick={run}>
              <Icon name="finger" color="#0B0D10" sw={2} /> {tr("Criar a chave nova aqui e pedir a troca", "Create the new key here and request the change")}
            </button>
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
