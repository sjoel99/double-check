/**
 * Regressões: achados da revisão de segurança de 2026-10-01 (A2–A5) e os
 * casos próprios do modelo atômico (transação preparada que ainda pode entrar).
 */
import { describe, expect, it } from "vitest";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { DevMemorySigner } from "@duplachave/crypto";
import { SecurityError } from "@duplachave/shared";
import { PREPARED_WINDOW, reviewPrepared, signAsWallet, signWalletPossession } from "@duplachave/custody";
import { readMultisig } from "@duplachave/squads";
import { setupService } from "./support/service";

const SOL = BigInt(LAMPORTS_PER_SOL);
const dest = () => Keypair.generate().publicKey.toBase58();

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SecurityError) return e.code;
    return `OTHER:${String(e)}`;
  }
  return "NO_ERROR";
}

describe("A2 — nada fica aprovado e não executado", () => {
  it("preparar não escreve na chain; só a transação inteira (com a carteira) entra", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    await t.custody.prepareIntent(r.intent.id);
    await t.custody.prepareIntent(r.intent.id);
    const state = await readMultisig(t.chain, new PublicKey(t.account.multisig));
    expect(state.transactionIndex).toBe(0n);
    expect((await t.store.getIntent(r.intent.id))?.prepared).toHaveLength(2);
  });

  it("duas intenções preparadas no mesmo índice: só uma entra; a outra prepara de novo no índice seguinte", async () => {
    const t = await setupService();
    const a = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    const b = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    const reqA = await t.custody.prepareIntent(a.intent.id);
    const signedA = await signAsWallet((await reviewPrepared(t.chain, reqA, await t.wallet.publicKey(), t.now())).transaction, t.wallet);
    expect((await t.sign(b.intent.id)).intent.transactionIndex).toBe("1");
    expect(await code(t.custody.submitIntent(a.intent.id, signedA))).toBe("WALLET_TX_FAILED");
    const done = await t.sign(a.intent.id);
    expect(done.status).toBe("EXECUTED");
    expect(done.intent.transactionIndex).toBe("2");
  });
});

describe("A3 — transação preparada que entra depois", () => {
  it("recusada no app mas assinada e enviada pela carteira: a chain manda e a intenção vira EXECUTED", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    const signed = await t.walletTx(r.intent.id);
    await t.custody.rejectByClient(r.intent.id);
    // A carteira envia direto para a rede (como o celular faz).
    await t.chain.sendTransaction((await import("@solana/web3.js")).VersionedTransaction.deserialize(Buffer.from(signed, "base64")));
    await t.custody.expireDue(t.account.id);
    const rec = (await t.store.getIntent(r.intent.id))!;
    expect(rec.status).toBe("EXECUTED");
    expect(rec.reasons[0]).toContain("REJECTED");
  });

  it("troca de carteira recusada aqui mas executada na chain: os registros seguem a chain", async () => {
    const t = await setupService();
    const b = DevMemorySigner.generate("WALLET_B");
    const { rotation, intent } = await t.rotateTo(b);
    const signed = await t.walletTx(intent.id);
    await t.custody.rejectByClient(intent.id);
    expect((await t.store.getRotation(rotation.id))?.status).toBe("REJECTED");
    await t.chain.sendTransaction((await import("@solana/web3.js")).VersionedTransaction.deserialize(Buffer.from(signed, "base64")));
    await t.custody.expireDue(t.account.id);
    expect((await t.store.getRotation(rotation.id))?.status).toBe("COMPLETED");
    expect((await t.store.getAccount(t.account.id))!.roles.client).toBe((await b.publicKey()).toBase58());
    expect((await t.custody.securityOverview(t.account.id)).invariantOk).toBe(true);
  });

  it("expireDue não vence intenção com transação preparada ainda válida; depois da janela, vence", async () => {
    const t = await setupService();
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    t.advance(r.intent.expiresAt - t.now() - 1);
    await t.custody.prepareIntent(r.intent.id);
    t.advance(2);
    await t.custody.expireDue(t.account.id);
    expect((await t.store.getIntent(r.intent.id))?.status).toBe("AWAITING_CLIENT");
    t.advance(PREPARED_WINDOW);
    await t.custody.expireDue(t.account.id);
    const rec = (await t.store.getIntent(r.intent.id))!;
    expect(rec.status).toBe("EXPIRED");
    expect(rec.prepared).toEqual([]);
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

    await t.store.saveRotation({ ...stuck, id: crypto.randomUUID(), status: "REQUESTED", history: [] });
    const open = (await t.store.listRotations(t.account.id)).find((r) => r.status === "REQUESTED")!;
    const proof = await signWalletPossession(DevMemorySigner.generate("USER_SECOND"), { operation: "ROTATE_CLIENT_KEY", account: t.account.multisig, cluster: "localnet", challenge: open.challenge, expiresAt: open.expiresAt });
    expect(await code(t.custody.proveClientRotationKey(open.id, proof))).toBe("ROTATION_WRONG_ROLE");
  });

  it("o app recusa rotação sem prova de posse válida", async () => {
    const t = await setupService();
    const { intent } = await t.custody.requestServerRotation(t.account.id, "programada");
    const request = await t.custody.prepareIntent(intent.id);
    const me = await t.wallet.publicKey();
    expect(await code(reviewPrepared(t.chain, { ...request, possession: null }, me, t.now()))).toBe("ROTATION_PROOF_MISSING");
    const forged = { ...request.possession!, signature: request.possession!.signature.replace(/.$/, (c) => (c === "1" ? "2" : "1")) };
    expect(await code(reviewPrepared(t.chain, { ...request, possession: forged }, me, t.now()))).toBe("ROTATION_PROOF_INVALID");
  });

  it("o app recusa troca de carteira que não foi pedida nele", async () => {
    const t = await setupService();
    const { intent } = await t.rotateTo(DevMemorySigner.generate("WALLET_B"));
    expect(await code(t.walletTx(intent.id, t.wallet, { initiatedHere: () => false }))).toBe("ROTATION_NOT_REQUESTED_HERE");
  });
});

describe("A5 — expiração concorrendo com a decisão", () => {
  it("expireDue espera o envio em andamento: a rotação termina COMPLETED, não EXPIRED", async () => {
    const t = await setupService();
    const b = DevMemorySigner.generate("WALLET_B");
    const { rotation, intent } = await t.rotateTo(b);
    const signed = await t.walletTx(intent.id);
    const orig = t.chain.sendTransaction.bind(t.chain);
    let concurrent: Promise<unknown> | null = null;
    t.chain.sendTransaction = async (tx) => {
      const sig = await orig(tx);
      t.advance(intent.expiresAt - t.now() + PREPARED_WINDOW + 1);
      concurrent = t.custody.expireDue(t.account.id); // o job de 30 s dispara aqui
      return sig;
    };
    expect((await t.custody.submitIntent(intent.id, signed)).status).toBe("EXECUTED");
    t.chain.sendTransaction = orig;
    await concurrent;
    expect((await t.store.getRotation(rotation.id))!.status).toBe("COMPLETED");
    const state = await readMultisig(t.chain, new PublicKey(t.account.multisig));
    expect(state.members.some((m) => m.key === t.account.roles.client)).toBe(false);
  });
});
