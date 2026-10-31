import { useCallback, useRef, useState } from "react";
import { Sheet } from "./Sheet";
import { usePolling } from "../hooks/usePolling";
import { errorText, useApp } from "../app";
import { api } from "../lib/api";
import { Icon } from "../icons";
import { tr } from "../lib/i18n";
import { qrDataUrl } from "../lib/qr";

/** `poll`: segredo separado para o computador acompanhar; quem só viu o QR (token) não lê o resultado. */
type Created = { token: string; poll?: string; url: string; link: string; expiresAt: number; https: boolean };
type Status = { status: "WAITING" | "DONE" | "FAILED" | "EXPIRED"; error: string | null; result: unknown };
/** `T` é o que o celular devolve quando termina (sessão ao entrar; status da intenção ao assinar). */
export type PhoneQrProps<T> = { create: () => Promise<Created>; title: string; steps: string[]; onDone: (result: T) => void };

/**
 * QR "continuar no celular": a câmera abre o NOSSO app no celular, que confere
 * a transação, pede a biometria e só então chama a carteira. Este componente
 * acompanha até o celular terminar.
 */
export function PhoneQr<T>({ create, title, steps, onDone }: PhoneQrProps<T>) {
  const ctx = useApp();
  const [req, setReq] = useState<Created | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [st, setSt] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const done = useRef(false);
  // `create` e `onDone` chegam como funções novas a cada render do pai. Por ref,
  // o pedido é feito uma vez só por abertura: um QR novo faria o computador
  // vigiar outro token enquanto o celular termina o anterior.
  const createRef = useRef(create);
  const onDoneRef = useRef(onDone);
  createRef.current = create;
  onDoneRef.current = onDone;

  const make = useCallback(async () => {
    setErr(null);
    setSt(null);
    try {
      const r = await createRef.current();
      setReq(r);
      setQr(await qrDataUrl(r.link));
    } catch (e) {
      setErr(errorText(e));
    }
  }, []);

  // O pedido é feito uma vez só por abertura (ver createRef acima).
  const started = useRef(false);
  if (!started.current) {
    started.current = true;
    void make();
  }

  // Acompanha o celular enquanto a aba está visível; ao voltar, confere na hora.
  const token = req?.poll ?? req?.token;
  const finished = !st || st.status === "WAITING" ? false : true;
  const poll = useCallback(async () => {
    if (!token) return;
    try {
      const s = await api<Status>("GET", `/v1/pay/${token}`, undefined, { auth: false });
      setSt(s);
      if (s.status === "DONE" && !done.current) {
        done.current = true;
        onDoneRef.current(s.result as T);
      }
    } catch {
      /* tenta de novo */
    }
  }, [token]);
  usePolling(poll, 1500, Boolean(token) && !finished);

  const phase = st?.status === "WAITING" || !st ? "WAITING_SCAN" : st.status;
  return (
    <div className="qr-box">
      <div style={{ fontSize: 17, fontWeight: 600, textAlign: "center" }}>{title}</div>
      {qr && phase === "WAITING_SCAN" && <img className="qr" src={qr} alt={tr("QR code para a carteira do celular", "QR code for the phone wallet")} />}
      {phase === "WAITING_SCAN" && qr && (
        <div className="status" style={{ justifyContent: "center", fontSize: 13 }}>
          <span className="spinner" /> {tr("Esperando o celular terminar…", "Waiting for the phone to finish…")}
        </div>
      )}
      {phase === "DONE" && (
        <div className="center" style={{ padding: "24px 0" }}>
          <div className="dot" style={{ background: "var(--accent)", width: 44, height: 44 }}>
            <Icon name="check" size={24} color="#0B0D10" sw={2.6} />
          </div>
          <div style={{ fontWeight: 600 }}>{tr("Feito no celular", "Done on the phone")}</div>
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
            {tr("Este QR aponta para ", "This QR points to ")}
            <span className="mono">{new URL(req.url).host}</span>
            {tr(' (sem HTTPS): só funciona como "celular de teste" (outra aba). Para o celular de verdade, rode ', ' (no HTTPS): it only works as a "test phone" (another tab). For a real phone, run ')}
            <span className="mono">pnpm dev:devnet</span>.
          </div>
        </div>
      )}
      {ctx.config.devTools && req && phase === "WAITING_SCAN" && (
        <a className="btn small" href={req.url} target="_blank" rel="noreferrer">
          <Icon name="phone" size={16} /> {tr("Abrir no celular de teste", "Open on test phone")}
        </a>
      )}
      {(phase === "FAILED" || phase === "EXPIRED" || err) && (
        <>
          <div className="banner danger">{err ?? st?.error ?? tr("O QR expirou.", "The QR code expired.")}</div>
          <button type="button" className="btn small" onClick={() => void make()}>
            {tr("Gerar outro QR", "New QR code")}
          </button>
        </>
      )}
    </div>
  );
}

/** Janela com o QR por cima da tela atual. */
export function PhoneQrSheet<T>(props: PhoneQrProps<T> & { onClose: () => void }) {
  return (
    <Sheet label={props.title} onClose={props.onClose}>
      <PhoneQr {...props} />
      <button type="button" className="linkbtn" onClick={props.onClose}>
        {tr("Fechar", "Close")}
      </button>
    </Sheet>
  );
}

export const SCAN_STEPS = [
  tr("Aponte a câmera de um celular Android para o código e abra o link", "Point an Android phone's camera at the code and open the link"),
  tr("No celular: entre com a sua carteira e confira o que vai ser assinado", "On the phone: sign in with your wallet and check what will be signed"),
  tr("Confirme com a biometria e assine na carteira", "Confirm with fingerprint or face and sign in the wallet"),
];
