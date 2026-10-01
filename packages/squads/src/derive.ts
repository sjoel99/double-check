import { PublicKey } from "@solana/web3.js";
import type * as multisig from "@sqds/multisig";
import type { TransactionIntent } from "@duplachave/shared";
import { associatedTokenAddress, parseInstruction, type ParsedInstruction } from "@duplachave/solana";
import { vaultMessageInstructions, writableAccounts } from "./message";
import type { OnchainConfigTransaction, OnchainVaultTransaction, MultisigState } from "./state";
import type { ExpectedRoles } from "./invariants";

export type DerivedOperation =
  | { type: "TRANSFER_SOL"; amountLamports: string; destination: string }
  | { type: "TRANSFER_TOKEN"; mint: string; decimals: number; amount: string; destination: string };

export type VaultView = {
  kind: "VAULT";
  vault: string;
  instructions: ParsedInstruction[];
  programs: string[];
  writable: string[];
  /** null quando a transação não corresponde a nenhum formato conhecido. */
  operation: DerivedOperation | null;
};

export type NormalizedConfigAction =
  | { kind: "AddMember"; key: string; mask: number }
  | { kind: "RemoveMember"; key: string }
  | { kind: "ChangeThreshold"; threshold: number }
  | { kind: "SetTimeLock"; timeLock: number }
  | { kind: "AddSpendingLimit" }
  | { kind: "RemoveSpendingLimit" }
  | { kind: "SetRentCollector" };

export type DerivedRotation = { role: "CLIENT" | "WEBAPP" | "SERVER"; oldKey: string; newKey: string };

export type ConfigView = {
  kind: "CONFIG";
  actions: NormalizedConfigAction[];
  rotation: DerivedRotation | null;
};

/** O que a transação on-chain faz, reconstruído só a partir dos bytes da chain. */
export function viewVaultTransaction(tx: OnchainVaultTransaction, vault: PublicKey): VaultView {
  const raw = vaultMessageInstructions(tx.account);
  const instructions = raw.map(parseInstruction);
  const programs = [...new Set(raw.map((r) => r.programId.toBase58()))].sort();
  const v = vault.toBase58();
  return { kind: "VAULT", vault: v, instructions, programs, writable: writableAccounts(tx.account), operation: deriveOperation(instructions, vault) };
}

function deriveOperation(ixs: ParsedInstruction[], vault: PublicKey): DerivedOperation | null {
  const v = vault.toBase58();
  if (ixs.length === 1 && ixs[0]!.kind === "SYSTEM_TRANSFER") {
    const t = ixs[0]!;
    if (t.from !== v) return null;
    return { type: "TRANSFER_SOL", amountLamports: t.lamports.toString(), destination: t.to };
  }
  const last = ixs[ixs.length - 1];
  if (last?.kind === "TOKEN_TRANSFER_CHECKED" && (ixs.length === 1 || ixs.length === 2)) {
    const mint = new PublicKey(last.mint);
    const program = new PublicKey(last.program);
    if (last.authority !== v) return null;
    if (last.source !== associatedTokenAddress(vault, mint, program).toBase58()) return null;
    let destinationOwner: string | null = null;
    if (ixs.length === 2) {
      const create = ixs[0]!;
      if (create.kind !== "ATA_CREATE" || !create.idempotent || create.payer !== v || create.mint !== last.mint || create.ata !== last.destination)
        return null;
      destinationOwner = create.owner;
    } else {
      return null; // sem a criação da ATA não dá para provar o dono do destino a partir dos bytes
    }
    if (associatedTokenAddress(new PublicKey(destinationOwner), mint, program).toBase58() !== last.destination) return null;
    return { type: "TRANSFER_TOKEN", mint: last.mint, decimals: last.decimals, amount: last.amount.toString(), destination: destinationOwner };
  }
  return null;
}

export function normalizeConfigActions(actions: multisig.types.ConfigAction[]): NormalizedConfigAction[] {
  return actions.map((a) => {
    switch (a.__kind) {
      case "AddMember":
        return { kind: "AddMember", key: a.newMember.key.toBase58(), mask: a.newMember.permissions.mask };
      case "RemoveMember":
        return { kind: "RemoveMember", key: a.oldMember.toBase58() };
      case "ChangeThreshold":
        return { kind: "ChangeThreshold", threshold: a.newThreshold };
      case "SetTimeLock":
        return { kind: "SetTimeLock", timeLock: a.newTimeLock };
      case "AddSpendingLimit":
        return { kind: "AddSpendingLimit" };
      case "RemoveSpendingLimit":
        return { kind: "RemoveSpendingLimit" };
      default:
        return { kind: "SetRentCollector" };
    }
  });
}

/**
 * Únicas ConfigTransactions aceitas (a troca de uma chave, numa transação só):
 *   Phantom: [AddMember(nova, Vote), RemoveMember(atual), SetRentCollector(nova)]
 *   webapp:  [AddMember(nova, Vote), RemoveMember(atual)]
 *   serviço: [AddMember(nova, Vote), RemoveMember(atual)]
 * Qualquer outra forma devolve rotation = null e a política recusa.
 */
export function configView(rawActions: multisig.types.ConfigAction[], state: MultisigState, roles: ExpectedRoles): ConfigView {
  const actions = normalizeConfigActions(rawActions);
  let rotation: DerivedRotation | null = null;
  const [add, remove, third] = actions;
  if (add?.kind === "AddMember" && remove?.kind === "RemoveMember") {
    const role = remove.key === roles.client ? "CLIENT" : remove.key === roles.webapp ? "WEBAPP" : remove.key === roles.server ? "SERVER" : null;
    const isNew = !state.members.some((m) => m.key === add.key);
    const shapeOk =
      role === "CLIENT"
        ? actions.length === 3 && add.mask === 2 && third?.kind === "SetRentCollector" && rawActions[2]?.__kind === "SetRentCollector" && (rawActions[2] as { newRentCollector: PublicKey | null }).newRentCollector?.toBase58() === add.key
        : role === "WEBAPP" || role === "SERVER"
          ? actions.length === 2 && add.mask === 2
          : false;
    if (role && isNew && shapeOk) rotation = { role, oldKey: remove.key, newKey: add.key };
  }
  return { kind: "CONFIG", actions, rotation };
}

export function viewConfigTransaction(tx: OnchainConfigTransaction, state: MultisigState, roles: ExpectedRoles): ConfigView {
  return configView(tx.actions, state, roles);
}

/** Diferenças entre a intenção e o que a chain contém. Vazio = idênticas. */
export function compareIntent(intent: TransactionIntent, view: VaultView | ConfigView): string[] {
  const diffs: string[] = [];
  const eq = (field: string, a: unknown, b: unknown) => {
    if (a !== b) diffs.push(`${field}: intenção=${String(a)} chain=${String(b)}`);
  };
  if (intent.kind === "OPERATION") {
    if (view.kind !== "VAULT") return ["intenção de operação, mas a chain tem ConfigTransaction"];
    eq("vault", intent.vault, view.vault);
    eq("programs", [...intent.programs].sort().join(","), view.programs.join(","));
    const op = view.operation;
    if (!op) return [...diffs, "transação on-chain não corresponde a nenhum formato conhecido"];
    eq("type", intent.type, op.type);
    eq("destination", intent.destination, op.destination);
    if (intent.type === "TRANSFER_SOL" && op.type === "TRANSFER_SOL") eq("amountLamports", intent.amountLamports, op.amountLamports);
    if (intent.type === "TRANSFER_TOKEN" && op.type === "TRANSFER_TOKEN") {
      eq("mint", intent.mint, op.mint);
      eq("amount", intent.amount, op.amount);
      eq("decimals", intent.decimals, op.decimals);
    }
    return diffs;
  }
  if (view.kind !== "CONFIG") return ["intenção de segurança, mas a chain tem VaultTransaction"];
  if (!view.rotation) return ["ConfigTransaction on-chain não é uma rotação válida"];
  eq("role", intent.role, view.rotation.role);
  eq("oldKey", intent.oldKey, view.rotation.oldKey);
  eq("newKey", intent.newKey, view.rotation.newKey);
  return diffs;
}
