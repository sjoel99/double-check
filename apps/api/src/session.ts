import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Sessão HTTP: diz QUEM está chamando, não autoriza nada. Toda operação que
 * move fundos ou muda chaves continua exigindo as assinaturas das chaves do
 * usuário (Phantom e chave do webapp).
 */
export type Session = { sub: string; acc: string; key: string; exp: number };

const b64u = (b: Buffer) => b.toString("base64url");

export function issueSession(secret: string, s: Session): string {
  const payload = b64u(Buffer.from(JSON.stringify(s)));
  const mac = b64u(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${mac}`;
}

export function readSession(secret: string, token: string | undefined, now: number): Session | null {
  if (!token) return null;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString()) as Session;
    return s.exp > now ? s : null;
  } catch {
    return null;
  }
}
