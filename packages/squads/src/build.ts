import { PublicKey, type TransactionInstruction, TransactionMessage } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { type Chain, connectionLike } from "@duplachave/solana";
import { PERM, vaultPda } from "./state";

const ix = multisig.instructions;
const { Permissions } = multisig.types;

/** As quatro chaves da multisig e o que cada uma pode fazer. */
export type MultisigLayout = {
  client: PublicKey;
  server: PublicKey;
  executor: PublicKey;
  proposer: PublicKey;
};

export function layoutMembers(layout: MultisigLayout): multisig.types.Member[] {
  return [
    { key: layout.client, permissions: Permissions.fromPermissions([PERM.Vote]) },
    { key: layout.server, permissions: Permissions.fromPermissions([PERM.Vote]) },
    { key: layout.executor, permissions: Permissions.fromPermissions([PERM.Execute]) },
    { key: layout.proposer, permissions: Permissions.fromPermissions([PERM.Initiate]) },
  ];
}

/**
 * Multisig STRICT_2_OF_2: threshold 2, dois votantes, sem config authority
 * (autônoma: toda mudança passa por votação), sem rent collector, sem time lock.
 */
export function createStrictMultisigIx(args: {
  createKey: PublicKey;
  creator: PublicKey;
  treasury: PublicKey;
  layout: MultisigLayout;
  timeLock?: number;
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
    rentCollector: null,
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
 * Troca de um votante numa única ConfigTransaction: [AddMember(nova), RemoveMember(antiga)].
 * As duas ações executam juntas; o invariant do programa só roda no fim, e
 * nenhum estado intermediário com três votantes chega a existir na chain.
 */
export function rotationActions(oldKey: PublicKey, newKey: PublicKey): multisig.types.ConfigAction[] {
  return [
    { __kind: "AddMember", newMember: { key: newKey, permissions: Permissions.fromPermissions([PERM.Vote]) } },
    { __kind: "RemoveMember", oldMember: oldKey },
  ];
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
