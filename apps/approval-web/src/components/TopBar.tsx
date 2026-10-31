import type { ReactNode } from "react";
import { useApp } from "../app";
import { Icon } from "../icons";
import { tr } from "../lib/i18n";
import { useTitle } from "../hooks/useTitle";

/** Barra do topo. `back={null}`: tela de aba (a barra de abas já navega). O título vai também para a aba do navegador. */
export function TopBar({ title, back = "/", right }: { title: string; back?: string | null; right?: ReactNode }) {
  const { go } = useApp();
  useTitle(title);
  return (
    <div className="topbar">
      {back !== null && (
        <button type="button" className="iconbtn" aria-label={tr("Voltar", "Back")} onClick={() => go(back)}>
          <Icon name="back" />
        </button>
      )}
      <h1>{title}</h1>
      {right}
    </div>
  );
}
