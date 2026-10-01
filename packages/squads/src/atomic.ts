import { type PublicKey, type TransactionInstruction, TransactionMessage, type VersionedMessage } from "@solana/web3.js";
import type { RawInstruction } from "@duplachave/solana";
import * as multisig from "@sqds/multisig";
import { getProposalPda, getTransactionPda, getVaultPda } from "@sqds/multisig";

/**
 * Transação atômica: criar a proposta, voto do servidor, voto da carteira e
 * execução — tudo numa transação só, paga pela carteira do cliente.
 *
 * - O servidor (e o proponente) assinam antes; a carteira assina por último e paga
 *   taxa e rent. O sistema não gasta SOL.
 * - Nada fica pendente na chain: ou tudo acontece, ou nada. Sem proposta aberta,
 *   sem aprovada-não-executada, sem stale.
 * - A assinatura do servidor cobre os bytes exatos da transação final.
 * - Expira sozinha: o blockhash vale ~60–90 s.
 */
export type AtomicVaultArgs = {
  multisig: PublicKey;
  index: bigint;
  proposer: PublicKey;
  server: PublicKey;
  wallet: PublicKey;
  instructions: TransactionInstruction[];
  memo?: string;
  /**
   * Fecha as contas no fim, devolvendo o rent para a carteira. Só quando o
   * rent_collector da multisig é a carteira (contas antigas não têm um: o rent
   * fica nas contas da proposta).
   */
  close?: boolean;
};

export function atomicVaultInstructions(a: AtomicVaultArgs): TransactionInstruction[] {
  const [vault] = getVaultPda({ multisigPda: a.multisig, index: 0 });
  const [transactionPda] = getTransactionPda({ multisigPda: a.multisig, index: a.index });
  const [proposalPda] = getProposalPda({ multisigPda: a.multisig, transactionIndex: a.index });
  // O blockhash da mensagem interna não é usado pelo programa (a execução usa o da transação externa).
  const inner = new TransactionMessage({ payerKey: vault, recentBlockhash: "11111111111111111111111111111111", instructions: a.instructions });

  const create = multisig.instructions.vaultTransactionCreate({
    multisigPda: a.multisig,
    transactionIndex: a.index,
    creator: a.proposer,
    rentPayer: a.wallet,
    vaultIndex: 0,
    ephemeralSigners: 0,
    transactionMessage: inner,
    memo: a.memo,
  });
  const proposal = multisig.instructions.proposalCreate({ multisigPda: a.multisig, transactionIndex: a.index, creator: a.proposer, rentPayer: a.wallet });
  const approveServer = multisig.instructions.proposalApprove({ multisigPda: a.multisig, transactionIndex: a.index, member: a.server });
  const approveWallet = multisig.instructions.proposalApprove({ multisigPda: a.multisig, transactionIndex: a.index, member: a.wallet });

  // Contas da execução, calculadas da mensagem (a VaultTransaction ainda não existe).
  const bytes = multisig.utils.transactionMessageToMultisigTransactionMessageBytes({ message: inner, vaultPda: vault });
  const [msg] = multisig.types.transactionMessageBeet.deserialize(Buffer.from(bytes));
  const isWritable = (i: number) => (i < msg.numSigners ? i < msg.numWritableSigners : i - msg.numSigners < msg.numWritableNonSigners);
  const remaining = msg.accountKeys.map((key, i) => ({ pubkey: key, isWritable: isWritable(i), isSigner: i < msg.numSigners && !key.equals(vault) }));
  const execute = multisig.generated.createVaultTransactionExecuteInstruction(
    { multisig: a.multisig, member: a.wallet, proposal: proposalPda, transaction: transactionPda, anchorRemainingAccounts: remaining },
    multisig.PROGRAM_ID,
  );
  // Fecha as contas da proposta já executada: o rent volta para o rent collector (a carteira).
  const out = [create, proposal, approveServer, approveWallet, execute];
  if (a.close !== false) out.push(multisig.instructions.vaultTransactionAccountsClose({ multisigPda: a.multisig, rentCollector: a.wallet, transactionIndex: a.index }));
  return out;
}

export type AtomicConfigArgs = {
  multisig: PublicKey;
  index: bigint;
  proposer: PublicKey;
  server: PublicKey;
  wallet: PublicKey;
  actions: multisig.types.ConfigAction[];
  memo?: string;
};

/**
 * Mudança de segurança atômica: a carteira atual também executa (tem Execute).
 * `rentCollector`: quem recebe o rent ao fechar — depois da troca de carteira, a nova;
 * null = não fecha (multisig antiga sem rent_collector).
 */
export function atomicConfigInstructions(a: AtomicConfigArgs & { rentCollector: PublicKey | null }): TransactionInstruction[] {
  const out = [
    multisig.instructions.configTransactionCreate({ multisigPda: a.multisig, transactionIndex: a.index, creator: a.proposer, rentPayer: a.wallet, actions: a.actions, memo: a.memo }),
    multisig.instructions.proposalCreate({ multisigPda: a.multisig, transactionIndex: a.index, creator: a.proposer, rentPayer: a.wallet }),
    multisig.instructions.proposalApprove({ multisigPda: a.multisig, transactionIndex: a.index, member: a.server }),
    multisig.instructions.proposalApprove({ multisigPda: a.multisig, transactionIndex: a.index, member: a.wallet }),
    multisig.instructions.configTransactionExecute({ multisigPda: a.multisig, transactionIndex: a.index, member: a.wallet, rentPayer: a.wallet }),
  ];
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
