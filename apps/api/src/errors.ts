/** Erro HTTP com código estável (sessão, permissão): a tela traduz pelo código, não pela frase. */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
