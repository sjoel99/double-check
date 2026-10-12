import { useState } from "react";
import { trace } from "../lib/trace";
import { tr } from "../lib/i18n";

/**
 * Teste: este aparelho entrega a extensão PRF do WebAuthn (uma chave secreta
 * derivada da passkey, que vai destravar a chave do webapp)? Cria uma passkey
 * de teste e confere que a PRF volta igual em duas leituras.
 */
const FAIL = tr("FALHA: ", "FAIL: ");
const ERR = tr("erro: ", "error: ");

export function PrfCheck() {
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const add = (s: string) => {
    setLog((l) => [...l, s]);
    trace("prf", s);
  };
  const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b).slice(0, 4), (x) => x.toString(16).padStart(2, "0")).join("");

  const run = async () => {
    setBusy(true);
    setLog([]);
    try {
      const salt = new TextEncoder().encode("duplachave-prf-teste");
      const cred = (await navigator.credentials.create({
        publicKey: {
          rp: { id: location.hostname, name: tr("Double Check (teste PRF)", "Double Check (PRF test)") },
          user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "teste-prf", displayName: tr("Teste PRF", "PRF test") },
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
          authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
          extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential;
      const ce = cred.getClientExtensionResults() as { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };
      add(tr(`criação: prf.enabled=${ce.prf?.enabled} (resultado já na criação: ${ce.prf?.results?.first ? "sim" : "não"})`, `creation: prf.enabled=${ce.prf?.enabled} (result already at creation: ${ce.prf?.results?.first ? "yes" : "no"})`));
      const read = async () => {
        const a = (await navigator.credentials.get({
          publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            rpId: location.hostname,
            allowCredentials: [{ type: "public-key", id: cred.rawId }],
            userVerification: "required",
            extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
          },
        })) as PublicKeyCredential;
        return (a.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }).prf?.results?.first;
      };
      const r1 = await read();
      add(`${tr("leitura 1", "read 1")}: ${r1 ? `${r1.byteLength} bytes (${hex(r1)}…)` : tr("sem PRF", "no PRF")}`);
      const r2 = await read();
      add(`${tr("leitura 2", "read 2")}: ${r2 ? `${r2.byteLength} bytes (${hex(r2)}…)` : tr("sem PRF", "no PRF")}`);
      if (r1 && r2) add(new Uint8Array(r1).every((x, i) => x === new Uint8Array(r2)[i]) ? tr("OK: PRF funciona e é estável neste aparelho", "OK: PRF works and is stable on this device") : FAIL + tr("PRF mudou entre leituras", "PRF changed between reads"));
      else add(FAIL + tr("este aparelho/gerenciador não entrega PRF", "this device/password manager doesn't provide PRF"));
    } catch (e) {
      add(`${ERR}${(e as Error).name}: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page" style={{ paddingTop: 36, gap: 16 }}>
      <div style={{ fontSize: 22, fontWeight: 600 }}>{tr("Teste de biometria (PRF)", "Biometrics test (PRF)")}</div>
      <div className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
        {tr("Cria uma passkey de teste e lê a chave secreta dela duas vezes. Pede a digital/rosto três vezes. Não mexe na sua conta.", "Creates a test passkey and reads its secret key twice. Asks for your fingerprint or face three times. Doesn't touch your account.")}
      </div>
      <button type="button" className="btn primary" disabled={busy} onClick={run}>
        {busy ? <span className="spinner" /> : null} {tr("Testar", "Run test")}
      </button>
      {log.map((l, i) => (
        <div key={i} className={`banner ${l.startsWith("OK") ? "ok" : l.startsWith(FAIL) || l.startsWith(ERR) ? "danger" : "info"}`}>
          {l}
        </div>
      ))}
    </div>
  );
}
