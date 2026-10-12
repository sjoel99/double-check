import type { ReactNode } from "react";
import { useApp } from "../app";
import { Icon } from "../icons";
import { tr } from "../lib/i18n";

/** Barra do topo. `back={null}`: tela de aba (a barra de abas já navega). */
export function TopBar({ title, back = "/", right }: { title: string; back?: string | null; right?: ReactNode }) {
  const { go } = useApp();
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
