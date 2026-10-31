import { useState } from "react";
import { PublicKey, type VersionedTransaction as VTx } from "@solana/web3.js";
import { reviewSecurityRequest, verifyAuthorized } from "@duplachave/custody/src/client";
import { errorText, useApp } from "../app";
import { api } from "../lib/api";
import { Icon } from "../icons";
import { tr } from "../lib/i18n";

/** Ferramentas de teste (só localnet): airdrops, pedido de troca da chave do serviço, servidor malicioso. Carregado sob demanda. */
export function DevTools({ vault, accountId, reload }: { vault: string; accountId: string; reload: () => Promise<void> }) {
  const ctx = useApp();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      await reload();
    } catch (e) {
      ctx.toast(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dev">
      <div className="title">{tr("Ferramentas de teste (localnet)", "Test tools (localnet)")}</div>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="btn small" style={{ flex: 1 }} disabled={busy} aria-busy={busy} onClick={() => run(async () => { await api("POST", "/v1/dev/airdrop", { address: vault, sol: 10 }); ctx.toast(tr("10 SOL de teste no Vault", "10 test SOL in the Vault")); })}>
          <Icon name="drop" size={16} /> {tr("10 SOL no Vault", "10 SOL to Vault")}
        </button>
        <button type="button" className="btn small" style={{ flex: 1 }} disabled={busy} aria-busy={busy} onClick={() => run(async () => { await api("POST", "/v1/dev/airdrop", { address: ctx.session!.publicKey, sol: 5 }); ctx.toast(tr("5 SOL de teste na sua carteira", "5 test SOL in your wallet")); })}>
          <Icon name="drop" size={16} /> {tr("5 SOL na carteira", "5 SOL to wallet")}
        </button>
      </div>
      <button
        type="button"
        className="btn small"
        disabled={busy}
        aria-busy={busy}
        onClick={() =>
          run(async () => {
            // Pedido de troca da chave do serviço: a carteira vota e paga; executa depois do prazo.
            const r = await api("POST", `/v1/dev/accounts/${accountId}/security-changes/server`, {});
            const sec = await api("GET", `/v1/accounts/${accountId}/security`);
            const review = await reviewSecurityRequest(ctx.chain, r.desc, r.transaction, { client: new PublicKey(sec.account.roles.client), webapp: new PublicKey(sec.account.roles.webapp) });
            const auth = await api("POST", `/v1/security-changes/${r.change.id}/authorize`, { message: Buffer.from(review.message).toString("base64") });
            const tx: VTx = verifyAuthorized(review, auth.transaction, [review.roles.operator, review.roles.server, new PublicKey(r.desc.newKey)]);
            const w = await ctx.accountWallet();
            await api("POST", `/v1/security-changes/${r.change.id}/submit`, { transaction: await w.signTransaction(tx) });
            ctx.toast(tr("Pedido feito: executa depois do prazo, em Segurança.", "Request made: complete it after the wait, in Security."));
            ctx.go("/security");
          })
        }
      >
        <Icon name="server" size={16} /> {tr("Simular pedido de troca da chave do serviço", "Simulate a service key change request")}
      </button>
      <label className="toggle">
        <input type="checkbox" checked={ctx.dev.malicious} onChange={(e) => ctx.dev.setMalicious(e.target.checked)} />
        {tr("Simular servidor malicioso (mostra 1/10 do valor real)", "Simulate a malicious server (shows 1/10 of the real amount)")}
      </label>
    </div>
  );
}

