/**
 * Biometria de teste: um autenticador WebAuthn em software (ES256 do WebCrypto)
 * que produz as mesmas respostas de uma passkey de verdade (attestation "none",
 * user verification marcada). Serve aos testes e à "biometria de teste" do
 * ambiente local, como as carteiras de teste. O servidor verifica essas
 * respostas com o mesmo código que verifica as do celular.
 */

const subtle = () => globalThis.crypto.subtle;

export const b64url = (u: Uint8Array) => {
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

const utf8 = (s: string) => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const sha256 = async (b: Uint8Array) => new Uint8Array(await subtle().digest("SHA-256", b as BufferSource));
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

// CBOR mínimo: inteiros, bytes, texto e mapas — o que a attestation precisa.
type Cbor = number | Uint8Array | string | Map<Cbor, Cbor>;
function cborHead(major: number, n: number): Uint8Array {
  if (n < 24) return new Uint8Array([(major << 5) | n]);
  if (n < 256) return new Uint8Array([(major << 5) | 24, n]);
  if (n < 65536) return new Uint8Array([(major << 5) | 25, n >> 8, n & 255]);
  return concat(new Uint8Array([(major << 5) | 26]), u32(n));
}
function cbor(v: Cbor): Uint8Array {
  if (typeof v === "number") return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (typeof v === "string") {
    const b = utf8(v);
    return concat(cborHead(3, b.length), b);
  }
  if (v instanceof Uint8Array) return concat(cborHead(2, v.length), v);
  const parts: Uint8Array[] = [cborHead(5, v.size)];
  for (const [k, x] of v) parts.push(cbor(k), cbor(x));
  return concat(...parts);
}

/** WebCrypto devolve r||s; WebAuthn (ES256) quer ASN.1 DER. */
function derSignature(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.subarray(i);
    if (v[0]! & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const body = concat(int(raw.subarray(0, 32)), int(raw.subarray(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

export type SoftCredential = { id: string; privateKey: CryptoKey; counter: number };

export type RegistrationJSON = {
  id: string;
  rawId: string;
  type: "public-key";
  response: { clientDataJSON: string; attestationObject: string; transports: string[] };
  clientExtensionResults: Record<string, never>;
  authenticatorAttachment: "platform";
};

export type AuthenticationJSON = {
  id: string;
  rawId: string;
  type: "public-key";
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string };
  clientExtensionResults: Record<string, never>;
  authenticatorAttachment: "platform";
};

const FLAGS = { UP: 0x01, UV: 0x04, AT: 0x40 };

/** Cria a credencial (navigator.credentials.create). `challenge` em base64url, como nas opções do servidor. */
export async function softCreate(opts: { challenge: string; rpId: string; origin: string }): Promise<{ credential: SoftCredential; response: RegistrationJSON }> {
  const pair = (await subtle().generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle().exportKey("raw", pair.publicKey)); // 0x04 || x || y
  const credId = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const cose = cbor(new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, raw.subarray(1, 33)], [-3, raw.subarray(33, 65)]]));
  const authData = concat(
    await sha256(utf8(opts.rpId)),
    new Uint8Array([FLAGS.UP | FLAGS.UV | FLAGS.AT]),
    u32(0),
    new Uint8Array(16),
    new Uint8Array([0, credId.length]),
    credId,
    cose,
  );
  const clientData = utf8(JSON.stringify({ type: "webauthn.create", challenge: opts.challenge, origin: opts.origin, crossOrigin: false }));
  const attestation = cbor(new Map<Cbor, Cbor>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
  const id = b64url(credId);
  return {
    credential: { id, privateKey: pair.privateKey, counter: 0 },
    response: {
      id,
      rawId: id,
      type: "public-key",
      response: { clientDataJSON: b64url(clientData), attestationObject: b64url(attestation), transports: ["internal"] },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    },
  };
}

/** Confirma (navigator.credentials.get) com user verification. Atualiza o contador. */
export async function softGet(credential: SoftCredential, opts: { challenge: string; rpId: string; origin: string }): Promise<AuthenticationJSON> {
  credential.counter += 1;
  const authData = concat(await sha256(utf8(opts.rpId)), new Uint8Array([FLAGS.UP | FLAGS.UV]), u32(credential.counter));
  const clientData = utf8(JSON.stringify({ type: "webauthn.get", challenge: opts.challenge, origin: opts.origin, crossOrigin: false }));
  const raw = new Uint8Array(await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, credential.privateKey, concat(authData, await sha256(clientData)) as BufferSource));
  return {
    id: credential.id,
    rawId: credential.id,
    type: "public-key",
    response: { clientDataJSON: b64url(clientData), authenticatorData: b64url(authData), signature: b64url(derSignature(raw)) },
    clientExtensionResults: {},
    authenticatorAttachment: "platform",
  };
}

/** O desafio da confirmação de uma transação: sha256 dos bytes da mensagem, em base64url. */
export async function transactionChallenge(message: Uint8Array): Promise<string> {
  return b64url(await sha256(message));
}
