/** Transação atômica paga pela carteira: provas no programa real. */
import { describe, expect, it } from "vitest";
import { LAMPORTS_PER_SOL, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { DevMemorySigner, signTransaction } from "@duplachave/crypto";
import { atomicConfigInstructions, atomicVaultInstructions, readMultisig, readProposal, rotationActions } from "@duplachave/squads";
import { attacker, chainError, setupStrict } from "./support/setup";

const SOL = BigInt(LAMPORTS_PER_SOL);

async function build(ctx: Awaited<ReturnType<typeof setupStrict>>, ixs: Parameters<typeof signTransaction>[0] extends never ? never : any, payer = ctx.keys.client) {
  const msg = new TransactionMessage({ payerKey: await payer.publicKey(), recentBlockhash: await ctx.chain.getLatestBlockhash(), instructions: ixs }).compileToV0Message();
  return new VersionedTransaction(msg);
}

describe("transação atômica paga pela carteira", () => {
  it("cria, servidor aprova, carteira aprova e executa numa transação; a carteira paga taxa e rent", async () => {
    const ctx = await setupStrict();
    const dest = attacker();
    const index = (await readMultisig(ctx.chain, ctx.multisig)).transactionIndex + 1n;
    const ixs = atomicVaultInstructions({
      multisig: ctx.multisig, index, proposer: ctx.layout.proposer, server: ctx.layout.server, wallet: ctx.layout.client,
      instructions: [SystemProgram.transfer({ fromPubkey: ctx.vault, toPubkey: dest, lamports: 2n * SOL })],
    });
    const tx = await build(ctx, ixs);
    console.log("tamanho da transação atômica:", tx.serialize().length, "bytes (limite 1232)");
    expect(tx.serialize().length).toBeLessThanOrEqual(1232);
    const feePayerBefore = await ctx.chain.getBalance(await ctx.keys.relayer.publicKey());
    const walletBefore = await ctx.chain.getBalance(ctx.layout.client);
    await signTransaction(tx, [ctx.keys.proposer, ctx.keys.server]); // o serviço assina antes
    await signTransaction(tx, [ctx.keys.client]); // a carteira por último
    await ctx.chain.sendTransaction(tx);
    expect(await ctx.chain.getBalance(dest)).toBe(2n * SOL);
    // Executada e já fechada: as contas da proposta somem e o rent volta para a carteira.
    expect(await readProposal(ctx.chain, ctx.multisig, index)).toBeNull();
    expect((await readMultisig(ctx.chain, ctx.multisig)).transactionIndex).toBe(index);
    const walletAfter = await ctx.chain.getBalance(ctx.layout.client);
    console.log("custo líquido para a carteira:", Number(walletBefore - walletAfter) / 1e9, "SOL");
    expect(walletBefore - walletAfter).toBe(15_000n); // só a taxa de rede: 3 assinaturas × 5000 lamports
    expect(await ctx.chain.getBalance(await ctx.keys.relayer.publicKey())).toBe(feePayerBefore); // o sistema não pagou nada
  });

  it("sem a assinatura do servidor a transação nem entra; sem a da carteira também não", async () => {
    const ctx = await setupStrict();
    const index = (await readMultisig(ctx.chain, ctx.multisig)).transactionIndex + 1n;
    const ixs = atomicVaultInstructions({
      multisig: ctx.multisig, index, proposer: ctx.layout.proposer, server: ctx.layout.server, wallet: ctx.layout.client,
      instructions: [SystemProgram.transfer({ fromPubkey: ctx.vault, toPubkey: attacker(), lamports: SOL })],
    });
    const noServer = await build(ctx, ixs);
    await signTransaction(noServer, [ctx.keys.proposer, ctx.keys.client]);
    await expect(ctx.chain.sendTransaction(noServer)).rejects.toThrow();
    // Carteira tentando substituir o servidor por outro votante: o programa recusa.
    const fake = DevMemorySigner.generate("FAKE");
    const ixs2 = atomicVaultInstructions({
      multisig: ctx.multisig, index, proposer: ctx.layout.proposer, server: await fake.publicKey(), wallet: ctx.layout.client,
      instructions: [SystemProgram.transfer({ fromPubkey: ctx.vault, toPubkey: attacker(), lamports: SOL })],
    });
    const forged = await build(ctx, ixs2);
    await signTransaction(forged, [ctx.keys.proposer, fake, ctx.keys.client]);
    expect(await chainError(ctx.chain.sendTransaction(forged))).toBe("NotAMember");
  });

  it("se a execução falha, nada fica na chain (nem a proposta)", async () => {
    const ctx = await setupStrict(1);
    const index = (await readMultisig(ctx.chain, ctx.multisig)).transactionIndex + 1n;
    const ixs = atomicVaultInstructions({
      multisig: ctx.multisig, index, proposer: ctx.layout.proposer, server: ctx.layout.server, wallet: ctx.layout.client,
      instructions: [SystemProgram.transfer({ fromPubkey: ctx.vault, toPubkey: attacker(), lamports: 5n * SOL })],
    });
    const tx = await build(ctx, ixs);
    await signTransaction(tx, [ctx.keys.proposer, ctx.keys.server, ctx.keys.client]);
    await expect(ctx.chain.sendTransaction(tx)).rejects.toThrow();
    expect(await readProposal(ctx.chain, ctx.multisig, index)).toBeNull();
    expect((await readMultisig(ctx.chain, ctx.multisig)).transactionIndex).toBe(index - 1n);
  });

  it("troca de carteira atômica: carteira atual + servidor, e a carteira atual executa", async () => {
    const ctx = await setupStrict();
    const next = DevMemorySigner.generate("NEXT");
    const index = (await readMultisig(ctx.chain, ctx.multisig)).transactionIndex + 1n;
    const ixs = atomicConfigInstructions({
      multisig: ctx.multisig, index, proposer: ctx.layout.proposer, server: ctx.layout.server, wallet: ctx.layout.client,
      actions: rotationActions(ctx.layout.client, await next.publicKey(), "CLIENT"),
      rentCollector: await next.publicKey(),
    });
    const tx = await build(ctx, ixs);
    console.log("tamanho da troca atômica:", tx.serialize().length, "bytes");
    await signTransaction(tx, [ctx.keys.proposer, ctx.keys.server, ctx.keys.client]);
    await ctx.chain.sendTransaction(tx);
    const state = await readMultisig(ctx.chain, ctx.multisig);
    expect(state.members.find((m) => m.key === (next as any).toJSON().publicKey)?.mask).toBe(6);
    expect(state.members.some((m) => m.key === ctx.layout.client.toBase58())).toBe(false);
    expect(state.rentCollector).toBe((next as any).toJSON().publicKey);
  });

  it("multisig antiga sem rent_collector: o app monta sem fechar as contas, e a troca da carteira passa a fechar", async () => {
    const { atomicInstructionsFor, compileAtomic } = await import("@duplachave/custody");
    const { sealIntent } = await import("@duplachave/shared");
    const ctx = await setupStrict(10, { rentCollector: null });
    const state = await readMultisig(ctx.chain, ctx.multisig);
    expect(state.rentCollector).toBeNull();
    const roles = { proposer: ctx.layout.proposer, server: ctx.layout.server, wallet: ctx.layout.client };
    const base = { version: 1 as const, id: crypto.randomUUID(), cluster: "localnet" as const, multisig: ctx.multisig.toBase58(), transactionIndex: "1", createdAt: 1, expiresAt: 100 };
    const intent = sealIntent({ ...base, kind: "OPERATION", type: "TRANSFER_SOL", vault: ctx.vault.toBase58(), vaultIndex: 0, amountLamports: SOL.toString(), destination: attacker().toBase58(), programs: [SystemProgram.programId.toBase58()] });
    const ixs = atomicInstructionsFor(intent, roles, state);
    expect(ixs).toHaveLength(5);
    const tx = new VersionedTransaction(compileAtomic(ixs, ctx.layout.client, await ctx.chain.getLatestBlockhash()));
    await signTransaction(tx, [ctx.keys.proposer, ctx.keys.server, ctx.keys.client]);
    await ctx.chain.sendTransaction(tx);

    const next = DevMemorySigner.generate("NEXT");
    const rot = sealIntent({ ...base, id: crypto.randomUUID(), transactionIndex: "2", kind: "CONFIG", type: "ROTATE_MEMBER", role: "CLIENT", oldKey: ctx.layout.client.toBase58(), newKey: (await next.publicKey()).toBase58(), rotationId: crypto.randomUUID() });
    const rotIxs = atomicInstructionsFor(rot, roles, await readMultisig(ctx.chain, ctx.multisig));
    expect(rotIxs).toHaveLength(6);
    const rtx = new VersionedTransaction(compileAtomic(rotIxs, ctx.layout.client, await ctx.chain.getLatestBlockhash()));
    await signTransaction(rtx, [ctx.keys.proposer, ctx.keys.server, ctx.keys.client]);
    await ctx.chain.sendTransaction(rtx);
    expect((await readMultisig(ctx.chain, ctx.multisig)).rentCollector).toBe((await next.publicKey()).toBase58());
  });
});
