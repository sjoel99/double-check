import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { b64url, type SoftCredential, softCreate, softGet } from "@duplachave/crypto";
import { kvGet, kvSet } from "./storage";

/**
 * Biometria (passkey/WebAuthn) deste aparelho. Com o app aberto num domínio
 * de verdade, é a passkey do sistema (digital, rosto, PIN do aparelho). Em
 * localnet (127.0.0.1, onde o WebAuthn não funciona) há a "biometria de
 * teste": ES256 do WebCrypto, chave não exportável no IndexedDB, com uma
 * janela de confirmação — como as carteiras de teste.
 */
export type BiometricConfirm = (text: string) => Promise<boolean>;

const softKey = () => `softpasskeys:${location.host}`;

async function sha256(bytes: Uint8Array) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/** Desafio da confirmação de uma transação: o próprio app calcula, a partir dos bytes que conferiu. */
export async function challengeFor(bytes: Uint8Array) {
  return b64url(await sha256(bytes));
}
export async function challengeForText(text: string) {
  return challengeFor(new TextEncoder().encode(text));
}

/** Cria a passkey deste aparelho a partir das opções do servidor. */
export async function createPasskey(options: any, soft: { devTools: boolean; confirm: BiometricConfirm }) {
  if (soft.devTools) {
    if (!(await soft.confirm("Criar a biometria de teste deste navegador?"))) throw new Error("biometria recusada");
    const { credential, response } = await softCreate({ challenge: options.challenge, rpId: options.rp.id, origin: location.origin });
    await kvSet(softKey(), [...((await kvGet<SoftCredential[]>(softKey())) ?? []), credential]);
    return response;
  }
  return startRegistration({ optionsJSON: options });
}

/** Confirma com a biometria (user verification obrigatória) sobre o desafio dado. */
export async function confirmPasskey(challenge: string, allow: string[], soft: { devTools: boolean; confirm: BiometricConfirm; what: string }) {
  if (soft.devTools) {
    const all = (await kvGet<SoftCredential[]>(softKey())) ?? [];
    const cred = all.find((c) => allow.includes(c.id));
    if (!cred) throw new Error("Este navegador não tem uma biometria ativa nesta conta. Ative em Segurança.");
    if (!(await soft.confirm(soft.what))) throw new Error("biometria recusada");
    const out = await softGet(cred, { challenge, rpId: location.hostname, origin: location.origin });
    await kvSet(softKey(), all); // contador
    return out;
  }
  return startAuthentication({
    optionsJSON: {
      challenge,
      rpId: location.hostname,
      allowCredentials: allow.map((id) => ({ id, type: "public-key" as const })),
      userVerification: "required",
      timeout: 60_000,
    },
  });
}

/** Nome do aparelho para a lista de biometrias. */
export function deviceName() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad/i.test(ua)) return "iPhone";
  if (/Mac/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Linux/i.test(ua)) return "Linux";
  return "Navegador";
}
