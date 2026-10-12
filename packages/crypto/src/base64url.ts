/** base64url sem padding (WebAuthn, IDs de credencial e a chave do webapp cifrada). */
export const b64url = (u: Uint8Array) => {
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
