import { useEffect } from "react";

const APP = "Double Check";

/** Título da aba por tela ("Enviar SOL · Double Check"): histórico e abas legíveis. */
export function useTitle(title: string | null | undefined) {
  useEffect(() => {
    document.title = title ? `${title} · ${APP}` : APP;
    return () => {
      document.title = APP;
    };
  }, [title]);
}
