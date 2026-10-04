import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { errorText, useApp } from "../app";
import { api } from "../lib/api";
import { Icon } from "../icons";

type Created = { token: string; url: string; link: string; expiresAt: number; https: boolean };
type Status = { status: "WAITING" | "DONE" | "FAILED" | "EXPIRED"; error: string | null; result: any };

/**
 * QR "continuar no celular": a câmera abre o NOSSO app no celular, que confere
 * a transação, pede a biometria e só então chama a carteira. Este componente
 * acompanha até o celular terminar.
 */
export function PhoneQr({ create, title, steps, onDone }: { create: () => Promise<Created>; title: string; steps: string[]; onDone: (result: any) => void }) {
  const ctx = useApp();
  const [req, setReq] = useState<Created | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [st, setSt] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const done = useRef(false);

  const make = useCallback(async () => {
    setErr(null);
    setSt(null);
    try {
      const r = await create();
      setReq(r);
      setQr(await QRCode.toDataURL(r.link, { margin: 1, width: 480, errorCorrectionLevel: "M" }));
    } catch (e) {
      setErr(errorText(e));
    }
  }, [create]);

  useEffect(() => {
    void make();
  }, [make]);

  useEffect(() => {
    if (!req) return;
    const i = setInterval(async () => {
      try {
        const s = await api<Status>("GET", `/v1/pay/${req.token}`, undefined, { auth: false });
        setSt(s);
        if (s.status === "DONE" && !done.current) {
          done.current = true;
          clearInterval(i);
          onDone(s.result);
        }
        if (s.status === "FAILED" || s.status === "EXPIRED") clearInterval(i);
      } catch {
        /* tenta de novo */
      }
    }, 1500);
    return () => clearInterval(i);
  }, [req, onDone]);

  const phase = st?.status === "WAITING" || !st ? "WAITING_SCAN" : st.status;
  return (
    <div className="qr-box">
      <div style={{ fontSize: 17, fontWeight: 600, textAlign: "center" }}>{title}</div>
      {qr && phase === "WAITING_SCAN" && <img className="qr" src={qr} alt="QR code para a carteira do celular" />}
      {phase === "WAITING_SCAN" && qr && (
        <div className="status" style={{ justifyContent: "center", fontSize: 13 }}>
          <span className="spinner" /> Esperando o celular terminar…
        </div>
      )}
      {phase === "DONE" && (
        <div className="center" style={{ padding: "24px 0" }}>
          <div className="dot" style={{ background: "var(--accent)", width: 44, height: 44 }}>
            <Icon name="check" size={24} color="#0B0D10" sw={2.6} />
          </div>
          <div style={{ fontWeight: 600 }}>Feito no celular</div>
        </div>
      )}
      {phase === "WAITING_SCAN" && (
        <ol className="qr-steps">
          {steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      )}
      {req && !req.https && (
        <div className="banner warn" style={{ fontSize: 12 }}>
          <Icon name="shieldalert" size={16} color="#F2B33D" />
          <div>
            Este QR aponta para <span className="mono">{new URL(req.url).host}</span> (sem HTTPS): só funciona como "celular de teste" (outra aba). Para o celular de verdade, rode <span className="mono">pnpm dev:devnet</span>.
          </div>
        </div>
      )}
      {ctx.config.devTools && req && phase === "WAITING_SCAN" && (
        <a className="btn small" href={req.url} target="_blank" rel="noreferrer">
          <Icon name="phone" size={16} /> Abrir no celular de teste
        </a>
      )}
      {(phase === "FAILED" || phase === "EXPIRED" || err) && (
        <>
          <div className="banner danger">{err ?? st?.error ?? "O QR expirou."}</div>
          <button type="button" className="btn small" onClick={() => void make()}>
            Gerar outro QR
          </button>
        </>
      )}
    </div>
  );
}

/** Janela com o QR por cima da tela atual. */
export function PhoneQrSheet(props: Parameters<typeof PhoneQr>[0] & { onClose: () => void }) {
  return (
    <div className="sheet-wrap" role="dialog" aria-modal="true" aria-label={props.title}>
      <div className="sheet" style={{ alignItems: "stretch" }}>
        <div className="grab" style={{ alignSelf: "center" }} />
        <PhoneQr {...props} />
        <button type="button" className="linkbtn" onClick={props.onClose}>
          Fechar
        </button>
      </div>
    </div>
  );
}

export const SCAN_STEPS = ["Aponte a câmera do celular para o código e abra o link", "No celular: entre com a sua carteira e confira o que vai ser assinado", "Confirme com a biometria e assine na carteira"];
