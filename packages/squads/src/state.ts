import { PublicKey } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { deny } from "@duplachave/shared";
import type { Chain } from "@duplachave/solana";

const { Multisig, Proposal } = multisig.accounts;

export const PERM = multisig.types.Permission;

export type MemberState = {
  key: string;
  mask: number;
  initiate: boolean;
  vote: boolean;
  execute: boolean;
};

/** Estado de segurança lido direto da chain. O banco nunca substitui isto. */
export type MultisigState = {
  address: string;
  createKey: string;
  configAuthority: string;
  threshold: number;
  timeLock: number;
  transactionIndex: bigint;
  staleTransactionIndex: bigint;
  rentCollector: string | null;
  members: MemberState[];
};

export function vaultPda(multisigAddress: PublicKey, index = 0): PublicKey {
  return multisig.getVaultPda({ multisigPda: multisigAddress, index })[0];
}

export function transactionPda(multisigAddress: PublicKey, index: bigint): PublicKey {
  return multisig.getTransactionPda({ multisigPda: multisigAddress, index })[0];
}

export function proposalPda(multisigAddress: PublicKey, index: bigint): PublicKey {
  return multisig.getProposalPda({ multisigPda: multisigAddress, transactionIndex: index })[0];
}

const toBig = (n: unknown) => BigInt((n as { toString(): string }).toString());

export async function readMultisig(chain: Chain, address: PublicKey): Promise<MultisigState> {
  const info = await chain.getAccountInfo(address);
  if (!info) deny("MULTISIG_NOT_FOUND", `multisig ${address.toBase58()} não existe`);
  if (!info.owner.equals(multisig.PROGRAM_ID)) deny("MULTISIG_WRONG_OWNER", "conta não pertence ao programa Squads v4");
  const [ms] = Multisig.fromAccountInfo(info);
  return {
    address: address.toBase58(),
    createKey: ms.createKey.toBase58(),
    configAuthority: ms.configAuthority.toBase58(),
    threshold: ms.threshold,
    timeLock: ms.timeLock,
    transactionIndex: toBig(ms.transactionIndex),
    staleTransactionIndex: toBig(ms.staleTransactionIndex),
    rentCollector: ms.rentCollector ? ms.rentCollector.toBase58() : null,
    members: ms.members.map((m) => ({
      key: m.key.toBase58(),
      mask: m.permissions.mask,
      initiate: (m.permissions.mask & PERM.Initiate) !== 0,
      vote: (m.permissions.mask & PERM.Vote) !== 0,
      execute: (m.permissions.mask & PERM.Execute) !== 0,
    })),
  };
}

export type ProposalState = {
  status: "Draft" | "Active" | "Rejected" | "Approved" | "Executing" | "Executed" | "Cancelled";
  timestamp: number | null;
  approved: string[];
  rejected: string[];
  cancelled: string[];
};

export async function readProposal(chain: Chain, ms: PublicKey, index: bigint): Promise<ProposalState | null> {
  const info = await chain.getAccountInfo(proposalPda(ms, index));
  if (!info) return null;
  const [p] = Proposal.fromAccountInfo(info);
  const status = p.status as { __kind: ProposalState["status"]; timestamp?: unknown };
  return {
    status: status.__kind,
    timestamp: status.timestamp !== undefined ? Number(toBig(status.timestamp)) : null,
    approved: p.approved.map((k) => k.toBase58()),
    rejected: p.rejected.map((k) => k.toBase58()),
    cancelled: p.cancelled.map((k) => k.toBase58()),
  };
}
