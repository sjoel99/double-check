import type { PolicyDecision, TransactionIntent } from "@duplachave/shared";
import { ATA_PROGRAM, MEMO_PROGRAM, SYSTEM_PROGRAM, TOKEN_PROGRAM } from "@duplachave/solana";
import { compareIntent, type ConfigView, type VaultView } from "@duplachave/squads";

export type UserPolicy = {
  allowedPrograms: string[];
  allowedMints: string[];
  /** Teto por transação em lamports (SOL). */
  maxLamportsPerTx: bigint;
  /** Teto por transação, por mint, em unidades mínimas. */
  maxTokenPerTx: Record<string, bigint>;
  /** Endereços conhecidos do usuário. Fora daqui = destino externo. */
  addressBook: string[];
  /** Se true, destino externo é recusado; se false, só marcado. */
  requireAddressBook: boolean;
};

export type User = { id: string; policy: UserPolicy };

/** Contexto que a política não deve buscar sozinha (vem da chain, lido pelo chamador). */
export type PolicyContext = {
  vaultLamports: bigint;
  /** Chaves cuja posse foi provada nesta rotação (prova verificada pelo backend). */
  verifiedNewKeys: string[];
  /** Chaves que já foram membros e saíram. Nunca voltam. */
  revokedKeys: string[];
};

export type ParsedTransaction = VaultView | ConfigView;

export interface PolicyEngine {
  validate(user: User, intent: TransactionIntent, transaction: ParsedTransaction, ctx: PolicyContext): Promise<PolicyDecision>;
}

export const DEFAULT_POLICY: UserPolicy = {
  allowedPrograms: [SYSTEM_PROGRAM.toBase58(), TOKEN_PROGRAM.toBase58(), ATA_PROGRAM.toBase58(), MEMO_PROGRAM.toBase58()],
  allowedMints: [],
  maxLamportsPerTx: 50n * 1_000_000_000n,
  maxTokenPerTx: {},
  addressBook: [],
  requireAddressBook: false,
};

/**
 * Política padrão. Lista de permissão: o que não foi reconhecido é recusado.
 * `reasons` explica cada recusa; `riskFlags` vai para a tela de aprovação.
 */
export class DefaultPolicyEngine implements PolicyEngine {
  async validate(user: User, intent: TransactionIntent, tx: ParsedTransaction, ctx: PolicyContext): Promise<PolicyDecision> {
    const reasons: string[] = [];
    const flags = new Set<string>();
    const p = user.policy;

    // Nunca misturar operação financeira com mudança de segurança.
    if (intent.kind === "OPERATION" && tx.kind !== "VAULT") reasons.push("MIXED_KIND: operação apontando para ConfigTransaction");
    if (intent.kind === "CONFIG" && tx.kind !== "CONFIG") reasons.push("MIXED_KIND: mudança de segurança apontando para VaultTransaction");

    for (const d of compareIntent(intent, tx)) reasons.push(`INTENT_MISMATCH: ${d}`);

    if (tx.kind === "VAULT") this.vault(p, tx, ctx, reasons, flags);
    else this.config(tx, ctx, reasons, flags);

    return { allowed: reasons.length === 0, reasons, riskFlags: [...flags] };
  }

  private vault(p: UserPolicy, tx: VaultView, ctx: PolicyContext, reasons: string[], flags: Set<string>) {
    for (const prog of tx.programs) if (!p.allowedPrograms.includes(prog)) reasons.push(`PROGRAM_NOT_ALLOWED: ${prog}`);

    for (const ix of tx.instructions) {
      switch (ix.kind) {
        case "UNKNOWN":
        case "SYSTEM_OTHER":
        case "TOKEN_OTHER":
          reasons.push(`UNKNOWN_INSTRUCTION: ${ix.kind}`);
          break;
        case "SQUADS_CALL":
          reasons.push("MULTISIG_CONFIG_CHANGE: o vault chamando o programa da Squads");
          flags.add("MULTISIG_CONFIG_CHANGE");
          break;
        case "TOKEN_APPROVE":
          reasons.push(`DELEGATE_CREATION: delegate ${ix.delegate}`);
          flags.add("DELEGATE");
          break;
        case "TOKEN_SET_AUTHORITY":
        case "SYSTEM_ASSIGN":
          reasons.push(`AUTHORITY_CHANGE: ${ix.kind}`);
          flags.add("AUTHORITY_CHANGE");
          break;
        case "TOKEN_CLOSE_ACCOUNT":
          if (ix.destination !== tx.vault) reasons.push(`CLOSE_TO_EXTERNAL: ${ix.destination}`);
          break;
        case "TOKEN_TRANSFER_UNCHECKED":
          reasons.push("UNCHECKED_TRANSFER: use TransferChecked");
          break;
        case "SYSTEM_CREATE_ACCOUNT":
          reasons.push("CREATE_ACCOUNT_NOT_ALLOWED");
          break;
        default:
          break;
      }
    }

    const op = tx.operation;
    if (!op) {
      reasons.push("UNRECOGNIZED_OPERATION");
      return;
    }
    if (op.destination !== tx.vault && !p.addressBook.includes(op.destination)) {
      flags.add("EXTERNAL_DESTINATION");
      if (p.requireAddressBook) reasons.push(`DESTINATION_NOT_IN_ADDRESS_BOOK: ${op.destination}`);
    }
    if (op.type === "TRANSFER_SOL") {
      const amount = BigInt(op.amountLamports);
      if (amount === 0n) reasons.push("ZERO_AMOUNT");
      if (amount > p.maxLamportsPerTx) reasons.push(`LIMIT_EXCEEDED: ${amount} > ${p.maxLamportsPerTx} lamports`);
      if (ctx.vaultLamports > 0n && amount * 10n >= ctx.vaultLamports * 9n) flags.add("POSSIBLE_FULL_BALANCE");
    } else {
      if (!p.allowedMints.includes(op.mint)) reasons.push(`MINT_NOT_ALLOWED: ${op.mint}`);
      const max = p.maxTokenPerTx[op.mint];
      if (max !== undefined && BigInt(op.amount) > max) reasons.push(`LIMIT_EXCEEDED: ${op.amount} > ${max}`);
      if (BigInt(op.amount) === 0n) reasons.push("ZERO_AMOUNT");
    }
  }

  private config(tx: ConfigView, ctx: PolicyContext, reasons: string[], flags: Set<string>) {
    flags.add("SECURITY_CHANGE");
    for (const a of tx.actions) {
      if (a.kind === "AddSpendingLimit") reasons.push("SPENDING_LIMIT_FORBIDDEN: spending limit move fundos sem quórum");
      if (a.kind === "ChangeThreshold") reasons.push("THRESHOLD_CHANGE_FORBIDDEN");
      if (a.kind === "SetTimeLock") reasons.push("TIMELOCK_CHANGE_FORBIDDEN");
      if (a.kind === "RemoveSpendingLimit") reasons.push(`CONFIG_ACTION_FORBIDDEN: ${a.kind}`);
      // SetRentCollector só como parte da troca da carteira (configView confere que aponta para a nova).
      if (a.kind === "SetRentCollector" && tx.rotation?.role !== "CLIENT") reasons.push("CONFIG_ACTION_FORBIDDEN: SetRentCollector");
    }
    const r = tx.rotation;
    if (!r) {
      reasons.push("NOT_A_ROTATION: só [AddMember(nova, Vote), RemoveMember(atual)] é aceito");
      return;
    }
    if (!ctx.verifiedNewKeys.includes(r.newKey)) reasons.push(`NO_PROOF_OF_POSSESSION: ${r.newKey}`);
    if (ctx.revokedKeys.includes(r.newKey)) reasons.push(`REVOKED_KEY_REUSE: ${r.newKey}`);
    flags.add(r.role === "CLIENT" ? "CLIENT_KEY_ROTATION" : r.role === "WEBAPP" ? "WEBAPP_KEY_ROTATION" : "SERVER_KEY_ROTATION");
  }
}
