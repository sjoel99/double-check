/**
 * Provas on-chain do modelo STRICT_2_OF_2, executadas contra o ELF do Squads v4
 * da mainnet (LiteSVM, sigverify ligado). Aqui não há backend nem política: o
 * atacante fala direto com o programa. O que falha aqui falha na rede.
 */
import { describe, expect, it } from "vitest";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { DevMemorySigner } from "@duplachave/crypto";
import { assertStrictTwoOfTwo, readMultisig, readProposal, rotationActions } from "@duplachave/squads";
import * as multisig from "@sqds/multisig";
import {
  approve,
  attacker,
  chainError,
  executeConfig,
  executeVault,
  proposeConfig,
  proposeTransfer,
  setupStrict,
} from "./support/setup";

const SOL = BigInt(LAMPORTS_PER_SOL);

describe("STRICT_2_OF_2 on-chain", () => {
  it("estado inicial: threshold 2, só CLIENT e SERVER votam, sem config authority", async () => {
    const ctx = await setupStrict();
    const state = await readMultisig(ctx.chain, ctx.multisig);
    expect(() =>
      assertStrictTwoOfTwo(state, {
        client: ctx.layout.client.toBase58(),
        server: ctx.layout.server.toBase58(),
        executor: ctx.layout.executor.toBase58(),
        proposer: ctx.layout.proposer.toBase58(),
      }),
    ).not.toThrow();
    expect(state.threshold).toBe(2);
    expect(state.members.filter((m) => m.vote)).toHaveLength(2);
  });

  it("Teste 1 — só a CLIENT_KEY não movimenta fundos", async () => {
    const ctx = await setupStrict();
    const thief = attacker();
    const index = await proposeTransfer(ctx, thief, 9n * SOL);
    await approve(ctx, index, ctx.keys.client);
    expect((await readProposal(ctx.chain, ctx.multisig, index))?.status).toBe("Active");
    // Executor honesto ou não: proposta com 1 de 2 não executa.
    expect(await chainError(executeVault(ctx, index))).toBe("InvalidProposalStatus");
    // O cliente tentando executar ele mesmo: não tem permissão Execute.
    expect(await chainError(executeVault(ctx, index, ctx.keys.client))).toBe("Unauthorized");
    // Votar de novo não conta duas vezes.
    expect(await chainError(approve(ctx, index, ctx.keys.client))).toBe("AlreadyApproved");
    expect(await ctx.chain.getBalance(thief)).toBe(0n);
  });

  it("Teste 2 — só a SERVER_KEY não movimenta fundos", async () => {
    const ctx = await setupStrict();
    const thief = attacker();
    const index = await proposeTransfer(ctx, thief, 9n * SOL);
    await approve(ctx, index, ctx.keys.server);
    expect(await chainError(executeVault(ctx, index))).toBe("InvalidProposalStatus");
    expect(await chainError(executeVault(ctx, index, ctx.keys.server))).toBe("Unauthorized");
    expect(await ctx.chain.getBalance(thief)).toBe(0n);
  });

  it("Teste 3 — CLIENT + SERVER movimentam", async () => {
    const ctx = await setupStrict();
    const dest = attacker();
    const index = await proposeTransfer(ctx, dest, 2n * SOL);
    await approve(ctx, index, ctx.keys.client);
    await approve(ctx, index, ctx.keys.server);
    expect((await readProposal(ctx.chain, ctx.multisig, index))?.status).toBe("Approved");
    await executeVault(ctx, index);
    expect(await ctx.chain.getBalance(dest)).toBe(2n * SOL);
    expect((await readProposal(ctx.chain, ctx.multisig, index))?.status).toBe("Executed");
  });

  it("Teste 4 — o EXECUTOR não vota", async () => {
    const ctx = await setupStrict();
    const index = await proposeTransfer(ctx, attacker(), SOL);
    expect(await chainError(approve(ctx, index, ctx.keys.executor))).toBe("Unauthorized");
    // Nem completando o quórum com um votante.
    await approve(ctx, index, ctx.keys.client);
    expect(await chainError(approve(ctx, index, ctx.keys.executor))).toBe("Unauthorized");
    expect(await chainError(executeVault(ctx, index))).toBe("InvalidProposalStatus");
  });

  it("Teste 5 — a OPERATIONAL_WALLET não vota", async () => {
    const ctx = await setupStrict();
    const index = await proposeTransfer(ctx, attacker(), SOL);
    expect(await chainError(approve(ctx, index, ctx.keys.proposer))).toBe("Unauthorized");
    await approve(ctx, index, ctx.keys.server);
    expect(await chainError(approve(ctx, index, ctx.keys.proposer))).toBe("Unauthorized");
    expect(await chainError(executeVault(ctx, index))).toBe("InvalidProposalStatus");
  });

  it("Teste 6 — CLIENT comprometida não remove a SERVER_KEY", async () => {
    const ctx = await setupStrict();
    // Pior caso: o atacante tem a CLIENT_KEY *e* a wallet operacional (propõe).
    const evil = DevMemorySigner.generate("EVIL");
    const index = await proposeConfig(ctx, [
      { __kind: "AddMember", newMember: { key: await evil.publicKey(), permissions: multisig.types.Permissions.fromPermissions([multisig.types.Permission.Vote]) } },
      { __kind: "RemoveMember", oldMember: ctx.layout.server },
    ]);
    await approve(ctx, index, ctx.keys.client);
    expect(await chainError(executeConfig(ctx, index))).toBe("InvalidProposalStatus");
    const state = await readMultisig(ctx.chain, ctx.multisig);
    expect(state.members.some((m) => m.key === ctx.layout.server.toBase58())).toBe(true);
    expect(state.members.some((m) => m.key === (evil as unknown as { toJSON(): { publicKey: string } }).toJSON().publicKey)).toBe(false);
  });

  it("Teste 7 — SERVER comprometida não remove a CLIENT_KEY (nem baixa o threshold)", async () => {
    const ctx = await setupStrict();
    const index = await proposeConfig(ctx, [
      { __kind: "ChangeThreshold", newThreshold: 1 },
      { __kind: "RemoveMember", oldMember: ctx.layout.client },
    ]);
    await approve(ctx, index, ctx.keys.server);
    expect(await chainError(executeConfig(ctx, index))).toBe("InvalidProposalStatus");
    const state = await readMultisig(ctx.chain, ctx.multisig);
    expect(state.threshold).toBe(2);
    expect(state.members.some((m) => m.key === ctx.layout.client.toBase58())).toBe(true);
  });

  it("Teste 8 — rotação CLIENT_A → CLIENT_B exige CLIENT_A + SERVER; depois CLIENT_A não vota", async () => {
    const ctx = await setupStrict();
    const clientB = DevMemorySigner.generate("CLIENT_B");
    const b = await clientB.publicKey();
    const index = await proposeConfig(ctx, rotationActions(ctx.layout.client, b));

    await approve(ctx, index, ctx.keys.client);
    expect(await chainError(executeConfig(ctx, index))).toBe("InvalidProposalStatus");

    await approve(ctx, index, ctx.keys.server);
    await executeConfig(ctx, index);

    const state = await readMultisig(ctx.chain, ctx.multisig);
    assertStrictTwoOfTwo(state, {
      client: b.toBase58(),
      server: ctx.layout.server.toBase58(),
      executor: ctx.layout.executor.toBase58(),
      proposer: ctx.layout.proposer.toBase58(),
    });

    // CLIENT_A deixou de ser membro.
    const next = await proposeTransfer(ctx, attacker(), SOL);
    expect(await chainError(approve(ctx, next, ctx.keys.client))).toBe("NotAMember");
    // CLIENT_B + SERVER funcionam.
    await approve(ctx, next, clientB);
    await approve(ctx, next, ctx.keys.server);
    await executeVault(ctx, next);
  });

  it("Teste 9 — rotação SERVER_A → SERVER_B exige o Approval App (CLIENT) + SERVER_A", async () => {
    const ctx = await setupStrict();
    const serverB = DevMemorySigner.generate("SERVER_B");
    const b = await serverB.publicKey();
    const index = await proposeConfig(ctx, rotationActions(ctx.layout.server, b));

    // Sem o cliente: falha. Nem a chave nova ajuda — ainda não é membro.
    await approve(ctx, index, ctx.keys.server);
    expect(await chainError(approve(ctx, index, serverB))).toBe("NotAMember");
    expect(await chainError(executeConfig(ctx, index))).toBe("InvalidProposalStatus");

    await approve(ctx, index, ctx.keys.client);
    await executeConfig(ctx, index);

    const state = await readMultisig(ctx.chain, ctx.multisig);
    expect(state.members.some((m) => m.key === ctx.layout.server.toBase58())).toBe(false);
    expect(state.members.find((m) => m.key === b.toBase58())?.mask).toBe(2);
    expect(state.threshold).toBe(2);

    const next = await proposeTransfer(ctx, attacker(), SOL);
    expect(await chainError(approve(ctx, next, ctx.keys.server))).toBe("NotAMember");
  });
});

describe("comportamentos do Squads v4 que definem o desenho", () => {
  it("rotação torna stale as propostas abertas: ninguém mais vota nelas", async () => {
    const ctx = await setupStrict();
    const pending = await proposeTransfer(ctx, attacker(), SOL);
    await approve(ctx, pending, ctx.keys.client);

    const clientB = DevMemorySigner.generate("CLIENT_B");
    const rot = await proposeConfig(ctx, rotationActions(ctx.layout.client, await clientB.publicKey()));
    await approve(ctx, rot, ctx.keys.client);
    await approve(ctx, rot, ctx.keys.server);
    await executeConfig(ctx, rot);

    expect(await chainError(approve(ctx, pending, ctx.keys.server))).toBe("StaleProposal");
  });

  it("ATENÇÃO: vault transaction já APROVADA continua executável depois da rotação", async () => {
    // Por isso a rotação drena a fila antes (KEY_ROTATION.md, passo 3).
    const ctx = await setupStrict();
    const dest = attacker();
    const approved = await proposeTransfer(ctx, dest, SOL);
    await approve(ctx, approved, ctx.keys.client);
    await approve(ctx, approved, ctx.keys.server);

    const clientB = DevMemorySigner.generate("CLIENT_B");
    const rot = await proposeConfig(ctx, rotationActions(ctx.layout.client, await clientB.publicKey()));
    await approve(ctx, rot, ctx.keys.client);
    await approve(ctx, rot, ctx.keys.server);
    await executeConfig(ctx, rot);

    await executeVault(ctx, approved); // o programa não checa stale no execute de vault
    expect(await ctx.chain.getBalance(dest)).toBe(SOL);
  });

  it("depois da rotação, CLIENT_B + SERVER cancelam a aprovada antiga", async () => {
    const ctx = await setupStrict();
    const approved = await proposeTransfer(ctx, attacker(), SOL);
    await approve(ctx, approved, ctx.keys.client);
    await approve(ctx, approved, ctx.keys.server);
    const clientB = DevMemorySigner.generate("CLIENT_B");
    const rot = await proposeConfig(ctx, rotationActions(ctx.layout.client, await clientB.publicKey()));
    await approve(ctx, rot, ctx.keys.client);
    await approve(ctx, rot, ctx.keys.server);
    await executeConfig(ctx, rot);

    const { sendInstructions } = await import("@duplachave/solana");
    const { cancelIx } = await import("@duplachave/squads");
    for (const m of [clientB, ctx.keys.server]) {
      await sendInstructions(ctx.chain, [cancelIx(ctx.multisig, approved, await m.publicKey())], [ctx.keys.relayer, m]);
    }
    expect((await readProposal(ctx.chain, ctx.multisig, approved))?.status).toBe("Cancelled");
    expect(await chainError(executeVault(ctx, approved))).toBe("InvalidProposalStatus");
  });

  it("PERIGO evitado: adicionar e remover em transações separadas abre janela sem o servidor", async () => {
    // Com só AddMember(CLIENT_B) executado, há 3 votantes e threshold 2:
    // CLIENT_A + CLIENT_B (os dois do lado do usuário) movem fundos sem o servidor.
    const ctx = await setupStrict();
    const clientB = DevMemorySigner.generate("CLIENT_B");
    const add = await proposeConfig(ctx, [rotationActions(ctx.layout.client, await clientB.publicKey())[0]!]);
    await approve(ctx, add, ctx.keys.client);
    await approve(ctx, add, ctx.keys.server);
    await executeConfig(ctx, add);

    const dest = attacker();
    const theft = await proposeTransfer(ctx, dest, 5n * SOL);
    await approve(ctx, theft, ctx.keys.client);
    await approve(ctx, theft, clientB);
    await executeVault(ctx, theft);
    expect(await ctx.chain.getBalance(dest)).toBe(5n * SOL); // por isso a rotação é atômica
  });

  it("um único voto de rejeição encerra a proposta (cutoff = 1 em 2 de 2)", async () => {
    const ctx = await setupStrict();
    const { sendInstructions } = await import("@duplachave/solana");
    const { rejectIx } = await import("@duplachave/squads");
    const index = await proposeTransfer(ctx, attacker(), SOL);
    await sendInstructions(ctx.chain, [rejectIx(ctx.multisig, index, ctx.layout.server)], [ctx.keys.relayer, ctx.keys.server]);
    expect((await readProposal(ctx.chain, ctx.multisig, index))?.status).toBe("Rejected");
    expect(await chainError(approve(ctx, index, ctx.keys.client))).toBe("InvalidProposalStatus");
  });

  it("threshold acima do número de votantes é recusado pelo programa", async () => {
    const ctx = await setupStrict();
    const index = await proposeConfig(ctx, [{ __kind: "RemoveMember", oldMember: ctx.layout.client }]);
    await approve(ctx, index, ctx.keys.client);
    await approve(ctx, index, ctx.keys.server);
    // 1 votante restante com threshold 2: o invariant do programa barra.
    expect(await chainError(executeConfig(ctx, index))).toBe("InvalidThreshold");
  });
});
