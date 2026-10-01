import { useEffect, useState } from "react";
import { signPossession } from "@duplachave/custody/src/client";
import { errorText, useApp } from "../app";
import { api } from "../lib/api";
import { now } from "../lib/chain";
import { biometricAvailable, createBiometricProtection, createPinProtection, FreshKeySigner, generateKey, type Protection } from "../lib/device";
import { Icon, Logo } from "../icons";

/** Escolha da proteção local: biometria (se o aparelho tiver) ou PIN de 6 dígitos. */
export function ProtectionPicker({ deviceName, onReady, busy }: { deviceName: string; onReady: (p: Protection) => void; busy: boolean }) {
  const [bio, setBio] = useState(false);
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void biometricAvailable().then(setBio);
  }, []);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {bio && (
        <button
          type="button"
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setErr(null);
            try {
              onReady(await createBiometricProtection(deviceName));
            } catch (e) {
              setErr(errorText(e));
            }
          }}
        >
          <Icon name="finger" color="#0B0D10" sw={2} /> Proteger com biometria
        </button>
      )}
      <div className="field">
        <label htmlFor="pin">{bio ? "Ou um PIN de 6 dígitos" : "PIN de 6 dígitos"}</label>
        <input id="pin" className="input mono" inputMode="numeric" type="password" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} autoComplete="new-password" />
      </div>
      <div className="field">
        <label htmlFor="pin2">Repita o PIN</label>
        <input id="pin2" className="input mono" inputMode="numeric" type="password" maxLength={6} value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ""))} autoComplete="new-password" />
      </div>
      <button
        type="button"
        className={bio ? "btn" : "btn primary"}
        disabled={busy || pin.length !== 6}
        onClick={async () => {
          setErr(null);
          if (pin !== pin2) return setErr("os PINs não conferem");
          try {
            onReady(await createPinProtection(pin));
          } catch (e) {
            setErr(errorText(e));
          }
        }}
      >
        {busy ? <span className="spinner" /> : <Icon name="lock" />} Usar PIN
      </button>
      {err && <div className="err">{err}</div>}
    </div>
  );
}

export function Onboarding() {
  const ctx = useApp();
  const [step, setStep] = useState<"welcome" | "setup">("welcome");
  const [deviceName, setDeviceName] = useState(() => guessDevice());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const create = async (protection: Protection) => {
    setBusy(true);
    setErr(null);
    try {
      const key = await generateKey();
      const ch = await api("POST", "/v1/enrollment/challenge", {}, { auth: false });
      const possession = await signPossession({ signer: new FreshKeySigner(key), operation: "ENROLL_CLIENT_KEY", cluster: ctx.config.cluster, multisig: "", rotationId: ch.challengeId, challenge: ch.challenge, now: now() });
      const r = await api("POST", "/v1/enrollment", { userId: ch.userId, deviceName, challengeId: ch.challengeId, possession }, { auth: false });
      await ctx.setDevice({ privateKey: key.privateKey, publicKey: key.publicKey, deviceName, protection, createdAt: Date.now(), session: { token: r.token, accountId: r.account.id } });
      ctx.go("/");
      ctx.toast("Conta criada: multisig 2 de 2 na Solana.");
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (step === "welcome") {
    return (
      <div className="page" style={{ justifyContent: "space-between", paddingTop: 56 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <Logo size={56} />
          <div style={{ fontSize: 32, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1.1 }}>Seus fundos só saem com duas chaves.</div>
          <div className="muted" style={{ fontSize: 15, lineHeight: 1.55 }}>
            Uma fica neste aparelho. A outra fica no serviço, que confere cada pedido contra a sua política. Nenhuma das duas sozinha move nada — quem garante isso é o programa da Squads na Solana, não o nosso servidor.
          </div>
          <div className="card" style={{ gap: 0, padding: "4px 16px" }}>
            {[
              ["phone", "Sua chave", "criada aqui, nunca sai do aparelho"],
              ["server", "Chave do serviço", "só assina o que passa na política"],
              ["shieldcheck", "Squads v4", "exige as duas para mover ou trocar chaves"],
            ].map(([i, t, s], k) => (
              <div key={k} className="list-row" style={k === 0 ? { borderTop: 0 } : undefined}>
                <div className="ico">
                  <Icon name={i!} size={18} />
                </div>
                <div className="grow">
                  <div className="t">{t}</div>
                  <div className="s">{s}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <button type="button" className="btn primary" style={{ flex: "none" }} onClick={() => setStep("setup")}>
          Criar minha chave
        </button>
      </div>
    );
  }

  return (
    <div className="page" style={{ paddingTop: 40 }}>
      <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: "-0.02em" }}>Proteja a chave deste aparelho</div>
      <div className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
        Toda aprovação vai pedir isso antes de assinar. Se perder o aparelho sem trocar a chave antes, a conta fica bloqueada (modo estrito, sem recuperação ainda).
      </div>
      <div className="field">
        <label htmlFor="dn">Nome do aparelho</label>
        <input id="dn" className="input" value={deviceName} maxLength={40} onChange={(e) => setDeviceName(e.target.value)} />
      </div>
      <ProtectionPicker deviceName={deviceName} onReady={create} busy={busy} />
      {busy && (
        <div className="status">
          <span className="spinner" />
          Criando a multisig 2 de 2 na Solana…
        </div>
      )}
      {err && <div className="err">{err}</div>}
    </div>
  );
}

function guessDevice() {
  const ua = navigator.userAgent;
  if (/Android/.test(ua)) return "Android";
  if (/iPhone|iPad/.test(ua)) return "iPhone";
  if (/Linux/.test(ua)) return "Navegador Linux";
  if (/Mac/.test(ua)) return "Mac";
  return "Este navegador";
}
