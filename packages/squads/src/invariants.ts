import { PublicKey } from "@solana/web3.js";
import { deny } from "@duplachave/shared";
import type { MultisigState } from "./state";

export type ExpectedRoles = {
  client: string;
  webapp: string;
  server: string;
  operator: string;
  timeLock?: number;
};

const DEFAULT_KEY = PublicKey.default.toBase58();

/**
 * Confere na chain o modelo 2 de 3: threshold 2; votam exatamente client,
 * webapp e server, cada um só com Vote (2); o operator só cria e executa (5);
 * sem config authority; sem time lock. Falha fechado em qualquer desvio.
 */
export function assertAccountModel(state: MultisigState, expected: ExpectedRoles): void {
  if (state.configAuthority !== DEFAULT_KEY)
    deny("CONFIG_AUTHORITY_SET", `multisig controlada por ${state.configAuthority}: uma chave sozinha mudaria membros`);
  if (state.threshold !== 2) deny("THRESHOLD_NOT_2", `threshold on-chain = ${state.threshold}`);

  const voters = state.members.filter((m) => m.vote).map((m) => m.key).sort();
  const expectedVoters = [expected.client, expected.webapp, expected.server].sort();
  if (voters.length !== 3 || voters.some((v, i) => v !== expectedVoters[i]))
    deny("VOTERS_MISMATCH", `votantes on-chain ${voters.join(",")} ≠ esperados ${expectedVoters.join(",")}`);

  const byKey = new Map(state.members.map((m) => [m.key, m]));
  for (const k of [expected.client, expected.webapp, expected.server])
    if (byKey.get(k)!.mask !== 2) deny("VOTER_PERMISSIONS", `votante ${k} com permissões ${byKey.get(k)!.mask} (esperado só Vote)`);
  const operator = byKey.get(expected.operator);
  if (!operator || operator.mask !== 5) deny("OPERATOR_MISMATCH", "operador ausente ou com permissões além de criar e executar");
  // Só o operador executa: nenhum votante pode rodar o que foi aprovado sem o serviço.
  if (state.members.filter((m) => m.mask & 4).length !== 1) deny("EXECUTOR_NOT_UNIQUE", "mais de um membro pode executar");

  if (state.members.length !== 4) deny("UNEXPECTED_MEMBERS", `${state.members.length} membros on-chain; esperado 4`);
  if ((expected.timeLock ?? 0) !== state.timeLock) deny("TIMELOCK_MISMATCH", `time lock on-chain = ${state.timeLock}`);
}
