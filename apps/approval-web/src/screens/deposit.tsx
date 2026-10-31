import { useCallback, useEffect, useState } from "react";
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { verifyAccountOnChain } from "@duplachave/custody/src/client";
import { errorText, useApp } from "../app";
import { qrDataUrl } from "../lib/qr";
import { parseSol, sendSigned, sol } from "../lib/chain";
import { walletWord } from "../lib/wallets";
import { Icon } from "../icons";
import { useAccount } from "./home";
import { TopBar } from "../components/TopBar";
import { tr } from "../lib/i18n";

/** Depósito: a carteira assina e paga uma transferência dela para o Vault; o app envia. */
export function Deposit() {
  const ctx = useApp();
  const { acc } = useAccount(15000);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [walletBalance, setWalletBalance] = useState<bigint | null>(null);
  const [walletBalanceErr, setWalletBalanceErr] = useState(false);
  const { chain } = ctx;
  const walletKey = ctx.session?.publicKey;
  const loadWalletBalance = useCallback(() => {
    if (!walletKey) return;
    setWalletBalanceErr(false);
    chain
      .getBalance(new PublicKey(walletKey))
      .then(setWalletBalance)
      .catch(() => setWalletBalanceErr(true));
  }, [chain, walletKey]);
  useEffect(loadWalletBalance, [loadWalletBalance]);

  const viaPhone = ctx.session?.via === "phone";
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    // Celular: QR de transferência do Solana Pay — a carteira envia direto para o Vault.
    if (!viaPhone || !acc) return;
    const amt = amount.trim().replace(",", ".");
    const params = new URLSearchParams({ label: "Double Check", message: tr("Depósito no seu Vault", "Deposit to your Vault") });
    if (/^\d+(\.\d{1,9})?$/.test(amt)) params.set("amount", amt);
    void qrDataUrl(`solana:${acc.account.vault}?${params.toString()}`).then(setQr);
  }, [viaPhone, acc, amount]);

  const submit = async () => {
    if (!acc) return;
    setBusy(true);
    setErr(null);
    try {
      const lamports = parseSol(amount);
      if (!lamports) throw new Error(tr("Use um número maior que zero, com até 9 casas decimais (por exemplo 0,5).", "Enter a number greater than zero, with up to 9 decimal places (for example 0.5)."));
      const c = await ctx.accountWallet();
      // O Vault de destino é conferido na chain: esta carteira vota na multisig, não um endereço que o servidor disse.
      const vault = await verifyAccountOnChain(ctx.chain, acc.account.multisig, new PublicKey(c.publicKey));
      if (vault !== acc.account.vault) throw new Error(tr("o Vault informado não é o desta conta", "the Vault given is not this account's Vault"));
      // O blockhash vale ~1 minuto: só é pedido depois de a carteira já estar conectada,
      // para que o tempo que a pessoa leva para abrir a carteira não conte contra ele.
      const recentBlockhash = await ctx.chain.getLatestBlockhash();
      const msg = new TransactionMessage({
        payerKey: new PublicKey(c.publicKey),
        recentBlockhash,
        instructions: [SystemProgram.transfer({ fromPubkey: new PublicKey(c.publicKey), toPubkey: new PublicKey(acc.account.vault), lamports })],
      }).compileToV0Message();
      const signed = await c.signTransaction(new VersionedTransaction(msg));
      await sendSigned(signed);
      ctx.toast(tr(`${sol(lamports, 9)} SOL depositados no Vault`, `${sol(lamports, 9)} SOL deposited to the Vault`));
      ctx.go("/");
    } catch (e) {
      // A pessoa demorou na carteira e o blockhash venceu: a RPC responde com texto cru.
      const raw = (e as Error)?.message ?? String(e);
      if (/Blockhash ?not ?found|block height exceeded/i.test(raw))
        setErr(tr("A transação venceu enquanto esperava a assinatura na carteira (ela vale cerca de 1 minuto). Nada saiu da sua carteira; assine de novo.", "The transaction expired while waiting for the wallet signature (it lasts about 1 minute). Nothing left your wallet; sign again."));
      else setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <TopBar title={tr("Depositar no Vault", "Deposit to Vault")} />
      {/* Enter no campo envia; `display: contents` mantém page e actions como filhos diretos do .app (a barra continua sticky). */}
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          // Pelo celular o depósito é pelo QR: não há o que enviar daqui.
          if (!viaPhone && !busy && amount) void submit();
        }}
      >
      <div className="page">
        <div className="lead">
          {tr(
            `Sai da sua ${walletWord(ctx.session!.walletName)} para o Vault da conta, com a taxa (~0,000005 SOL) paga por ela. Depositar não precisa da aprovação do serviço; sacar, sim.`,
            `Moves from your ${walletWord(ctx.session!.walletName)} to the account's Vault; it pays the fee (~0.000005 SOL). Deposits don't need the service's approval; withdrawals do.`,
          )}
        </div>
        <div className="card" style={{ gap: 6 }}>
          <div className="muted" style={{ fontSize: 12 }}>
            {tr("Na sua carteira", "In your wallet")}
          </div>
          <div className="big" style={{ fontSize: 24 }}>
            {walletBalance === null ? "—" : sol(walletBalance)} SOL
          </div>
          {walletBalance === null && walletBalanceErr && (
            <div className="subtle" style={{ fontSize: 13 }}>
              {tr("Não deu para ler o saldo.", "Couldn't read the balance.")}{" "}
              <button type="button" className="linkbtn small" onClick={loadWalletBalance}>
                {tr("Tentar de novo", "Try again")}
              </button>
            </div>
          )}
        </div>
        <div className="field">
          <label htmlFor="amt">{tr("Quantidade (SOL)", "Amount (SOL)")}</label>
          <input id="amt" className="input mono" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={tr("1,5", "1.5")} />
        </div>
        {acc && (
          <div className="card" style={{ gap: 8 }}>
            <div className="row-between">
              <div className="muted" style={{ fontSize: 12 }}>
                {tr("Ou envie de qualquer carteira para o endereço do Vault", "Or send from any wallet to the Vault address")}
              </div>
              <button
                type="button"
                className="linkbtn small"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(acc.account.vault);
                    ctx.toast(tr("Endereço do Vault copiado", "Vault address copied"));
                  } catch {
                    ctx.toast(tr("Não deu para copiar; selecione o endereço.", "Couldn't copy; select the address."));
                  }
                }}
              >
                {tr("Copiar", "Copy")}
              </button>
            </div>
            <div className="mono" style={{ fontSize: 13, wordBreak: "break-all", lineHeight: 1.5 }}>
              {acc.account.vault}
            </div>
          </div>
        )}
        {viaPhone && qr && (
          <div className="card qr-box">
            <img className="qr" src={qr} alt={tr("QR de depósito", "Deposit QR code")} />
            <div className="muted" style={{ fontSize: 13, textAlign: "center" }}>
              {tr("Escaneie com a carteira do celular. O saldo do Vault atualiza sozinho quando chegar.", "Scan with your phone wallet. The Vault balance updates on its own when it arrives.")}
            </div>
          </div>
        )}
        {err && <div className="banner danger">{err}</div>}
      </div>
      <div className="actions" style={viaPhone ? { display: "none" } : undefined}>
        <button type="submit" className="btn primary" disabled={busy || !amount} aria-busy={busy}>
          {busy ? <span className="spinner" /> : <Icon name="key" color="#0B0D10" sw={2} />} {walletWord(ctx.session!.walletName).length <= 12 ? tr(`Assinar na ${walletWord(ctx.session!.walletName)}`, `Sign with ${walletWord(ctx.session!.walletName)}`) : tr("Assinar na carteira", "Sign with wallet")}
        </button>
      </div>
      </form>
    </>
  );
}
