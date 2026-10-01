import { type PublicKey, type TransactionInstruction, TransactionMessage, type VersionedMessage } from "@solana/web3.js";
import type { RawInstruction } from "@duplachave/solana";
import * as multisig from "@sqds/multisig";
import { getProposalPda, getTransactionPda, getVaultPda } from "@sqds/multisig";

/**
 * Operação atômica (2 de 3, operador executa): criar a proposta, os dois votos
 * (Phantom + webapp) e a execução pelo operador — numa transação só, paga pela
 * Phantom.
 *
 * - O operador (serviço) assina por último no servidor, só depois de conferir a
 *   política e a assinatura do webapp (que só existe com a biometria).
 * - Nada fica pendente na chain: ou tudo acontece, ou nada.
 * - Expira sozinha: o blockhash vale ~60–90 s.
 */
export type AtomicVaultArgs = {
  multisig: PublicKey;
  index: bigint;
  /** Membro com criar + executar (serviço). */
  operator: PublicKey;
  /** Os dois votos: normalmente [Phantom, webapp]. */
  voters: [PublicKey, PublicKey];
  /** Paga rent e taxa (a Phantom). */
  payer: PublicKey;
  instructions: TransactionInstruction[];
  memo?: string;
  /** Recebe o rent ao fechar; null = não fecha (multisig sem rent_collector). */
  rentCollector: PublicKey | null;
};

export function atomicVaultInstructions(a: AtomicVaultArgs): TransactionInstruction[] {
  const [vault] = getVaultPda({ multisigPda: a.multisig, index: 0 });
  const [transactionPda] = getTransactionPda({ multisigPda: a.multisig, index: a.index });
  const [proposalPda] = getProposalPda({ multisigPda: a.multisig, transactionIndex: a.index });
  // O blockhash da mensagem interna não é usado pelo programa (a execução usa o da transação externa).
  const inner = new TransactionMessage({ payerKey: vault, recentBlockhash: "11111111111111111111111111111111", instructions: a.instructions });

  const out: TransactionInstruction[] = [
    multisig.instructions.vaultTransactionCreate({
      multisigPda: a.multisig,
      transactionIndex: a.index,
      creator: a.operator,
      rentPayer: a.payer,
      vaultIndex: 0,
      ephemeralSigners: 0,
      transactionMessage: inner,
      memo: a.memo,
    }),
    multisig.instructions.proposalCreate({ multisigPda: a.multisig, transactionIndex: a.index, creator: a.operator, rentPayer: a.payer }),
    ...a.voters.map((member) => multisig.instructions.proposalApprove({ multisigPda: a.multisig, transactionIndex: a.index, member })),
  ];

  // Contas da execução, calculadas da mensagem (a VaultTransaction ainda não existe).
  const bytes = multisig.utils.transactionMessageToMultisigTransactionMessageBytes({ message: inner, vaultPda: vault });
  const [msg] = multisig.types.transactionMessageBeet.deserialize(Buffer.from(bytes));
  const isWritable = (i: number) => (i < msg.numSigners ? i < msg.numWritableSigners : i - msg.numSigners < msg.numWritableNonSigners);
  const remaining = msg.accountKeys.map((key, i) => ({ pubkey: key, isWritable: isWritable(i), isSigner: i < msg.numSigners && !key.equals(vault) }));
  out.push(
    multisig.generated.createVaultTransactionExecuteInstruction(
      { multisig: a.multisig, member: a.operator, proposal: proposalPda, transaction: transactionPda, anchorRemainingAccounts: remaining },
      multisig.PROGRAM_ID,
    ),
  );
  if (a.rentCollector) out.push(multisig.instructions.vaultTransactionAccountsClose({ multisigPda: a.multisig, rentCollector: a.rentCollector, transactionIndex: a.index }));
  return out;
}

/**
 * Pedido de troca de chave (passo 1 de 2): cria a ConfigTransaction e os dois
 * votos agora. A execução (passo 2) só o operador faz, depois do prazo.
 */
export function configRequestInstructions(a: {
  multisig: PublicKey;
  index: bigint;
  operator: PublicKey;
  voters: [PublicKey, PublicKey];
  payer: PublicKey;
  actions: multisig.types.ConfigAction[];
  memo?: string;
}): TransactionInstruction[] {
  return [
    multisig.instructions.configTransactionCreate({ multisigPda: a.multisig, transactionIndex: a.index, creator: a.operator, rentPayer: a.payer, actions: a.actions, memo: a.memo }),
    multisig.instructions.proposalCreate({ multisigPda: a.multisig, transactionIndex: a.index, creator: a.operator, rentPayer: a.payer }),
    ...a.voters.map((member) => multisig.instructions.proposalApprove({ multisigPda: a.multisig, transactionIndex: a.index, member })),
  ];
}

/** Passo 2: o operador executa a troca aprovada e fecha as contas. */
export function configExecuteInstructions(a: { multisig: PublicKey; index: bigint; operator: PublicKey; payer: PublicKey; rentCollector: PublicKey | null }): TransactionInstruction[] {
  const out = [multisig.instructions.configTransactionExecute({ multisigPda: a.multisig, transactionIndex: a.index, member: a.operator, rentPayer: a.payer })];
  if (a.rentCollector) out.push(multisig.instructions.configTransactionAccountsClose({ multisigPda: a.multisig, rentCollector: a.rentCollector, transactionIndex: a.index }));
  return out;
}

/** "Não fui eu": dois votantes cancelam a troca aprovada (e o rent volta). */
export function configCancelInstructions(a: { multisig: PublicKey; index: bigint; voters: [PublicKey, PublicKey]; rentCollector: PublicKey | null }): TransactionInstruction[] {
  const out = a.voters.map((member) => multisig.instructions.proposalCancel({ multisigPda: a.multisig, transactionIndex: a.index, member }));
  if (a.rentCollector) out.push(multisig.instructions.configTransactionAccountsClose({ multisigPda: a.multisig, rentCollector: a.rentCollector, transactionIndex: a.index }));
  return out;
}

/**
 * O que a transação atômica faz de verdade com o Vault: as instruções da
 * mensagem embutida no vault_transaction_create. Serve para a tela de bloqueio
 * mostrar o que um servidor adulterado tentou passar.
 */
export function innerVaultInstructions(message: VersionedMessage): RawInstruction[] | null {
  const keys = message.staticAccountKeys;
  const disc = Buffer.from(multisig.generated.vaultTransactionCreateInstructionDiscriminator);
  for (const ix of message.compiledInstructions) {
    if (!keys[ix.programIdIndex]?.equals(multisig.PROGRAM_ID)) continue;
    const data = Buffer.from(ix.data);
    if (!data.subarray(0, 8).equals(disc)) continue;
    try {
      const [{ args }] = multisig.generated.vaultTransactionCreateStruct.deserialize(data);
      const [inner] = multisig.types.transactionMessageBeet.deserialize(Buffer.from(args.transactionMessage));
      const isWritable = (i: number) => (i < inner.numSigners ? i < inner.numWritableSigners : i - inner.numSigners < inner.numWritableNonSigners);
      return inner.instructions.map((c) => ({
        programId: inner.accountKeys[c.programIdIndex]!,
        keys: [...c.accountIndexes].map((i) => ({ pubkey: inner.accountKeys[i]!, isSigner: i < inner.numSigners, isWritable: isWritable(i) })),
        data: new Uint8Array(c.data),
      }));
    } catch {
      return null;
    }
  }
  return null;
}
