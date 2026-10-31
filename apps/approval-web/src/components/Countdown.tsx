import { useEffect, useState } from "react";
import { now } from "../lib/chain";
import { Icon } from "../icons";
import { tr } from "../lib/i18n";

/** Pílula mm:ss (tela de confirmação): fica âmbar no último minuto. */
export function Countdown({ until }: { until: number }) {
  const [t, setT] = useState(now());
  useEffect(() => {
    const i = setInterval(() => setT(now()), 1000);
    return () => clearInterval(i);
  }, []);
  const left = Math.max(0, until - t);
  return (
    <div className="pill mono" role="timer" aria-label={tr("Tempo restante para assinar", "Time left to sign")} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", border: "1px solid var(--line)", background: "var(--surface)", color: left < 60 ? "var(--warn)" : "var(--muted)", fontSize: 12 }}>
      <Icon name="clock" size={14} />
      {String(Math.floor(left / 60)).padStart(2, "0")}:{String(left % 60).padStart(2, "0")}
    </div>
  );
}

/** "12 h 05 min" (trocas de chave com prazo de horas). */
export function CountdownHours({ until }: { until: number }) {
  const [t, setT] = useState(now());
  useEffect(() => {
    const i = setInterval(() => setT(now()), 1000);
    return () => clearInterval(i);
  }, []);
  const left = Math.max(0, until - t);
  return <span className="mono">{left === 0 ? tr("agora", "now") : `${Math.floor(left / 3600)} h ${String(Math.floor((left % 3600) / 60)).padStart(2, "0")} min`}</span>;
}
