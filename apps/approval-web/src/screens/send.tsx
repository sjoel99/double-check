import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { errorText, useApp } from "../app";
import { api } from "../lib/api";
import { walletWord } from "../lib/wallets";
import { parseSol, sol, solInput } from "../lib/chain";
import { useAccount } from "./home";
import { TopBar } from "../components/TopBar";
import { tr } from "../lib/i18n";

/** Enviar SOL: destino + valor; o serviço confere a política e devolve a intenção para revisar. */
export function Send() {
  const ctx = useApp();
  // "Criar de novo" (envio que expirou) chega com destino e valor na rota.
  const q = new URLSearchParams(ctx.route.split("?")[1] ?? "");
  const [dest, setDest] = useState(q.get("to") ?? "");
  const [amount, setAmount] = useState(q.get("amount") ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { acc, balance } = useAccount(15000);
  const limit = acc?.limits ? BigInt(acc.limits.maxLamportsPerTx) : null;
  const max = balance === null ? null : limit !== null && limit < balance ? limit : balance;

  const destErr = (() => {
    if (!dest.trim()) return null;
    try {
      new PublicKey(dest.trim());
    } catch {
      return tr("Endereço Solana inválido. Confira se copiou inteiro.", "Invalid Solana address. Check that you copied all of it.");
    }
    if (acc && dest.trim() === acc.account.vault) return tr("Esse é o próprio Vault da conta.", "That is the account's own Vault.");
    return null;
  })();
  const lamports = parseSol(amount);
  const amountErr = (() => {
    if (!amount.trim()) return null;
    if (lamports === null) return tr("Use um número com até 9 casas decimais, por exemplo 0,5.", "Use a number with up to 9 decimal places, for example 0.5.");
    if (lamports === 0n) return tr("O valor precisa ser maior que zero.", "The amount must be greater than zero.");
    if (limit !== null && lamports > limit) return tr(`Acima do limite de ${sol(limit, 9)} SOL por envio.`, `Above the limit of ${sol(limit, 9)} SOL per transfer.`);
    if (balance !== null && lamports > balance) return tr(`Maior que o saldo do Vault (${sol(balance, 9)} SOL).`, `More than the Vault balance (${sol(balance, 9)} SOL).`);
    return null;
  })();
  const valid = Boolean(dest.trim() && lamports && !destErr && !amountErr);

  const paste = async () => {
    try {
      const t = (await navigator.clipboard.readText()).trim();
      if (t) setDest(t);
    } catch {
      ctx.toast(tr("O navegador não deixou ler a área de transferência. Cole no campo.", "The browser didn't allow reading the clipboard. Paste into the field."));
    }
  };

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api("POST", `/v1/accounts/${ctx.session!.accountId}/intents`, { type: "TRANSFER_SOL", destination: dest.trim(), amountSol: amount.trim() });
      ctx.go(`/intent/${r.intent.id}`);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <TopBar title={tr("Enviar SOL", "Send SOL")} />
      {/* Um <form>: o Enter no teclado (e o "ir" do celular) revisa, como o botão. */}
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !busy) void submit();
        }}
      >
      <div className="page">
        <div className="lead">
          {tr(
            `O serviço confere a sua política. Depois você revisa, confirma com a biometria e assina uma vez na ${walletWord(ctx.session!.walletName)}, que paga a taxa da rede (~0,000015 SOL).`,
            `The service checks your policy. Then you review, confirm with biometrics and sign once in ${walletWord(ctx.session!.walletName)}, which pays the network fee (~0.000015 SOL).`,
          )}
        </div>
        <div className="field">
          <div className="row-between">
            <label htmlFor="dest">{tr("Endereço de destino", "Destination address")}</label>
            <button type="button" className="linkbtn small" onClick={paste}>
              {tr("Colar", "Paste")}
            </button>
          </div>
          <input id="dest" className="input mono" value={dest} onChange={(e) => setDest(e.target.value)} placeholder={tr("Endereço Solana", "Solana address")} spellCheck={false} autoComplete="off" autoCapitalize="none" autoCorrect="off" inputMode="text" enterKeyHint="next" aria-invalid={Boolean(destErr)} aria-describedby={destErr ? "dest-err" : undefined} />
          {destErr && <div className="err" id="dest-err">{destErr}</div>}
        </div>
        <div className="field">
          <div className="row-between">
            <label htmlFor="amt">{tr("Quantidade (SOL)", "Amount (SOL)")}</label>
            <button type="button" className="linkbtn small" disabled={!max} onClick={() => max && setAmount(solInput(max))}>
              {tr("Máx", "Max")}
            </button>
          </div>
          <input id="amt" className="input mono" inputMode="decimal" autoComplete="off" enterKeyHint="done" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={tr("0,5", "0.5")} aria-invalid={Boolean(amountErr)} aria-describedby={amountErr ? "amt-err" : undefined} />
          {amountErr ? (
            <div className="err" id="amt-err">{amountErr}</div>
          ) : (
            <div className="subtle" style={{ fontSize: 12 }}>
              {tr("Saldo do Vault", "Vault balance")}: {balance === null ? "…" : `${sol(balance, 9)} SOL`}
              {limit !== null && tr(` · limite por envio: ${sol(limit, 9)} SOL`, ` · limit per transfer: ${sol(limit, 9)} SOL`)}
            </div>
          )}
        </div>
        {err && <div className="banner danger">{err}</div>}
      </div>
      <div className="actions">
        <button type="submit" className="btn primary" disabled={!valid || busy} aria-busy={busy}>
          {busy ? <span className="spinner" /> : null} {tr("Revisar", "Review")}
        </button>
      </div>
      </form>
    </>
  );
}
