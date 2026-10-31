/** Valores que acompanham um erro para a tela montar a frase no idioma dela. Só material público. */
export type ErrorParams = Record<string, string | number | boolean | null>;

/**
 * Erro de segurança: sempre falha fechado, com código estável para teste e
 * auditoria. `message` é a frase em português (logs, e-mails, fallback da tela);
 * `params` são os valores que a frase usa, para o app montar o texto no idioma
 * dele sem interpretar o português (ex.: `{ status: "EXECUTED" }`, `{ limitLamports: "..." }`).
 */
export class SecurityError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly params: ErrorParams = {},
  ) {
    super(`[${code}] ${message}`);
    this.name = "SecurityError";
  }
}

export function deny(code: string, message: string, params?: ErrorParams): never {
  throw new SecurityError(code, message, params);
}
