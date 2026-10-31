import { loadSession } from "./storage";
import { tr } from "./i18n";
import { errorMessage, type Params, sentence } from "./errors";

export { sentence };

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    /** Valores que acompanham o código (ex.: `{ status }`), para quem quiser decidir por eles. */
    public readonly params: Params = {},
  ) {
    super(message);
  }
}

/** Um pedido pendurado (upstream fora, rede ruim) não pode deixar a tela em "assinando…" para sempre. */
const TIMEOUT_MS = 15_000;

/**
 * Sessão vencida ou de outra carteira: QUALQUER 401 numa chamada que levou o
 * token derruba a sessão num lugar só, em vez de cada tela tratar (ou não).
 * Quem gere a sessão registra o tratador; `null` desregistra.
 */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): () => void {
  onUnauthorized = fn;
  return () => {
    if (onUnauthorized === fn) onUnauthorized = null;
  };
}

/** Resposta sem JSON (HTML do nginx, por exemplo): o texto vem do status, não do `statusText` em inglês. */
function httpText(status: number): string {
  if (status === 502 || status === 503 || status === 504) return tr("O serviço está fora do ar neste momento. Tente de novo em instantes.", "The service is down right now. Try again in a moment.");
  if (status === 429) return tr("Muitas tentativas em pouco tempo. Espere um minuto e tente de novo.", "Too many attempts in a short time. Wait a minute and try again.");
  if (status === 404) return tr("Não encontrado.", "Not found.");
  if (status === 401) return tr("Sessão inválida. Entre de novo.", "Invalid session. Sign in again.");
  if (status === 413) return tr("Pedido grande demais.", "Request too large.");
  return tr(`Erro ${status} do serviço.`, `Service error ${status}.`);
}

// O default `any` é deliberado: a maioria das chamadas tipa com api<T>; as poucas sem tipo são dev/one-shot.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function api<T = any>(method: "GET" | "POST", path: string, body?: unknown, opts: { auth?: boolean } = { auth: true }): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (opts.auth !== false) {
    const s = await loadSession();
    if (s?.token) headers.authorization = `Bearer ${s.token}`;
  }
  let r: Response;
  try {
    const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
    r = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === "TimeoutError" || name === "AbortError") throw new ApiError("TIMEOUT", tr("O serviço não respondeu a tempo. Tente de novo.", "The service did not respond in time. Try again."), 0);
    // `fetch` só lança TypeError por falha de rede (sem conexão, DNS, túnel caído).
    throw new ApiError("NETWORK", tr("Sem conexão com o serviço. Confira a internet e tente de novo.", "No connection to the service. Check your internet and try again."), 0);
  }
  const json: { error?: string; message?: string; params?: Params } | null = await r.json().catch(() => null);
  if (!r.ok) {
    // Só quando o pedido levou o token: um 401 de quem nem tinha sessão não é "sessão vencida".
    if (r.status === 401 && headers.authorization) onUnauthorized?.();
    const code: string = json?.error ?? "HTTP";
    // A frase vem do código e dos parâmetros, no idioma do app; o texto do serviço só é fallback.
    const message = json?.message !== undefined ? errorMessage(code, json.params, String(json.message)) : httpText(r.status);
    throw new ApiError(code, message, r.status, json?.params ?? {});
  }
  return (json ?? {}) as T;
}
