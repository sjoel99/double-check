/**
 * Regressões dos achados da revisão de segurança de 2026-10-01 (A2–A5),
 * adaptadas ao fluxo da carteira comum.
 */
import { describe, expect, it } from "vitest";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { DevMemorySigner } from "@duplachave/crypto";
import { SecurityError } from "@duplachave/shared";
import { buildWalletTransaction, signAsWallet, signWalletPossession } from "@duplachave/custody";
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

/** A n-ésima transação enviada falha (simula RPC/execução quebrada). */
function failNth(t: Awaited<ReturnType<typeof setupService>>, nth: number) {
  const orig = t.chain.sendTransaction.bind(t.chain);
  let n = 0;
  t.chain.sendTransaction = async (tx) => {
    if (++n === nth) throw new Error("falha simulada");
    return orig(tx);
  };
  return () => (t.chain.sendTransaction = orig);
}

describe("A2 — aprovada e não executada", () => {
  it("operação: aprovar e executar é atômico, então nunca sobra aprovada pendente", async () => {
    const t = await setupService({ depositSol: 10 });
    const r1 = await t.custody.createTransferSol(t.account.id, { destination: Keypair.generate().publicKey.toBase58(), amountLamports: (6n * SOL).toString() });
    const r2 = await t.custody.createTransferSol(t.account.id, { destination: Keypair.generate().publicKey.toBase58(), amountLamports: (6n * SOL).toString() });
    await t.sign(r1.intent.id);
    expect(await code(t.sign(r2.intent.id))).toBe("WALLET_TX_FAILED");
    expect((await readProposal(t.chain, new PublicKey(t.account.multisig), BigInt(r2.intent.transactionIndex)))?.status).toBe("Active");
    // A troca de carteira segue normal (e drena a pendente).
    expect((await t.custody.requestClientRotation(t.account.id)).rotation.status).toBe("REQUESTED");
  });

  it("rotação cujo execute falha: APPROVED_PENDING_EXECUTION, segue congelada, e executar de novo conclui", async () => {
    const t = await setupService();
    const b = DevMemorySigner.generate("WALLET_B");
    const { rotation, intent } = await t.rotateTo(b);
    const signed = await t.walletTx(intent.id);
    const restore = failNth(t, 2); // 1: transação da carteira, 2: execute do executor
    const out = await t.custody.submitWalletTransaction(intent.id, signed);
    restore();
    expect(out.status).toBe("APPROVED_PENDING_EXECUTION");
    expect((await t.store.getAccount(t.account.id))!.frozenBy).toBe(rotation.id);
    t.advance(3600);
    await t.custody.expireDue(t.account.id);
    expect((await t.store.getIntent(intent.id))!.status).toBe("APPROVED_PENDING_EXECUTION");
    expect((await t.custody.retryExecution(intent.id)).status).toBe("EXECUTED");
    expect((await t.store.getRotation(rotation.id))!.status).toBe("COMPLETED");
  });

  it("aprovada não executada pode ser cancelada pela carteira + servidor, e descongela", async () => {
    const t = await setupService();
    const { rotation, intent } = await t.rotateTo(DevMemorySigner.generate("WALLET_B"));
    const signed = await t.walletTx(intent.id);
    const restore = failNth(t, 2);
    await t.custody.submitWalletTransaction(intent.id, signed);
    restore();
    const request = await t.custody.approvalRequest(intent.id);
    expect(request.mode).toBe("CANCEL");
    const { transaction } = await buildWalletTransaction({ chain: t.chain, request, wallet: await t.wallet.publicKey(), now: t.now() });
    expect((await t.custody.submitWalletTransaction(intent.id, await signAsWallet(transaction, t.wallet))).status).toBe("CANCELLED");
    expect((await readProposal(t.chain, new PublicKey(t.account.multisig), BigInt(intent.transactionIndex)))?.status).toBe("Cancelled");
    expect((await t.store.getRotation(rotation.id))!.status).toBe("REJECTED");
    expect((await t.store.getAccount(t.account.id))!.frozenBy).toBeNull();
  });
});

describe("A3 — rotação que falha no meio", () => {
  it("falha ao criar a ConfigTransaction encerra a rotação e descongela", async () => {
    const t = await setupService();
    const { rotation, fields } = await t.custody.requestClientRotation(t.account.id);
    const proof = await signWalletPossession(DevMemorySigner.generate("WALLET_B"), fields);
    const restore = failNth(t, 1);
    expect(await code(t.custody.proveClientRotationKey(rotation.id, proof))).toContain("falha simulada");
    restore();
    expect((await t.store.getRotation(rotation.id))!.status).toBe("FAILED");
    expect((await t.store.getAccount(t.account.id))!.frozenBy).toBeNull();
    t.advance(24 * 3600);
    expect(await code(t.custody.expireDue(t.account.id))).toBe("NO_ERROR");
    expect((await t.custody.requestClientRotation(t.account.id)).rotation.status).toBe("REQUESTED");
  });
});

describe("A4 — papel da rotação e prova de posse", () => {
  it("pedido do servidor que falha vai para FAILED; prova de carteira não entra em rotação do servidor", async () => {
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

    await t.store.saveRotation({ ...stuck, id: crypto.randomUUID(), status: "REQUESTED", history: [] });
    const open = (await t.store.listRotations(t.account.id)).find((r) => r.status === "REQUESTED")!;
    const proof = await signWalletPossession(DevMemorySigner.generate("USER_SECOND"), { operation: "ROTATE_CLIENT_KEY", account: t.account.multisig, cluster: "localnet", challenge: open.challenge, expiresAt: open.expiresAt });
    expect(await code(t.custody.proveClientRotationKey(open.id, proof))).toBe("ROTATION_WRONG_ROLE");
  });

  it("o app recusa rotação sem prova de posse válida", async () => {
    const t = await setupService();
    const { intent } = await t.custody.requestServerRotation(t.account.id, "programada");
    const request = await t.custody.approvalRequest(intent.id);
    const me = await t.wallet.publicKey();
    expect(await code(buildWalletTransaction({ chain: t.chain, request: { ...request, possession: null }, wallet: me, now: t.now() }))).toBe("ROTATION_PROOF_MISSING");
    const forged = { ...request.possession!, signature: request.possession!.signature.replace(/.$/, (c) => (c === "1" ? "2" : "1")) };
    expect(await code(buildWalletTransaction({ chain: t.chain, request: { ...request, possession: forged }, wallet: me, now: t.now() }))).toBe("ROTATION_PROOF_INVALID");
  });

  it("o app recusa troca de carteira que não foi pedida nele", async () => {
    const t = await setupService();
    const { intent } = await t.rotateTo(DevMemorySigner.generate("WALLET_B"));
    expect(await code(t.walletTx(intent.id, t.wallet, { initiatedHere: () => false }))).toBe("ROTATION_NOT_REQUESTED_HERE");
  });
});

describe("A5 — expiração concorrendo com a decisão", () => {
  it("expireDue espera a decisão em andamento: a rotação termina COMPLETED, não EXPIRED", async () => {
    const t = await setupService();
    const b = DevMemorySigner.generate("WALLET_B");
    const { rotation, intent } = await t.rotateTo(b);
    const signed = await t.walletTx(intent.id);
    const orig = t.chain.sendTransaction.bind(t.chain);
    let n = 0;
    let concurrent: Promise<unknown> | null = null;
    t.chain.sendTransaction = async (tx) => {
      const sig = await orig(tx);
      if (++n === 1) {
        t.advance(intent.expiresAt - t.now() + 1);
        concurrent = t.custody.expireDue(t.account.id); // o job de 30 s dispara aqui
      }
      return sig;
    };
    expect((await t.custody.submitWalletTransaction(intent.id, signed)).status).toBe("EXECUTED");
    t.chain.sendTransaction = orig;
    await concurrent;
    expect((await t.store.getRotation(rotation.id))!.status).toBe("COMPLETED");
    const state = await readMultisig(t.chain, new PublicKey(t.account.multisig));
    expect(state.members.some((m) => m.key === (b as unknown as { toJSON(): { publicKey: string } }).toJSON().publicKey)).toBe(true);
  });
});
