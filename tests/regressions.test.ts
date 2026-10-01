/**
 * Regressões dos achados da revisão de segurança de 2026-10-01 (A2–A5).
 * Cada teste reproduz o ataque/falha original e confere o comportamento corrigido.
 */
import { describe, expect, it } from "vitest";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { DevMemorySigner } from "@duplachave/crypto";
import { SecurityError } from "@duplachave/shared";
import { signClientDecision, signPossession } from "@duplachave/custody";
import { readMultisig, readProposal } from "@duplachave/squads";
import { setupService } from "./support/service";

const SOL = BigInt(LAMPORTS_PER_SOL);

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SecurityError) return e.code;
    return `OTHER:${String(e)}`;
  }
  return "NO_ERROR";
}

/** Faz a próxima transação cujo predicado bater falhar (simula RPC/execução quebrada). */
function failOnce(t: Awaited<ReturnType<typeof setupService>>, nth: number) {
  const orig = t.chain.sendTransaction.bind(t.chain);
  let n = 0;
  t.chain.sendTransaction = async (tx) => {
    if (++n === nth) throw new Error("falha simulada");
    return orig(tx);
  };
  return () => (t.chain.sendTransaction = orig);
}

describe("A2 — aprovada e não executada", () => {
  it("o servidor simula de novo antes de votar: a segunda de 6 SOL num vault de 10 é rejeitada, não aprovada", async () => {
    const t = await setupService({ depositSol: 10 });
    const r1 = await t.custody.createTransferSol(t.account.id, { destination: Keypair.generate().publicKey.toBase58(), amountLamports: (6n * SOL).toString() });
    const r2 = await t.custody.createTransferSol(t.account.id, { destination: Keypair.generate().publicKey.toBase58(), amountLamports: (6n * SOL).toString() });
    expect((await t.custody.submitClientDecision(r1.intent.id, await t.decide(r1.intent.id))).status).toBe("EXECUTED");
    const out2 = await t.custody.submitClientDecision(r2.intent.id, await t.decide(r2.intent.id));
    expect(out2.status).toBe("REJECTED");
    expect(out2.reasons.join()).toMatch(/SIMULATION_FAILED/);
    expect((await readProposal(t.chain, new PublicKey(t.account.multisig), BigInt(r2.intent.transactionIndex)))?.status).toBe("Rejected");
    // E a troca de aparelho segue normal.
    expect((await t.custody.requestClientRotation(t.account.id, { newDeviceName: "novo" })).status).toBe("REQUESTED");
  });

  it("execução que falha vira APPROVED_PENDING_EXECUTION; rotação é recusada sem congelar; tentar de novo executa", async () => {
    const t = await setupService();
    const dest = Keypair.generate().publicKey;
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest.toBase58(), amountLamports: SOL.toString() });
    const payload = await t.decide(r.intent.id);
    const restore = failOnce(t, 3); // 1: voto do cliente, 2: voto do servidor, 3: execute
    const out = await t.custody.submitClientDecision(r.intent.id, payload);
    restore();
    expect(out.status).toBe("APPROVED_PENDING_EXECUTION");

    expect(await code(t.custody.requestClientRotation(t.account.id, { newDeviceName: "novo" }))).toBe("APPROVED_PENDING");
    expect((await t.store.getAccount(t.account.id))!.frozenBy).toBeNull();
    t.advance(3600);
    await t.custody.expireDue(t.account.id);
    expect((await t.store.getIntent(r.intent.id))!.status).toBe("APPROVED_PENDING_EXECUTION");

    expect((await t.custody.retryExecution(r.intent.id)).status).toBe("EXECUTED");
    expect(await t.chain.getBalance(dest)).toBe(SOL);
  });

  it("aprovada não executada pode ser cancelada pelo cliente + servidor", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: Keypair.generate().publicKey.toBase58(), amountLamports: SOL.toString() });
    const payload = await t.decide(r.intent.id);
    const restore = failOnce(t, 3);
    await t.custody.submitClientDecision(r.intent.id, payload);
    restore();
    const request = await t.custody.approvalRequest(r.intent.id);
    const cancel = await signClientDecision({ chain: t.chain, request, signer: t.app, decision: "CANCEL", now: t.now() });
    expect((await t.custody.submitClientDecision(r.intent.id, cancel)).status).toBe("CANCELLED");
    expect((await readProposal(t.chain, new PublicKey(t.account.multisig), BigInt(r.intent.transactionIndex)))?.status).toBe("Cancelled");
    expect(await code(t.custody.retryExecution(r.intent.id))).toBe("INTENT_NOT_PENDING_EXECUTION");
  });
});

describe("A3 — rotação que falha no meio", () => {
  it("falha ao criar a ConfigTransaction encerra a rotação e descongela", async () => {
    const t = await setupService();
    const rot = await t.custody.requestClientRotation(t.account.id, { newDeviceName: "novo" });
    const b = DevMemorySigner.generate("B");
    const restore = failOnce(t, 1);
    expect(await code(t.custody.proveClientRotationKey(rot.id, await signPossession({ signer: b, operation: "ROTATE_CLIENT_KEY", cluster: "localnet", multisig: t.account.multisig, rotationId: rot.id, challenge: rot.challenge, now: t.now() })))).toContain("falha simulada");
    restore();
    expect((await t.store.getRotation(rot.id))!.status).toBe("FAILED");
    expect((await t.store.getAccount(t.account.id))!.frozenBy).toBeNull();
    t.advance(24 * 3600);
    expect(await code(t.custody.expireDue(t.account.id))).toBe("NO_ERROR");
    expect((await t.custody.requestClientRotation(t.account.id, { newDeviceName: "outro" })).status).toBe("REQUESTED");
  });
});

describe("A4 — papel da rotação", () => {
  it("pedido do servidor que falha vai para FAILED; prova de chave do cliente não entra em rotação do servidor", async () => {
    const t = await setupService();
    const orig = t.serverKeys.create.bind(t.serverKeys);
    let fail = true;
    t.serverKeys.create = async (label: string) => {
      if (fail) {
        fail = false;
        throw new Error("KMS indisponível");
      }
      return orig(label);
    };
    expect(await code(t.custody.requestServerRotation(t.account.id, "programada"))).toContain("KMS");
    const stuck = (await t.store.listRotations(t.account.id))[0]!;
    expect(stuck.status).toBe("FAILED");
    expect((await t.store.getAccount(t.account.id))!.frozenBy).toBeNull();

    // Mesmo com uma rotação de SERVIDOR aberta, a prova de chave de cliente é recusada.
    await t.store.saveRotation({ ...stuck, id: crypto.randomUUID(), status: "REQUESTED", history: [] });
    const open = (await t.store.listRotations(t.account.id)).find((r) => r.status === "REQUESTED")!;
    const mine = DevMemorySigner.generate("USER_SECOND_KEY");
    expect(await code(t.custody.proveClientRotationKey(open.id, await signPossession({ signer: mine, operation: "ROTATE_CLIENT_KEY", cluster: "localnet", multisig: t.account.multisig, rotationId: open.id, challenge: open.challenge, now: t.now() })))).toBe("ROTATION_WRONG_ROLE");
  });

  it("o app recusa rotação sem prova de posse válida", async () => {
    const t = await setupService();
    const { intent } = await t.custody.requestServerRotation(t.account.id, "programada");
    const request = await t.custody.approvalRequest(intent.id);
    expect(await code(signClientDecision({ chain: t.chain, request: { ...request, possession: null }, signer: t.app, decision: "APPROVE", now: t.now() }))).toBe("ROTATION_PROOF_MISSING");
    const other = await signPossession({ signer: DevMemorySigner.generate("X"), operation: "ROTATE_SERVER_KEY", cluster: "localnet", multisig: t.account.multisig, rotationId: intent.type === "ROTATE_MEMBER" ? intent.rotationId : "", challenge: "ab".repeat(32), now: t.now() });
    expect(await code(signClientDecision({ chain: t.chain, request: { ...request, possession: other }, signer: t.app, decision: "APPROVE", now: t.now() }))).toBe("ROTATION_PROOF_INVALID");
  });

  it("o app recusa troca da chave do cliente que não foi pedida nele", async () => {
    const t = await setupService();
    const rot = await t.custody.requestClientRotation(t.account.id, { newDeviceName: "novo" });
    const b = DevMemorySigner.generate("B");
    const { intent } = await t.custody.proveClientRotationKey(rot.id, await signPossession({ signer: b, operation: "ROTATE_CLIENT_KEY", cluster: "localnet", multisig: t.account.multisig, rotationId: rot.id, challenge: rot.challenge, now: t.now() }));
    const request = await t.custody.approvalRequest(intent.id);
    expect(await code(signClientDecision({ chain: t.chain, request, signer: t.app, decision: "APPROVE", now: t.now(), initiatedHere: () => false }))).toBe("ROTATION_NOT_REQUESTED_HERE");
  });
});

describe("A5 — expiração concorrendo com a decisão", () => {
  it("expireDue espera a decisão em andamento: a rotação termina COMPLETED, não EXPIRED", async () => {
    const t = await setupService();
    const rot = await t.custody.requestClientRotation(t.account.id, { newDeviceName: "novo" });
    const b = DevMemorySigner.generate("B");
    const { intent } = await t.custody.proveClientRotationKey(rot.id, await signPossession({ signer: b, operation: "ROTATE_CLIENT_KEY", cluster: "localnet", multisig: t.account.multisig, rotationId: rot.id, challenge: rot.challenge, now: t.now() }));
    const payload = await t.decide(intent.id);
    const orig = t.chain.sendTransaction.bind(t.chain);
    let n = 0;
    let concurrent: Promise<unknown> | null = null;
    t.chain.sendTransaction = async (tx) => {
      const sig = await orig(tx);
      if (++n === 2) {
        t.advance(intent.expiresAt - t.now() + 1);
        concurrent = t.custody.expireDue(t.account.id); // o job de 30 s dispara aqui
      }
      return sig;
    };
    expect((await t.custody.submitClientDecision(intent.id, payload)).status).toBe("EXECUTED");
    t.chain.sendTransaction = orig;
    await concurrent;
    expect((await t.store.getRotation(rot.id))!.status).toBe("COMPLETED");
    const state = await readMultisig(t.chain, new PublicKey(t.account.multisig));
    expect(state.members.some((m) => m.key === (b as unknown as { toJSON(): { publicKey: string } }).toJSON().publicKey)).toBe(true);
  });
});
