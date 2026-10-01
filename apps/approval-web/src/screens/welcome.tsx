import { useState } from "react";
import { errorText, loginOrEnroll, useApp } from "../app";
import { Icon, Logo } from "../icons";
import type { StandardWallet } from "../lib/wallets";
import { api } from "../lib/api";
import { PhoneQr, SCAN_STEPS } from "../components/PhoneQr";

const INSTALL = [
  { name: "Phantom", url: "https://phantom.com/download" },
  { name: "Backpack", url: "https://backpack.app/downloads" },
  { name: "Solflare", url: "https://solflare.com/download" },
];

export function WalletList({ onPick, busy, exclude }: { onPick: (w: StandardWallet) => void; busy: boolean; exclude?: string }) {
  const { wallets } = useApp();
  const real = wallets.filter((w) => !w.name.startsWith("Carteira de teste"));
  const test = wallets.filter((w) => w.name.startsWith("Carteira de teste"));
  const row = (w: StandardWallet) => (
    <button key={w.name} type="button" className="item" disabled={busy} onClick={() => onPick(w)} style={{ padding: 14 }}>
      <img src={w.icon} alt="" width={36} height={36} style={{ borderRadius: 10 }} />
      <div className="grow">
        <div className="t">{w.name}</div>
        {w.name === exclude && <div className="s">carteira atual da conta</div>}
      </div>
      <Icon name="chev" size={18} color="var(--muted)" />
    </button>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {real.map(row)}
      {real.length === 0 && (
        <div className="card" style={{ gap: 10 }}>
          <div style={{ fontSize: 14 }}>Nenhuma carteira encontrada neste navegador.</div>
          <div className="muted" style={{ fontSize: 13 }}>
            Instale uma e recarregue a página:
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {INSTALL.map((i) => (
              <a key={i.name} className="pill" href={i.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none", padding: "8px 12px" }}>
                {i.name}
              </a>
            ))}
          </div>
        </div>
      )}
      {test.length > 0 && (
        <>
          <div className="subtle" style={{ fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", paddingTop: 6 }}>
            Ambiente local (sem extensão)
          </div>
          {test.map(row)}
        </>
      )}
    </div>
  );
}

export function Welcome() {
  const ctx = useApp();
  const [step, setStep] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [phone, setPhone] = useState(false);

  const fromPhone = async (r: { sessionToken: string; accountId: string; publicKey: string; created: boolean }) => {
    await ctx.setSession({ token: r.sessionToken, accountId: r.accountId, walletName: "Carteira do celular", publicKey: r.publicKey, myRotations: [], via: "phone" });
    ctx.go("/");
    ctx.toast(r.created ? "Pronto. Sua conta 2 de 2 foi criada." : "Você entrou pela carteira do celular.");
  };

  const pick = async (w: StandardWallet) => {
    setErr(null);
    try {
      setStep(`Conectando à ${w.name}…`);
      const c = await ctx.connect(w);
      await loginOrEnroll(ctx, c, setStep);
      ctx.go("/");
      ctx.toast("Pronto. Sua conta 2 de 2 está ativa.");
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setStep(null);
    }
  };

  return (
    <div className="page" style={{ paddingTop: 44, gap: 22 }}>
      <Logo size={52} />
      <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1.1 }}>Seus fundos só saem com duas assinaturas.</div>
      <div className="muted" style={{ fontSize: 15, lineHeight: 1.55 }}>
        A sua carteira e a do serviço, que confere cada pedido contra a sua política. Nenhuma das duas sozinha move nada — quem garante é o programa da Squads na Solana.
      </div>
      <div className="steps">
        {[
          ["1", "Conecte sua carteira", "Phantom, Backpack, Solflare…"],
          ["2", "Assine o vínculo", "a carteira mostra o texto antes de assinar"],
          ["3", "Pronto", "sua conta 2 de 2 é criada na Solana"],
        ].map(([n, t, s]) => (
          <div key={n} className="step">
            <div className="step-n">{n}</div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{t}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                {s}
              </div>
            </div>
          </div>
        ))}
      </div>
      {phone ? (
        <div className="card">
          <PhoneQr
            create={() => api("POST", "/v1/pay/connect", {}, { auth: false })}
            title="Escaneie com a carteira do celular"
            steps={[...SCAN_STEPS.slice(0, 2), "Confirme: se a carteira for nova, a conta é criada; se já tiver conta, você entra"]}
            onDone={fromPhone}
          />
          <button type="button" className="linkbtn" onClick={() => setPhone(false)}>
            Voltar
          </button>
        </div>
      ) : (
        <button type="button" className="item phone-cta" onClick={() => setPhone(true)}>
          <div className="ico" style={{ background: "var(--accent)" }}>
            <Icon name="phone" color="#0B0D10" sw={2} />
          </div>
          <div className="grow">
            <div className="t">Usar a carteira do celular</div>
            <div className="s">Escaneie um QR com a Phantom ou Solflare</div>
          </div>
          <Icon name="chev" size={18} color="var(--muted)" />
        </button>
      )}
      <div className="or">ou a extensão deste navegador</div>
      <WalletList onPick={pick} busy={Boolean(step)} />
      {step && (
        <div className="status">
          <span className="spinner" /> {step}
        </div>
      )}
      {err && <div className="banner danger">{err}</div>}
      <div className="subtle" style={{ fontSize: 12, lineHeight: 1.5 }}>
        Já tem conta? Escolha a mesma carteira: o app reconhece e só pede para confirmar a entrada.
      </div>
    </div>
  );
}
