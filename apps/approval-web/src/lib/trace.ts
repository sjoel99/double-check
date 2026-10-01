/**
 * Rastro de diagnóstico do celular: o que a carteira fez (início, resposta,
 * erro) vai para o log do servidor. Só eventos e mensagens de erro — nunca
 * assinatura, chave ou conteúdo assinado.
 */
const startedAt = Date.now();

export function trace(event: string, detail?: unknown) {
  try {
    const d = detail instanceof Error ? `${detail.name}: ${detail.message}${detail.cause ? ` | causa: ${String((detail.cause as Error)?.message ?? detail.cause)}` : ""}` : detail === undefined ? "" : String(detail);
    void fetch("/api/v1/client-log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: event.slice(0, 60), detail: d.slice(0, 500), t: Math.round((Date.now() - startedAt) / 100) / 10 }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* diagnóstico nunca quebra o app */
  }
}
