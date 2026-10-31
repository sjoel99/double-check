import { api } from "./api";

/** Conta: chave atual do webapp e multisig (do serviço; a conferência dos bytes usa a chain). */
export async function accountInfo(accountId: string) {
  const sec = await api("GET", `/v1/accounts/${accountId}/security`);
  return { multisig: sec.account.multisig as string, client: sec.account.roles.client as string, webapp: sec.account.roles.webapp as string };
}
