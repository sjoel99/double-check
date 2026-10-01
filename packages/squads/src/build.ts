import { PublicKey, type TransactionInstruction, TransactionMessage } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { type Chain, connectionLike } from "@duplachave/solana";
import { PERM, vaultPda } from "./state";

const ix = multisig.instructions;
const { Permissions } = multisig.types;

/**
 * As quatro chaves da multisig 2 de 3:
 * - client: a Phantom do usuário (vota);
 * - webapp: a chave do webapp, guardada cifrada e destravada pela biometria (vota);
 * - server: a chave do serviço (vota — só em recuperação, e com prazo);
 * - operator: do serviço, cria e é o ÚNICO que executa (não vota).
 * Votar e executar são permissões separadas na Squads: como só o operador
 * executa, nada aprovado roda sem o serviço conferir a política (e o prazo).
 */
export type MultisigLayout = {
  client: PublicKey;
  webapp: PublicKey;
  server: PublicKey;
  operator: PublicKey;
};

export const VOTER_MASK = PERM.Vote;
export const OPERATOR_MASK = PERM.Initiate | PERM.Execute;
/** Compatibilidade de nomes: todos os votantes têm só Vote. */
export const CLIENT_MASK = VOTER_MASK;
export const SERVER_MASK = VOTER_MASK;

export function layoutMembers(layout: MultisigLayout): multisig.types.Member[] {
  return [
    { key: layout.client, permissions: Permissions.fromPermissions([PERM.Vote]) },
    { key: layout.webapp, permissions: Permissions.fromPermissions([PERM.Vote]) },
    { key: layout.server, permissions: Permissions.fromPermissions([PERM.Vote]) },
    { key: layout.operator, permissions: Permissions.fromPermissions([PERM.Initiate, PERM.Execute]) },
  ];
}

/**
 * Multisig 2 de 3: threshold 2 entre client, webapp e server; operator cria e
 * executa; sem config authority (toda mudança passa por votação), sem time lock
 * (o prazo das trocas é imposto pelo operador, o único que executa), rent de
 * volta para a Phantom.
 */
export function createStrictMultisigIx(args: {
  createKey: PublicKey;
  creator: PublicKey;
  treasury: PublicKey;
  layout: MultisigLayout;
  timeLock?: number;
  /** Recebe o rent das contas de proposta fechadas. Padrão: a Phantom. */
  rentCollector?: PublicKey | null;
}): { instruction: TransactionInstruction; multisig: PublicKey; vault: PublicKey } {
  const [msPda] = multisig.getMultisigPda({ createKey: args.createKey });
  const instruction = ix.multisigCreateV2({
    treasury: args.treasury,
    creator: args.creator,
    multisigPda: msPda,
    configAuthority: null,
    threshold: 2,
    members: layoutMembers(args.layout),
    timeLock: args.timeLock ?? 0,
    createKey: args.createKey,
    rentCollector: args.rentCollector === undefined ? args.layout.client : args.rentCollector,
  });
  return { instruction, multisig: msPda, vault: vaultPda(msPda, 0) };
}

/** VaultTransaction + Proposal na mesma transação, criadas pelo proposer. */
export function createVaultProposalIxs(args: {
  multisig: PublicKey;
  index: bigint;
  proposer: PublicKey;
  rentPayer: PublicKey;
  instructions: TransactionInstruction[];
  recentBlockhash: string;
  memo?: string;
}): TransactionInstruction[] {
  const vault = vaultPda(args.multisig, 0);
  const message = new TransactionMessage({
    payerKey: vault,
    recentBlockhash: args.recentBlockhash,
    instructions: args.instructions,
  });
  return [
    ix.vaultTransactionCreate({
      multisigPda: args.multisig,
      transactionIndex: args.index,
      creator: args.proposer,
      rentPayer: args.rentPayer,
      vaultIndex: 0,
      ephemeralSigners: 0,
      transactionMessage: message,
      memo: args.memo,
    }),
    ix.proposalCreate({
      multisigPda: args.multisig,
      transactionIndex: args.index,
      creator: args.proposer,
      rentPayer: args.rentPayer,
    }),
  ];
}

export function createConfigProposalIxs(args: {
  multisig: PublicKey;
  index: bigint;
  proposer: PublicKey;
  rentPayer: PublicKey;
  actions: multisig.types.ConfigAction[];
  memo?: string;
}): TransactionInstruction[] {
  return [
    ix.configTransactionCreate({
      multisigPda: args.multisig,
      transactionIndex: args.index,
      creator: args.proposer,
      rentPayer: args.rentPayer,
      actions: args.actions,
      memo: args.memo,
    }),
    ix.proposalCreate({
      multisigPda: args.multisig,
      transactionIndex: args.index,
      creator: args.proposer,
      rentPayer: args.rentPayer,
    }),
  ];
}

/**
 * Troca de um votante numa única ConfigTransaction: [AddMember(nova, Vote),
 * RemoveMember(antiga)] — e, na troca da Phantom, SetRentCollector(nova). As
 * ações executam juntas; o invariant do programa só roda no fim.
 */
export type RotationRole = "CLIENT" | "WEBAPP" | "SERVER";

export function rotationActions(oldKey: PublicKey, newKey: PublicKey, role: RotationRole = "CLIENT"): multisig.types.ConfigAction[] {
  const actions: multisig.types.ConfigAction[] = [
    { __kind: "AddMember", newMember: { key: newKey, permissions: Permissions.fromPermissions([PERM.Vote]) } },
    { __kind: "RemoveMember", oldMember: oldKey },
  ];
  if (role === "CLIENT") actions.push({ __kind: "SetRentCollector", newRentCollector: newKey });
  return actions;
}

/** Memo da aprovação: liga o voto on-chain à intenção (auditoria). */
export function approvalMemo(intentHash: string, transactionHash: string): string {
  return `dk1:${intentHash.slice(0, 32)}:${transactionHash.slice(0, 32)}`;
}

export function approveIx(ms: PublicKey, index: bigint, member: PublicKey, memo?: string) {
  return ix.proposalApprove({ multisigPda: ms, transactionIndex: index, member, memo });
}

export function rejectIx(ms: PublicKey, index: bigint, member: PublicKey, memo?: string) {
  return ix.proposalReject({ multisigPda: ms, transactionIndex: index, member, memo });
}

export function cancelIx(ms: PublicKey, index: bigint, member: PublicKey, memo?: string) {
  return ix.proposalCancel({ multisigPda: ms, transactionIndex: index, member, memo });
}

export async function executeVaultIx(chain: Chain, ms: PublicKey, index: bigint, executor: PublicKey) {
  return ix.vaultTransactionExecute({
    connection: connectionLike(chain),
    multisigPda: ms,
    transactionIndex: index,
    member: executor,
  });
}

export function executeConfigIx(ms: PublicKey, index: bigint, executor: PublicKey, rentPayer: PublicKey) {
  return ix.configTransactionExecute({ multisigPda: ms, transactionIndex: index, member: executor, rentPayer });
}
