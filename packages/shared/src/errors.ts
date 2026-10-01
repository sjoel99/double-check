/** Erro de segurança: sempre falha fechado, com código estável para teste e auditoria. */
export class SecurityError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "SecurityError";
  }
}

export function deny(code: string, message: string): never {
  throw new SecurityError(code, message);
}
