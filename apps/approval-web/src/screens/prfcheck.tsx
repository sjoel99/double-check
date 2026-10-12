import { useState } from "react";
import { trace } from "../lib/trace";

/**
 * Teste: este aparelho entrega a extensão PRF do WebAuthn (uma chave secreta
 * derivada da passkey, que vai destravar a chave do webapp)? Cria uma passkey
 * de teste e confere que a PRF volta igual em duas leituras.
 */
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
          rp: { id: location.hostname, name: "Double Check (teste PRF)" },
          user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "teste-prf", displayName: "Teste PRF" },
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
          authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
          extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential;
      const ce = cred.getClientExtensionResults() as { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };
      add(`criação: prf.enabled=${ce.prf?.enabled} (resultado já na criação: ${ce.prf?.results?.first ? "sim" : "não"})`);
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
      add(`leitura 1: ${r1 ? `${r1.byteLength} bytes (${hex(r1)}…)` : "sem PRF"}`);
      const r2 = await read();
      add(`leitura 2: ${r2 ? `${r2.byteLength} bytes (${hex(r2)}…)` : "sem PRF"}`);
      if (r1 && r2) add(new Uint8Array(r1).every((x, i) => x === new Uint8Array(r2)[i]) ? "OK: PRF funciona e é estável neste aparelho" : "FALHA: PRF mudou entre leituras");
      else add("FALHA: este aparelho/gerenciador não entrega PRF");
    } catch (e) {
      add(`erro: ${(e as Error).name}: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page" style={{ paddingTop: 36, gap: 16 }}>
      <div style={{ fontSize: 22, fontWeight: 600 }}>Teste de biometria (PRF)</div>
      <div className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
        Cria uma passkey de teste e lê a chave secreta dela duas vezes. Pede a digital/rosto três vezes. Não mexe na sua conta.
      </div>
      <button type="button" className="btn primary" disabled={busy} onClick={run}>
        {busy ? <span className="spinner" /> : null} Testar
      </button>
      {log.map((l, i) => (
        <div key={i} className={`banner ${l.startsWith("OK") ? "ok" : l.startsWith("FALHA") || l.startsWith("erro") ? "danger" : "info"}`}>
          {l}
        </div>
      ))}
    </div>
  );
}
