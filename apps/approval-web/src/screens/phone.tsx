import { useEffect, useState } from "react";
import { Connection, VersionedTransaction } from "@solana/web3.js";
import { errorText } from "../app";
import { devWalletPublicKey, devWalletSign } from "../lib/devwallet";
import { short } from "../lib/chain";
import { Icon } from "../icons";

/**
 * Celular de teste (só localnet): faz o que a Phantom do celular faz com um QR
 * do Solana Pay — GET (rótulo), POST { account }, mostra a mensagem, assina a
 * transação (paga por ela; o serviço já assinou a parte dele) e a envia para a rede.
 */
const WALLETS = ["Carteira de teste A", "Carteira de teste B"];

type Fetched = { label: string; icon: string };
type Built = { transaction: string; message: string };

export function PhoneSimulator({ url }: { url: string }) {
  const [wallet, setWallet] = useState<string | null>(null);
  const [meta, setMeta] = useState<Fetched | null>(null);
  const [built, setBuilt] = useState<Built | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "sent">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [sig, setSig] = useState<string | null>(null);

  useEffect(() => {
    fetch(url)
      .then((r) => r.json())
      .then((j) => (j.label ? setMeta(j) : setErr(j.message ?? "QR inválido")))
      .catch((e) => setErr(String(e)));
  }, [url]);

  const choose = async (name: string) => {
    setWallet(name);
    setErr(null);
    setState("loading");
    try {
      const account = (await devWalletPublicKey(name)).toBase58();
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message ?? j.error ?? r.statusText);
      setBuilt(j);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setState("idle");
    }
  };

  const sign = async () => {
    if (!built || !wallet) return;
    setState("loading");
    setErr(null);
    try {
      const tx = VersionedTransaction.deserialize(Uint8Array.from(atob(built.transaction), (c) => c.charCodeAt(0)));
      tx.addSignature(await devWalletPublicKey(wallet), await devWalletSign(wallet, tx.message.serialize()));
      // A carteira envia ela mesma (no localnet, para o surfpool pela /rpc do app).
      const conn = new Connection(new URL("/rpc", location.origin).toString(), "confirmed");
      const s = await conn.sendRawTransaction(tx.serialize());
      // Confirmação por consulta (o proxy local não repassa websocket).
      for (let i = 0; i < 40; i++) {
        const st = (await conn.getSignatureStatuses([s])).value[0];
        if (st?.err) throw new Error(`a transação falhou: ${JSON.stringify(st.err)}`);
        if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") break;
        await new Promise((r) => setTimeout(r, 500));
      }
      setSig(s);
      setState("sent");
    } catch (e) {
      setErr(errorText(e));
      setState("idle");
    }
  };

  return (
    <div className="page phone-frame" style={{ paddingTop: 28 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 600, color: "var(--warn)", letterSpacing: "0.12em", textTransform: "uppercase" }}>
        <Icon name="phone" size={16} color="#F2B33D" /> Celular de teste
      </div>
      <div className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
        Faz o papel da Phantom no celular lendo o QR (Solana Pay). Com o celular de verdade, esta tela é a da própria carteira.
      </div>
      {meta && (
        <div className="card" style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <img src={meta.icon} alt="" width={40} height={40} style={{ borderRadius: 12 }} />
          <div className="grow">
            <div style={{ fontWeight: 600 }}>{meta.label}</div>
            <div className="subtle mono" style={{ fontSize: 11 }}>
              {new URL(url).host}
            </div>
          </div>
        </div>
      )}
      {!built && state !== "loading" && meta && (
        <>
          <div className="section-title">Com qual carteira?</div>
          {WALLETS.map((w) => (
            <button key={w} type="button" className="item" onClick={() => choose(w)}>
              <div className="ico">
                <Icon name="key" />
              </div>
              <div className="grow t">{w}</div>
              <Icon name="chev" size={18} color="var(--muted)" />
            </button>
          ))}
        </>
      )}
      {built && state !== "sent" && (
        <>
          <div className="card" style={{ gap: 8 }}>
            <div className="muted" style={{ fontSize: 12 }}>
              {wallet} · pedido de assinatura
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.4 }}>{built.message}</div>
            <div className="subtle" style={{ fontSize: 12 }}>
              Taxa de rede paga por esta carteira.
            </div>
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <button type="button" className="btn" style={{ flex: 1 }} onClick={() => setBuilt(null)}>
              Recusar
            </button>
            <button type="button" className="btn primary" style={{ flex: 1 }} onClick={sign}>
              Confirmar
            </button>
          </div>
        </>
      )}
      {state === "loading" && (
        <div className="status">
          <span className="spinner" /> Um momento…
        </div>
      )}
      {state === "sent" && sig && (
        <div className="center" style={{ padding: "20px 0" }}>
          <div className="dot" style={{ background: "var(--accent)", width: 48, height: 48 }}>
            <Icon name="check" size={26} color="#0B0D10" sw={2.6} />
          </div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>Enviado</div>
          <div className="subtle mono" style={{ fontSize: 12 }}>
            {short(sig)}
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            Pode fechar esta aba e voltar ao computador.
          </div>
        </div>
      )}
      {err && <div className="banner danger">{err}</div>}
    </div>
  );
}
