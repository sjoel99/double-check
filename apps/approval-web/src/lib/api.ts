import { loadSession } from "./storage";
import { lang } from "./i18n";
import { errorEn } from "./errors-en";

export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}

/** Mensagem do serviço pronta para a tela: sem "[CÓDIGO]" e com maiúscula no começo. */
export const sentence = (m: string) => {
  const t = String(m).replace(/^\[[A-Z0-9_]+\]\s*/, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

export async function api<T = any>(method: "GET" | "POST", path: string, body?: unknown, opts: { auth?: boolean } = { auth: true }): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (opts.auth !== false) {
    const s = await loadSession();
    if (s?.token) headers.authorization = `Bearer ${s.token}`;
  }
  const r = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const code: string = json.error ?? "HTTP";
    const pt = String(json.message ?? r.statusText);
    // Em inglês, a mensagem sai da tabela pelo código; código desconhecido fica com o texto do serviço.
    const message = (lang === "en" && errorEn(code, pt)) || pt;
    throw new ApiError(code, sentence(message), r.status);
  }
  return json as T;
}
