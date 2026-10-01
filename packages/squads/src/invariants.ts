import { PublicKey } from "@solana/web3.js";
import { deny } from "@duplachave/shared";
import type { MultisigState } from "./state";

export type ExpectedRoles = {
  client: string;
  server: string;
  executor: string;
  proposer: string;
  timeLock?: number;
};

const DEFAULT_KEY = PublicKey.default.toBase58();

/**
 * Confere na chain o modelo STRICT_2_OF_2. Roda antes de qualquer aprovação do
 * servidor e depois de cada rotação. Falha fechado em qualquer desvio.
 */
export function assertStrictTwoOfTwo(state: MultisigState, expected: ExpectedRoles): void {
  if (state.configAuthority !== DEFAULT_KEY)
    deny("CONFIG_AUTHORITY_SET", `multisig controlada por ${state.configAuthority}: uma chave sozinha mudaria membros`);
  if (state.threshold !== 2) deny("THRESHOLD_NOT_2", `threshold on-chain = ${state.threshold}`);

  const voters = state.members.filter((m) => m.vote).map((m) => m.key).sort();
  const expectedVoters = [expected.client, expected.server].sort();
  if (voters.length !== 2 || voters[0] !== expectedVoters[0] || voters[1] !== expectedVoters[1])
    deny("VOTERS_MISMATCH", `votantes on-chain ${voters.join(",")} ≠ esperados ${expectedVoters.join(",")}`);

  const byKey = new Map(state.members.map((m) => [m.key, m]));
  const client = byKey.get(expected.client)!;
  const server = byKey.get(expected.server)!;
  if (client.mask !== 2 || server.mask !== 2) deny("VOTER_EXTRA_PERMISSIONS", "votantes devem ter só Vote");

  const executor = byKey.get(expected.executor);
  if (!executor || executor.mask !== 4) deny("EXECUTOR_MISMATCH", "executor ausente ou com permissões além de Execute");
  const proposer = byKey.get(expected.proposer);
  if (!proposer || proposer.mask !== 1) deny("PROPOSER_MISMATCH", "proposer ausente ou com permissões além de Initiate");

  if (state.members.length !== 4) deny("UNEXPECTED_MEMBERS", `${state.members.length} membros on-chain; esperado 4`);
  if ((expected.timeLock ?? 0) !== state.timeLock) deny("TIMELOCK_MISMATCH", `time lock on-chain = ${state.timeLock}`);
}

/** Papel de uma chave segundo a chain (não o banco). */
export function roleOf(state: MultisigState, key: string, expected: ExpectedRoles) {
  if (!state.members.some((m) => m.key === key)) return null;
  if (key === expected.client) return "CLIENT" as const;
  if (key === expected.server) return "SERVER" as const;
  if (key === expected.executor) return "EXECUTOR" as const;
  if (key === expected.proposer) return "PROPOSER" as const;
  return null;
}
