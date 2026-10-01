/** Transação atômica paga pela Phantom no modelo 2 de 3: provas no programa real. */
import { describe, expect, it } from "vitest";
import { LAMPORTS_PER_SOL, SystemProgram, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { DevMemorySigner, signTransaction } from "@duplachave/crypto";
import { atomicVaultInstructions, configCancelInstructions, configExecuteInstructions, configRequestInstructions, readMultisig, readProposal, rotationActions } from "@duplachave/squads";
import { attacker, chainError, setupStrict } from "./support/setup";

const SOL = BigInt(LAMPORTS_PER_SOL);
type Ctx = Awaited<ReturnType<typeof setupStrict>>;

async function build(ctx: Ctx, ixs: TransactionInstruction[], payer = ctx.keys.client) {
  const msg = new TransactionMessage({ payerKey: await payer.publicKey(), recentBlockhash: await ctx.chain.getLatestBlockhash(), instructions: ixs }).compileToV0Message();
  return new VersionedTransaction(msg);
}

const transfer = async (ctx: Ctx, lamports: bigint, over: Partial<Parameters<typeof atomicVaultInstructions>[0]> = {}) => {
  const index = (await readMultisig(ctx.chain, ctx.multisig)).transactionIndex + 1n;
  const ixs = atomicVaultInstructions({
    multisig: ctx.multisig,
    index,
    operator: ctx.layout.operator,
    voters: [ctx.layout.client, ctx.layout.webapp],
    payer: ctx.layout.client,
    rentCollector: ctx.layout.client,
    instructions: [SystemProgram.transfer({ fromPubkey: ctx.vault, toPubkey: attacker(), lamports })],
    ...over,
  });
  return { index, ixs };
};

describe("operação atômica (Phantom + webapp votam, operador executa, Phantom paga)", () => {
  it("cria, dois votos, operador executa e fecha numa transação; a Phantom paga só a taxa; o serviço não gasta nada", async () => {
    const ctx = await setupStrict();
    const { index, ixs } = await transfer(ctx, 2n * SOL);
    const tx = await build(ctx, ixs);
    console.log("tamanho da transação atômica (2 de 3):", tx.serialize().length, "bytes (limite 1232)");
    expect(tx.serialize().length).toBeLessThanOrEqual(1232);
    expect(tx.message.header.numRequiredSignatures).toBe(3);
    const before = await ctx.chain.getBalance(ctx.layout.client);
    await signTransaction(tx, [ctx.keys.webapp]); // webapp (depois da biometria)
    await signTransaction(tx, [ctx.keys.operator]); // serviço (depois de conferir a política e o webapp)
    await signTransaction(tx, [ctx.keys.client]); // Phantom por último
    await ctx.chain.sendTransaction(tx);
    expect(await readProposal(ctx.chain, ctx.multisig, index)).toBeNull();
    expect(before - (await ctx.chain.getBalance(ctx.layout.client))).toBe(15_000n);
    for (const k of [ctx.layout.operator, ctx.layout.server, ctx.layout.webapp]) expect(await ctx.chain.getBalance(k)).toBe(0n);
  });

  it("sem o operador, sem o webapp ou com a Phantom no lugar do operador: o programa recusa", async () => {
    const ctx = await setupStrict();
    const a = await transfer(ctx, SOL);
    const noOperator = await build(ctx, a.ixs);
    await signTransaction(noOperator, [ctx.keys.webapp, ctx.keys.client]);
    await expect(ctx.chain.sendTransaction(noOperator)).rejects.toThrow();

    const fake = DevMemorySigner.generate("FAKE_WEBAPP");
    const b = await transfer(ctx, SOL, { voters: [ctx.layout.client, await fake.publicKey()] });
    const forged = await build(ctx, b.ixs);
    await signTransaction(forged, [fake, ctx.keys.operator, ctx.keys.client]);
    expect(await chainError(ctx.chain.sendTransaction(forged))).toBe("NotAMember");

    const c = await transfer(ctx, SOL, { operator: ctx.layout.client });
    const selfExec = await build(ctx, c.ixs);
    await signTransaction(selfExec, [ctx.keys.webapp, ctx.keys.client]);
    expect(await chainError(ctx.chain.sendTransaction(selfExec))).toBe("Unauthorized");
  });

  it("se a execução falha, nada fica na chain", async () => {
    const ctx = await setupStrict(1);
    const { index, ixs } = await transfer(ctx, 5n * SOL);
    const tx = await build(ctx, ixs);
    await signTransaction(tx, [ctx.keys.webapp, ctx.keys.operator, ctx.keys.client]);
    await expect(ctx.chain.sendTransaction(tx)).rejects.toThrow();
    expect(await readProposal(ctx.chain, ctx.multisig, index)).toBeNull();
    expect((await readMultisig(ctx.chain, ctx.multisig)).transactionIndex).toBe(index - 1n);
  });
});

describe("troca de chave em dois passos (pedido agora, execução depois do prazo)", () => {
  it("recuperar o webapp: pedido com Phantom + serviço; depois o operador executa; a Phantom paga as duas vezes", async () => {
    const ctx = await setupStrict();
    const next = DevMemorySigner.generate("WEBAPP_B");
    const index = (await readMultisig(ctx.chain, ctx.multisig)).transactionIndex + 1n;
    const req = await build(
      ctx,
      configRequestInstructions({ multisig: ctx.multisig, index, operator: ctx.layout.operator, voters: [ctx.layout.client, ctx.layout.server], payer: ctx.layout.client, actions: rotationActions(ctx.layout.webapp, await next.publicKey(), "WEBAPP") }),
    );
    await signTransaction(req, [ctx.keys.operator, ctx.keys.server, ctx.keys.client]);
    await ctx.chain.sendTransaction(req);
    expect((await readProposal(ctx.chain, ctx.multisig, index))?.status).toBe("Approved");

    const exec = await build(ctx, configExecuteInstructions({ multisig: ctx.multisig, index, operator: ctx.layout.operator, payer: ctx.layout.client, rentCollector: ctx.layout.client }));
    await signTransaction(exec, [ctx.keys.operator, ctx.keys.client]);
    await ctx.chain.sendTransaction(exec);
    const s = await readMultisig(ctx.chain, ctx.multisig);
    const nk = (await next.publicKey()).toBase58();
    expect(s.members.find((m) => m.key === nk)?.mask).toBe(2);
    expect(s.members.some((m) => m.key === ctx.layout.webapp.toBase58())).toBe(false);
    expect(await readProposal(ctx.chain, ctx.multisig, index)).toBeNull();
  });

  it("'Não fui eu': webapp + serviço cancelam o pedido aprovado, numa transação paga pela Phantom", async () => {
    const ctx = await setupStrict();
    const thief = DevMemorySigner.generate("WEBAPP_LADRAO");
    const index = (await readMultisig(ctx.chain, ctx.multisig)).transactionIndex + 1n;
    const req = await build(
      ctx,
      configRequestInstructions({ multisig: ctx.multisig, index, operator: ctx.layout.operator, voters: [ctx.layout.client, ctx.layout.server], payer: ctx.layout.client, actions: rotationActions(ctx.layout.webapp, await thief.publicKey(), "WEBAPP") }),
    );
    await signTransaction(req, [ctx.keys.operator, ctx.keys.server, ctx.keys.client]);
    await ctx.chain.sendTransaction(req);
    const cancel = await build(ctx, configCancelInstructions({ multisig: ctx.multisig, index, voters: [ctx.layout.webapp, ctx.layout.server], rentCollector: ctx.layout.client }));
    await signTransaction(cancel, [ctx.keys.webapp, ctx.keys.server, ctx.keys.client]);
    await ctx.chain.sendTransaction(cancel);
    expect(await readProposal(ctx.chain, ctx.multisig, index)).toBeNull(); // cancelada e fechada
    expect((await readMultisig(ctx.chain, ctx.multisig)).members.some((m) => m.key === ctx.layout.webapp.toBase58())).toBe(true);
  });

  it("multisig sem rent_collector: a operação sai sem fechar as contas", async () => {
    const ctx = await setupStrict(10, { rentCollector: null });
    const { ixs } = await transfer(ctx, SOL, { rentCollector: null });
    expect(ixs).toHaveLength(5);
    const tx = await build(ctx, ixs);
    await signTransaction(tx, [ctx.keys.webapp, ctx.keys.operator, ctx.keys.client]);
    await ctx.chain.sendTransaction(tx);
  });
});
