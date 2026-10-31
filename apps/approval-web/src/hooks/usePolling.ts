import { useEffect } from "react";

/**
 * Chama `fn` agora e a cada `ms`, só enquanto a aba está visível. Ao voltar
 * para a aba, chama na hora: a pessoa vê o estado atual sem esperar o próximo tique.
 * `fn` precisa ter identidade estável (useCallback), senão o ciclo reinicia a cada render.
 */
export function usePolling(fn: () => unknown, ms: number, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      void fn();
    };
    tick();
    const i = setInterval(tick, ms);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(i);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [fn, ms, enabled]);
}
