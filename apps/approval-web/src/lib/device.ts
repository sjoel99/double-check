import { PublicKey } from "@solana/web3.js";
import type { DescribedSigner, SignerDescription } from "@duplachave/crypto";

/**
 * Chave de aprovação do navegador: Ed25519 gerada pelo WebCrypto com
 * `extractable: false`. O CryptoKey fica no IndexedDB; o JavaScript nunca vê
 * os bytes da chave privada (o navegador recusa exportá-la). Nada vai para
 * localStorage, e nada sai do aparelho.
 *
 * A assinatura só acontece depois da confirmação local (biometria via WebAuthn
 * ou PIN), que destrava o signer por poucos segundos.
 */

const DB = "duplachave";
const STORE = "device";

export type Protection =
  | { kind: "webauthn"; credentialId: string }
  | { kind: "pin"; salt: string; hash: string; iterations: number };

export type DeviceRecord = {
  privateKey: CryptoKey;
  publicKey: string;
  deviceName: string;
  protection: Protection;
  createdAt: number;
  session?: { token: string; accountId: string } | null;
  failedPins?: number;
  /** Rotações de chave do cliente pedidas por este aparelho (o app só aprova estas). */
  myRotations?: string[];
  lockedUntil?: number;
};

/** Namespace do aparelho. `?device=novo` simula um segundo aparelho no mesmo navegador (dev). */
export const DEVICE_NS = new URLSearchParams(location.search).get("device") ?? "principal";

let dbPromise: Promise<IDBDatabase> | null = null;

/** Uma conexão só, reaproveitada (cada `open` sem `close` segurava o banco aberto). */
function idb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => {
      req.result.onversionchange = () => {
        req.result.close();
        dbPromise = null;
      };
      resolve(req.result);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function loadDevice(): Promise<DeviceRecord | null> {
  return (await tx("readonly", (s) => s.get(DEVICE_NS))) ?? null;
}

export async function saveDevice(d: DeviceRecord) {
  await tx("readwrite", (s) => s.put(d, DEVICE_NS));
}

export async function wipeDevice() {
  await tx("readwrite", (s) => s.delete(DEVICE_NS));
}

export async function ed25519Supported(): Promise<boolean> {
  try {
    await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    return true;
  } catch {
    return false;
  }
}

export async function generateKey(): Promise<{ privateKey: CryptoKey; publicKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: new PublicKey(raw).toBase58() };
}

// ---------------------------------------------------------------------------
// confirmação local
// ---------------------------------------------------------------------------

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
const b64u = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export async function biometricAvailable(): Promise<boolean> {
  try {
    return Boolean(window.PublicKeyCredential) && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch {
    return false;
  }
}

export async function createBiometricProtection(deviceName: string): Promise<Protection> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: "Dupla Chave" },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: deviceName, displayName: deviceName },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "discouraged" },
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("biometria cancelada");
  return { kind: "webauthn", credentialId: b64u(cred.rawId) };
}

async function pinHash(pin: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, key, 256));
}

export async function createPinProtection(pin: string): Promise<Protection> {
  if (!/^\d{6}$/.test(pin)) throw new Error("o PIN precisa ter 6 dígitos");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 310_000;
  return { kind: "pin", salt: hex(salt), hash: await pinHash(pin, salt, iterations), iterations };
}

let unlockedUntil = 0;

/** Biometria pelo autenticador da plataforma. */
export async function unlockWithBiometric(p: Extract<Protection, { kind: "webauthn" }>) {
  const ok = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: "public-key", id: fromB64u(p.credentialId) }],
      userVerification: "required",
      timeout: 60_000,
    },
  });
  if (!ok) throw new Error("biometria cancelada");
  unlockedUntil = Date.now() + 20_000;
}

/** PIN: 5 erros travam por 5 minutos. */
export async function unlockWithPin(d: DeviceRecord, pin: string) {
  if (d.protection.kind !== "pin") throw new Error("este aparelho usa biometria");
  if ((d.lockedUntil ?? 0) > Date.now()) throw new Error("muitas tentativas: aguarde alguns minutos");
  const ok = (await pinHash(pin, fromHex(d.protection.salt), d.protection.iterations)) === d.protection.hash;
  if (!ok) {
    const failed = (d.failedPins ?? 0) + 1;
    await saveDevice({ ...d, failedPins: failed, lockedUntil: failed >= 5 ? Date.now() + 5 * 60_000 : 0 });
    throw new Error(failed >= 5 ? "PIN errado 5 vezes: travado por 5 minutos" : "PIN incorreto");
  }
  await saveDevice({ ...d, failedPins: 0, lockedUntil: 0 });
  unlockedUntil = Date.now() + 20_000;
}

export function lock() {
  unlockedUntil = 0;
}

export class WebCryptoSigner implements DescribedSigner {
  constructor(private readonly d: Pick<DeviceRecord, "privateKey" | "publicKey" | "deviceName">) {}
  async publicKey() {
    return new PublicKey(this.d.publicKey);
  }
  async sign(message: Uint8Array): Promise<Uint8Array> {
    if (Date.now() > unlockedUntil) throw new Error("confirme com biometria ou PIN antes de assinar");
    return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, this.d.privateKey, message as BufferSource));
  }
  describe(): SignerDescription {
    return { kind: "secure-store", hardwareBacked: false, label: this.d.deviceName };
  }
}

/** Signer só para a prova de posse, logo após gerar a chave (sem destravar). */
export class FreshKeySigner extends WebCryptoSigner {
  constructor(private readonly k: { privateKey: CryptoKey; publicKey: string }) {
    super({ ...k, deviceName: "novo" });
  }
  override async sign(message: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, this.k.privateKey, message as BufferSource));
  }
}
