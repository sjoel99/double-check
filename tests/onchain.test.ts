/**
 * Modelo 2 de 3 no programa real da Squads v4 (ELF da mainnet no LiteSVM, com
 * verificação de assinatura): votam a Phantom (CLIENT), a chave do webapp
 * (WEBAPP) e o serviço (SERVER); só o operador do serviço cria e executa.
 * O atacante fala direto com o programa, sem passar pelo backend.
 */
import { describe, expect, it } from "vitest";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { DevMemorySigner } from "@duplachave/crypto";
import { sendInstructions } from "@duplachave/solana";
import { assertAccountModel, cancelIx, executeConfigIx, readMultisig, readProposal, rotationActions, VOTER_MASK } from "@duplachave/squads";
import * as multisig from "@sqds/multisig";
import { approve, attacker, chainError, executeConfig, executeVault, proposeConfig, proposeTransfer, setupStrict } from "./support/setup";

const SOL = BigInt(LAMPORTS_PER_SOL);
const roles = async (ctx: Awaited<ReturnType<typeof setupStrict>>) => ({
  client: ctx.layout.client.toBase58(),
  webapp: ctx.layout.webapp.toBase58(),
  server: ctx.layout.server.toBase58(),
  operator: ctx.layout.operator.toBase58(),
});

describe("2 de 3 com executor único, na chain", () => {
  it("estado inicial: threshold 2; votam Phantom, webapp e serviço (só Vote); o operador só cria e executa", async () => {
    const ctx = await setupStrict();
    const s = await readMultisig(ctx.chain, ctx.multisig);
    expect(s.threshold).toBe(2);
    expect(s.members.filter((m) => m.vote).map((m) => m.mask)).toEqual([VOTER_MASK, VOTER_MASK, VOTER_MASK]);
    expect(s.members.find((m) => m.key === ctx.layout.operator.toBase58())?.mask).toBe(5);
    expect(() => assertAccountModel(s, {} as never)).toThrow();
    assertAccountModel(s, await roles(ctx));
  });

  it("Teste 1 — só a Phantom não movimenta fundos", async () => {
    const ctx = await setupStrict();
    const to = attacker();
    const i = await proposeTransfer(ctx, to, SOL);
    await approve(ctx, i, ctx.keys.client);
    expect(await chainError(executeVault(ctx, i))).toBe("InvalidProposalStatus");
    expect(await ctx.chain.getBalance(to)).toBe(0n);
  });

  it("Teste 2 — o serviço inteiro (voto + operador) não movimenta fundos", async () => {
    const ctx = await setupStrict();
    const to = attacker();
    const i = await proposeTransfer(ctx, to, SOL);
    await approve(ctx, i, ctx.keys.server);
    expect(await chainError(executeVault(ctx, i))).toBe("InvalidProposalStatus");
    expect(await chainError(approve(ctx, i, ctx.keys.operator))).toBe("Unauthorized"); // operador não vota
  });

  it("Teste 3 — Phantom + webapp aprovam e o operador executa", async () => {
    const ctx = await setupStrict();
    const to = attacker();
    const i = await proposeTransfer(ctx, to, 2n * SOL);
    await approve(ctx, i, ctx.keys.client);
    await approve(ctx, i, ctx.keys.webapp);
    await executeVault(ctx, i);
    expect(await ctx.chain.getBalance(to)).toBe(2n * SOL);
  });

  it("NOVO — com os dois votos do usuário, nem a Phantom nem o webapp executam: só o operador (a política do serviço é o portão)", async () => {
    const ctx = await setupStrict();
    const to = attacker();
    const i = await proposeTransfer(ctx, to, SOL);
    await approve(ctx, i, ctx.keys.client);
    await approve(ctx, i, ctx.keys.webapp);
    expect(await chainError(executeVault(ctx, i, ctx.keys.client))).toBe("Unauthorized");
    expect(await chainError(executeVault(ctx, i, ctx.keys.webapp))).toBe("Unauthorized");
    expect(await ctx.chain.getBalance(to)).toBe(0n);
  });

  it("Testes 4/5 — o operador não vota; a Phantom não cria transações no Vault", async () => {
    const ctx = await setupStrict();
    const i = await proposeTransfer(ctx, attacker(), SOL);
    expect(await chainError(approve(ctx, i, ctx.keys.operator))).toBe("Unauthorized");
    expect(await chainError(proposeTransfer(ctx, attacker(), SOL, ctx.keys.client))).toBe("Unauthorized");
  });

  it("Teste 6 — Phantom comprometida não remove o serviço", async () => {
    const ctx = await setupStrict();
    const i = await proposeConfig(ctx, [{ __kind: "RemoveMember", oldMember: ctx.layout.server }]);
    await approve(ctx, i, ctx.keys.client);
    expect(await chainError(executeConfig(ctx, i))).toBe("InvalidProposalStatus");
    expect((await readMultisig(ctx.chain, ctx.multisig)).members.some((m) => m.key === ctx.layout.server.toBase58())).toBe(true);
  });

  it("Teste 7 — serviço comprometido não remove a Phantom nem baixa o threshold", async () => {
    const ctx = await setupStrict();
    const i = await proposeConfig(ctx, [{ __kind: "RemoveMember", oldMember: ctx.layout.client }, { __kind: "ChangeThreshold", newThreshold: 1 }]);
    await approve(ctx, i, ctx.keys.server);
    expect(await chainError(executeConfig(ctx, i))).toBe("InvalidProposalStatus");
    expect((await readMultisig(ctx.chain, ctx.multisig)).threshold).toBe(2);
  });

  it("Teste 8 — trocar a Phantom: webapp + serviço aprovam, só o operador executa; a Phantom antiga não vota mais", async () => {
    const ctx = await setupStrict();
    const next = DevMemorySigner.generate("CLIENT_B");
    const i = await proposeConfig(ctx, rotationActions(ctx.layout.client, await next.publicKey(), "CLIENT"));
    await approve(ctx, i, ctx.keys.webapp);
    await approve(ctx, i, ctx.keys.server);
    expect(await chainError(executeConfig(ctx, i, ctx.keys.webapp))).toBe("Unauthorized"); // aprovada, mas só o operador executa
    await executeConfig(ctx, i);
    const s = await readMultisig(ctx.chain, ctx.multisig);
    assertAccountModel(s, { ...(await roles(ctx)), client: (await next.publicKey()).toBase58() });
    expect(s.rentCollector).toBe((await next.publicKey()).toBase58());
    const j = await proposeTransfer(ctx, attacker(), SOL);
    expect(await chainError(approve(ctx, j, ctx.keys.client))).toBe("NotAMember");
  });

  it("Teste 9 — recuperar o webapp: Phantom + serviço aprovam, o operador executa", async () => {
    const ctx = await setupStrict();
    const next = DevMemorySigner.generate("WEBAPP_B");
    const i = await proposeConfig(ctx, rotationActions(ctx.layout.webapp, await next.publicKey(), "WEBAPP"));
    await approve(ctx, i, ctx.keys.client);
    await approve(ctx, i, ctx.keys.server);
    await executeConfig(ctx, i);
    assertAccountModel(await readMultisig(ctx.chain, ctx.multisig), { ...(await roles(ctx)), webapp: (await next.publicKey()).toBase58() });
  });

  it("'Não fui eu' — a troca aprovada é cancelada por dois votantes e o operador não consegue mais executar", async () => {
    const ctx = await setupStrict();
    const thief = DevMemorySigner.generate("WEBAPP_DO_LADRAO");
    const i = await proposeConfig(ctx, rotationActions(ctx.layout.webapp, await thief.publicKey(), "WEBAPP"));
    await approve(ctx, i, ctx.keys.client); // seed vazada
    await approve(ctx, i, ctx.keys.server); // serviço aprovou e esperaria o prazo
    expect((await readProposal(ctx.chain, ctx.multisig, i))?.status).toBe("Approved");
    for (const k of [ctx.keys.webapp, ctx.keys.server]) await sendInstructions(ctx.chain, [cancelIx(ctx.multisig, i, await k.publicKey())], [ctx.keys.relayer, k]);
    expect((await readProposal(ctx.chain, ctx.multisig, i))?.status).toBe("Cancelled");
    expect(await chainError(executeConfig(ctx, i))).toBe("InvalidProposalStatus");
  });

  it("CONFIANÇA no serviço — webapp + serviço aprovam um envio sem a Phantom: o programa aceita, por isso o serviço nunca vota em envios", async () => {
    const ctx = await setupStrict();
    const to = attacker();
    const i = await proposeTransfer(ctx, to, SOL);
    await approve(ctx, i, ctx.keys.webapp);
    await approve(ctx, i, ctx.keys.server);
    await executeVault(ctx, i);
    expect(await ctx.chain.getBalance(to)).toBe(SOL);
  });
});

describe("comportamentos da Squads v4 que o desenho usa", () => {
  it("troca executada torna stale as propostas abertas", async () => {
    const ctx = await setupStrict();
    const open = await proposeTransfer(ctx, attacker(), SOL);
    const i = await proposeConfig(ctx, rotationActions(ctx.layout.server, await DevMemorySigner.generate("S2").publicKey(), "SERVER"));
    await approve(ctx, i, ctx.keys.client);
    await approve(ctx, i, ctx.keys.server);
    await executeConfig(ctx, i);
    expect(await chainError(approve(ctx, open, ctx.keys.client))).toBe("StaleProposal");
  });

  it("troca APROVADA mais antiga: depois de outra troca executada, não executa mais (stale)", async () => {
    const ctx = await setupStrict();
    const a = await proposeConfig(ctx, rotationActions(ctx.layout.webapp, await DevMemorySigner.generate("W2").publicKey(), "WEBAPP"));
    await approve(ctx, a, ctx.keys.client);
    await approve(ctx, a, ctx.keys.server);
    const b = await proposeConfig(ctx, rotationActions(ctx.layout.server, await DevMemorySigner.generate("S2").publicKey(), "SERVER"));
    await approve(ctx, b, ctx.keys.client);
    await approve(ctx, b, ctx.keys.webapp);
    await executeConfig(ctx, b);
    const err = await chainError(sendInstructions(ctx.chain, [executeConfigIx(ctx.multisig, a, ctx.layout.operator, await ctx.keys.relayer.publicKey())], [ctx.keys.relayer, ctx.keys.operator]));
    expect(err).toBe("StaleProposal");
  });

  it("PERIGO evitado: adicionar e remover em transações separadas daria 3 votantes do lado do usuário", async () => {
    const ctx = await setupStrict();
    const extra = DevMemorySigner.generate("EXTRA");
    const i = await proposeConfig(ctx, [{ __kind: "AddMember", newMember: { key: await extra.publicKey(), permissions: multisig.types.Permissions.fromPermissions([multisig.types.Permission.Vote]) } }]);
    await approve(ctx, i, ctx.keys.client);
    await approve(ctx, i, ctx.keys.webapp);
    await executeConfig(ctx, i);
    // Com 4 votantes e threshold 2, Phantom + extra (ambos do usuário) aprovam sem o serviço — por isso a troca é atômica e a política recusa AddMember solto.
    const to = attacker();
    const j = await proposeTransfer(ctx, to, SOL);
    await approve(ctx, j, ctx.keys.client);
    await approve(ctx, j, extra);
    await executeVault(ctx, j);
    expect(await ctx.chain.getBalance(to)).toBe(SOL);
  });
});
