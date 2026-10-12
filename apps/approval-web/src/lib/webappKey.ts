import { ed25519 } from "@noble/curves/ed25519.js";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { b64url, fromB64url } from "@duplachave/crypto";
import { kvGet, kvSet } from "./storage";
import { ensureActivation, isMobile } from "./activation";
import { trace } from "./trace";
import { tr } from "./i18n";

/**
 * Chave do webapp: um dos três votos da multisig. É uma chave Ed25519 gerada
 * aqui, cifrada com AES-GCM; a chave AES sai da extensão PRF da passkey do
 * aparelho (digital/rosto). O serviço guarda só o texto cifrado. Para assinar:
 * biometria → PRF → abre a chave por um instante → assina → apaga da memória.
 *
 * Em localnet (127.0.0.1, sem WebAuthn) há a "biometria de teste": uma PRF em
 * software (HMAC com chave não exportável no IndexedDB), com janela de confirmação.
 */
export type WebappKeyBlob = { credentialId: string; salt: string; iv: string; ciphertext: string };
export type BiometricConfirm = (text: string) => Promise<boolean>;
export type UnlockedKey = { publicKey: PublicKey; sign: (msg: Uint8Array) => Uint8Array; wipe: () => void };
type Opts = { devTools: boolean; confirm: BiometricConfirm; what: string };

const enc = new TextEncoder();
/** Sal fixo da PRF: deixa a passkey ser descoberta sem saber antes qual é (perdeu a carteira, aparelho novo…). */
const PRF_SALT = Uint8Array.from("00a51f9e00616db284f6a595e239644760e218a6ae1daa15b01de5284b21fd7f".match(/../g)!, (x) => parseInt(x, 16)); // sha256("duplachave/webapp-key/prf/v1")

async function aesKey(prf: Uint8Array) {
  const base = await crypto.subtle.importKey("raw", prf as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode("duplachave/webapp-key/v1") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// ---------------------------------------------------------------- biometria de teste (localnet)
type SoftPrf = { id: string; key: CryptoKey };
const SOFT = () => `softprf:${location.host}`;
async function softCreate(confirm: BiometricConfirm) {
  if (!(await confirm(tr("Criar a biometria de teste deste navegador?", "Set up test biometrics in this browser?")))) throw new Error("biometria recusada");
  const key = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const cred: SoftPrf = { id: b64url(crypto.getRandomValues(new Uint8Array(16))), key };
  await kvSet(SOFT(), [...((await kvGet<SoftPrf[]>(SOFT())) ?? []), cred]);
  return cred;
}
async function softEval(cred: SoftPrf) {
  return new Uint8Array(await crypto.subtle.sign("HMAC", cred.key, PRF_SALT as BufferSource));
}

// ---------------------------------------------------------------- passkey com PRF
type PrfResult = { credentialId: string; prf: Uint8Array };
type PrfExt = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

async function passkeyCreate(): Promise<PrfResult> {
  if (isMobile()) await ensureActivation(tr("Criar a biometria deste aparelho", "Set up biometrics on this device"));
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { id: location.hostname, name: "Double Check" },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "Double Check", displayName: tr("Chave do webapp", "Webapp key") },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("biometria recusada");
  const ext = cred.getClientExtensionResults() as PrfExt;
  trace("webappkey:criada", `prf.enabled=${ext.prf?.enabled} resultado=${Boolean(ext.prf?.results?.first)}`);
  if (ext.prf?.enabled === false) throw new Error(tr("Este aparelho não suporta a biometria com chave (PRF). Use o Chrome no Android com o gerenciador de senhas do Google.", "This device doesn't support biometrics with a key (PRF). Use Chrome on Android with Google Password Manager."));
  const credentialId = b64url(new Uint8Array(cred.rawId));
  if (ext.prf?.results?.first) return { credentialId, prf: new Uint8Array(ext.prf.results.first) };
  // Muitos aparelhos só entregam a PRF numa leitura: pede a biometria de novo.
  return passkeyGet([credentialId]);
}

async function passkeyGet(allow: string[] | null): Promise<PrfResult> {
  if (isMobile()) await ensureActivation(tr("Confirmar com a biometria", "Confirm with fingerprint or face"));
  const a = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: location.hostname,
      allowCredentials: allow ? allow.map((id) => ({ type: "public-key" as const, id: fromB64url(id) as BufferSource })) : [],
      userVerification: "required",
      extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!a) throw new Error("biometria recusada");
  const first = (a.getClientExtensionResults() as PrfExt).prf?.results?.first;
  if (!first) throw new Error(tr("Este aparelho não devolveu a chave da biometria (PRF).", "This device didn't return the biometrics key (PRF)."));
  return { credentialId: b64url(new Uint8Array(a.rawId)), prf: new Uint8Array(first) };
}

// ---------------------------------------------------------------- criar e abrir

/** Gera a chave do webapp, cifra com a biometria deste aparelho e devolve aberta (para assinar o cadastro). */
export async function createWebappKey(opts: Opts): Promise<UnlockedKey & { blob: WebappKeyBlob }> {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = new PublicKey(ed25519.getPublicKey(seed));
  let r: PrfResult;
  if (opts.devTools) {
    const c = await softCreate(opts.confirm);
    r = { credentialId: c.id, prf: await softEval(c) };
  } else r = await passkeyCreate();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(publicKey.toBase58()) }, await aesKey(r.prf), seed as BufferSource));
  r.prf.fill(0);
  const blob = { credentialId: r.credentialId, salt: b64url(PRF_SALT), iv: b64url(iv), ciphertext: b64url(ct) };
  return { ...unlocked(seed, publicKey), blob };
}

/**
 * Abre a chave do webapp com a biometria. `blobs`: as cópias cifradas da conta
 * (o aparelho escolhe a passkey dele). Sem `blobs`, descobre a passkey e pede
 * a cópia ao serviço (`lookup`) — para quem perdeu a carteira.
 */
export async function unlockWebappKey(
  blobs: { publicKey: string; blob: WebappKeyBlob }[] | null,
  opts: Opts & { lookup?: (credentialId: string) => Promise<{ publicKey: string; blob: WebappKeyBlob }> },
): Promise<UnlockedKey> {
  let r: PrfResult;
  let found: { publicKey: string; blob: WebappKeyBlob } | null = null;
  if (opts.devTools) {
    const all = (await kvGet<SoftPrf[]>(SOFT())) ?? [];
    if (!(await opts.confirm(opts.what))) throw new Error("biometria recusada");
    // Biometria de teste: como o seletor de passkeys do sistema, tenta as deste navegador (a mais nova primeiro).
    let pick: SoftPrf | null = null;
    for (const c of [...all].reverse()) {
      const b = blobs ? blobs.find((x) => x.blob.credentialId === c.id) : opts.lookup ? await opts.lookup(c.id).catch(() => null) : null;
      if (b) {
        pick = c;
        found = b;
        break;
      }
    }
    if (!pick) throw new Error(tr("Este navegador não tem a biometria desta conta.", "This browser doesn't have this account's biometrics."));
    r = { credentialId: pick.id, prf: await softEval(pick) };
  } else r = await passkeyGet(blobs ? blobs.map((b) => b.blob.credentialId) : null);
  found ??= blobs?.find((b) => b.blob.credentialId === r.credentialId) ?? (opts.lookup ? await opts.lookup(r.credentialId) : null);
  if (!found) throw new Error(tr("Esta biometria não abre a chave desta conta.", "These biometrics don't unlock this account's key."));
  try {
    const seed = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(found.blob.iv) as BufferSource, additionalData: enc.encode(found.publicKey) }, await aesKey(r.prf), fromB64url(found.blob.ciphertext) as BufferSource),
    );
    const publicKey = new PublicKey(ed25519.getPublicKey(seed));
    if (publicKey.toBase58() !== found.publicKey) throw new Error(tr("chave aberta não confere", "unlocked key doesn't match"));
    return unlocked(seed, publicKey);
  } catch (e) {
    throw new Error(tr(`Não deu para abrir a chave do webapp: ${(e as Error).message}`, `Couldn't unlock the webapp key: ${(e as Error).message}`));
  } finally {
    r.prf.fill(0);
  }
}

function unlocked(seed: Uint8Array, publicKey: PublicKey): UnlockedKey {
  return {
    publicKey,
    sign: (msg) => ed25519.sign(msg, seed),
    wipe: () => seed.fill(0),
  };
}

export const signatureB58 = (sig: Uint8Array) => bs58.encode(sig);

export function deviceName() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad/i.test(ua)) return "iPhone";
  if (/Mac/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Linux/i.test(ua)) return "Linux";
  return tr("Navegador", "Browser");
}
