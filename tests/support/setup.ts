import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { DevMemorySigner, type Signer } from "@duplachave/crypto";
import { ChainTxError, sendInstructions } from "@duplachave/solana";
import {
  approveIx,
  createConfigProposalIxs,
  createStrictMultisigIx,
  createVaultProposalIxs,
  executeConfigIx,
  executeVaultIx,
  readMultisig,
} from "@duplachave/squads";
import type * as multisig from "@sqds/multisig";
import { LiteSvmChain } from "./litesvm-chain";

export type Keys = {
  client: DevMemorySigner;
  server: DevMemorySigner;
  executor: DevMemorySigner;
  proposer: DevMemorySigner;
  /** Paga taxas; não é membro. */
  relayer: DevMemorySigner;
};

export async function setupStrict(depositSol = 10, opts: { rentCollector?: null } = {}) {
  const chain = new LiteSvmChain();
  const keys: Keys = {
    client: DevMemorySigner.generate("CLIENT_A"),
    server: DevMemorySigner.generate("SERVER_A"),
    executor: DevMemorySigner.generate("EXECUTOR"),
    proposer: DevMemorySigner.generate("OPERATIONAL_WALLET"),
    relayer: DevMemorySigner.generate("RELAYER"),
  };
  for (const s of Object.values(keys)) chain.airdrop(await s.publicKey(), 5n * BigInt(LAMPORTS_PER_SOL));

  const createKey = DevMemorySigner.generate("createKey");
  const layout = {
    client: await keys.client.publicKey(),
    server: await keys.server.publicKey(),
    executor: await keys.executor.publicKey(),
    proposer: await keys.proposer.publicKey(),
  };
  const created = createStrictMultisigIx({
    createKey: await createKey.publicKey(),
    creator: await keys.relayer.publicKey(),
    treasury: chain.treasury,
    layout,
    ...(opts.rentCollector === null ? { rentCollector: null } : {}),
  });
  await sendInstructions(chain, [created.instruction], [keys.relayer, createKey]);
  const vault = created.vault;
  chain.airdrop(vault, BigInt(depositSol * LAMPORTS_PER_SOL));
  return { chain, keys, layout, multisig: created.multisig, vault };
}

export type Ctx = Awaited<ReturnType<typeof setupStrict>>;

export async function nextIndex(ctx: Ctx) {
  return (await readMultisig(ctx.chain, ctx.multisig)).transactionIndex + 1n;
}

export async function proposeTransfer(ctx: Ctx, to: PublicKey, lamports: bigint, proposer: Signer = ctx.keys.proposer) {
  const index = await nextIndex(ctx);
  const transfer: TransactionInstruction = SystemProgram.transfer({ fromPubkey: ctx.vault, toPubkey: to, lamports });
  const ixs = createVaultProposalIxs({
    multisig: ctx.multisig,
    index,
    proposer: await proposer.publicKey(),
    rentPayer: await ctx.keys.relayer.publicKey(),
    instructions: [transfer],
    recentBlockhash: await ctx.chain.getLatestBlockhash(),
  });
  await sendInstructions(ctx.chain, ixs, [ctx.keys.relayer, proposer]);
  return index;
}

export async function proposeConfig(ctx: Ctx, actions: multisig.types.ConfigAction[], proposer: Signer = ctx.keys.proposer) {
  const index = await nextIndex(ctx);
  const ixs = createConfigProposalIxs({
    multisig: ctx.multisig,
    index,
    proposer: await proposer.publicKey(),
    rentPayer: await ctx.keys.relayer.publicKey(),
    actions,
  });
  await sendInstructions(ctx.chain, ixs, [ctx.keys.relayer, proposer]);
  return index;
}

/** O membro vota; o relayer paga a taxa. */
export async function approve(ctx: Ctx, index: bigint, member: Signer) {
  return sendInstructions(ctx.chain, [approveIx(ctx.multisig, index, await member.publicKey())], [ctx.keys.relayer, member]);
}

export async function executeVault(ctx: Ctx, index: bigint, executor: Signer = ctx.keys.executor) {
  const pk = await executor.publicKey();
  const { instruction, lookupTableAccounts } = await executeVaultIx(ctx.chain, ctx.multisig, index, pk);
  return sendInstructions(ctx.chain, [instruction], [ctx.keys.relayer, executor], lookupTableAccounts);
}

export async function executeConfig(ctx: Ctx, index: bigint, executor: Signer = ctx.keys.executor) {
  const ix = executeConfigIx(ctx.multisig, index, await executor.publicKey(), await ctx.keys.relayer.publicKey());
  return sendInstructions(ctx.chain, [ix], [ctx.keys.relayer, executor]);
}

/** Espera que a promessa falhe na chain e devolve o nome do erro do programa. */
export async function chainError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ChainTxError) return e.programError ?? e.message;
    throw e;
  }
  throw new Error("esperava falha on-chain, mas a transação passou");
}

export const attacker = () => Keypair.generate().publicKey;
