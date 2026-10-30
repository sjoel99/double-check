import { useCallback, useEffect, useState } from "react";
import { errorText, useApp } from "../app";
import { api } from "../lib/api";

export type ChangeView = {
  id: string;
  role: "CLIENT" | "WEBAPP" | "SERVER";
  oldKey: string;
  newKey: string;
  status: "PREPARED" | "PENDING" | "EXECUTED" | "VETOED" | "FAILED";
  index: string | null;
  createdAt: number;
  executeAfter: number | null;
};

/**
 * Trocas de chave da conta. Fica fora de `screens/security.tsx` para a Home
 * (que só precisa saber se há troca pendente) não puxar a tela de segurança
 * inteira para o chunk inicial.
 */
export function useChanges(pollMs = 8000) {
  const ctx = useApp();
  const [changes, setChanges] = useState<ChangeView[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const accountId = ctx.session?.accountId;
  const load = useCallback(async () => {
    if (!accountId) return;
    try {
      setChanges((await api<{ changes: ChangeView[] }>("GET", `/v1/accounts/${accountId}/security-changes`)).changes);
      setErr(null);
    } catch (e) {
      // O polling tenta de novo; a tela mostra que não carregou em vez de fingir que não há trocas.
      setErr(errorText(e));
    }
  }, [accountId]);
  useEffect(() => {
    void load();
    const i = setInterval(load, pollMs);
    return () => clearInterval(i);
  }, [load, pollMs]);
  return { changes, pending: changes.filter((c) => c.status === "PENDING"), err, reload: load };
}
