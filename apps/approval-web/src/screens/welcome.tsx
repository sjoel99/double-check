import { useState } from "react";
import { errorText, loginOrEnroll, loginWithBiometrics, useApp } from "../app";
import { Icon, Logo } from "../icons";
import { type StandardWallet, walletLabel } from "../lib/wallets";
import { api } from "../lib/api";
import { PhoneQr } from "../components/PhoneQr";
import { isIOS } from "../lib/activation";

const INSTALL = [
  { name: "Phantom", url: "https://phantom.com/download" },
  { name: "Backpack", url: "https://backpack.app/downloads" },
  { name: "Solflare", url: "https://solflare.com/download" },
];

/** No iPhone, nenhuma carteira fala com o navegador: em vez de sugerir instalar uma, diz onde funciona. */
export function IosNotice() {
  return (
    <div className="card" style={{ gap: 8 }}>
      <div style={{ fontSize: 15, fontWeight: 600 }}>No iPhone ainda não funciona</div>
      <div className="muted" style={{ fontSize: 13, lineHeight: 1.5 }}>
        O Safari do iPhone não conversa com as carteiras Solana (Phantom, Backpack, Solflare…), nem pelo app. Por enquanto, use um computador com a extensão da carteira ou um celular Android.
      </div>
    </div>
  );
}

export function WalletList({ onPick, busy, exclude }: { onPick: (w: StandardWallet) => void; busy: boolean; exclude?: string }) {
  const { wallets } = useApp();
  const real = wallets.filter((w) => !w.name.startsWith("Carteira de teste"));
  const test = wallets.filter((w) => w.name.startsWith("Carteira de teste"));
  const row = (w: StandardWallet) => (
    <button key={w.name} type="button" className="item" disabled={busy} onClick={() => onPick(w)} style={{ padding: 14 }}>
      <img src={w.icon} alt="" width={36} height={36} style={{ borderRadius: 10 }} />
      <div className="grow">
        <div className="t">{walletLabel(w.name)}</div>
        {w.name === "Mobile Wallet Adapter" && <div className="s">Phantom, Solflare… (abre o app da carteira)</div>}
        {walletLabel(w.name) === exclude && <div className="s">carteira atual da conta</div>}
      </div>
      <Icon name="chev" size={18} color="var(--muted)" />
    </button>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {real.map(row)}
      {real.length === 0 && isIOS() && <IosNotice />}
      {real.length === 0 && !isIOS() && (
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

  const fromPhone = async (r: { sessionToken: string; accountId: string; publicKey: string }) => {
    await ctx.setSession({ token: r.sessionToken, accountId: r.accountId, walletName: "Carteira do celular", publicKey: r.publicKey, myRotations: [], via: "phone" });
    ctx.go("/");
    ctx.toast("Você entrou pelo celular. As assinaturas continuam no celular.");
  };

  const pick = async (w: StandardWallet) => {
    setErr(null);
    try {
      setStep(`Conectando à ${w.name}…`);
      const c = await ctx.connect(w);
      const s = await loginOrEnroll(ctx, c, setStep);
      ctx.go("/");
      ctx.toast(s.created ? `Conta 2 de 3 criada: sua ${c.name} + a chave do webapp (biometria) + o serviço.` : "Você entrou.");
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
        Três chaves: a sua carteira (Phantom, Backpack, Solflare…), a chave do webapp (protegida pela biometria do seu aparelho) e a do serviço. Um envio precisa da carteira e da biometria, e só o serviço executa, depois de conferir a sua política. Quem garante é o programa da Squads na Solana.
      </div>
      <div className="steps">
        {[
          ["1", "Conecte sua carteira", "Phantom, Backpack, Solflare…"],
          ["2", "Biometria + carteira", "a biometria protege a chave do webapp; a carteira paga ~0,003 SOL, uma vez só"],
          ["3", "Pronto", "sua conta 2 de 3 existe na Solana; cada envio custa ~0,000015 SOL"],
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
      {isIOS() ? null : phone ? (
        <div className="card">
          <PhoneQr
            create={() => api("POST", "/v1/pay/connect", {}, { auth: false })}
            title="Continue no celular"
            steps={["Aponte a câmera de um celular Android para o código e abra o link", "No celular, entre com a sua carteira (se for nova, cria a conta: ~0,003 SOL)", "Este computador entra na mesma conta"]}
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
            <div className="s">Escaneie com a câmera de um Android; a carteira abre pelo app</div>
          </div>
          <Icon name="chev" size={18} color="var(--muted)" />
        </button>
      )}
      {!isIOS() && <div className="or">ou a extensão deste navegador</div>}
      <WalletList onPick={pick} busy={Boolean(step)} />
      {step && (
        <div className="status sticky" role="status">
          <span className="spinner" /> {step}
        </div>
      )}
      {err && <div className="banner danger">{err}</div>}
      {!isIOS() && <BiometricLogin busy={Boolean(step)} setStep={setStep} setErr={setErr} />}
      {!isIOS() && (
        <div className="subtle" style={{ fontSize: 12, lineHeight: 1.5 }}>
          Já tem conta? Escolha a mesma carteira: o app reconhece e só pede para confirmar a entrada. Todas as taxas saem da sua carteira; o serviço não paga nada.
        </div>
      )}
    </div>
  );
}

/** Entrar sem a carteira (perdeu): a passkey abre a chave do webapp. */
function BiometricLogin({ busy, setStep, setErr }: { busy: boolean; setStep: (s: string | null) => void; setErr: (s: string | null) => void }) {
  const ctx = useApp();
  return (
    <button
      type="button"
      className="linkbtn"
      disabled={busy}
      onClick={async () => {
        setErr(null);
        try {
          await loginWithBiometrics(ctx, setStep);
          ctx.go("/security");
          ctx.toast("Você entrou com a biometria. Para trocar a carteira, use 'Trocar a carteira'.");
        } catch (e) {
          setErr(errorText(e));
        } finally {
          setStep(null);
        }
      }}
    >
      Perdeu a carteira? Entrar com a biometria
    </button>
  );
}
