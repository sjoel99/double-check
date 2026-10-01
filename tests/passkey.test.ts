/**
 * Biometria (passkey): o serviço só assina a parte dele depois de uma
 * confirmação biométrica válida sobre os bytes exatos da transação.
 */
import { describe, expect, it } from "vitest";
import { Keypair, LAMPORTS_PER_SOL, VersionedTransaction } from "@solana/web3.js";
import { DevMemorySigner, passkeyBindingMessage, softCreate, softGet, transactionChallenge } from "@duplachave/crypto";
import { SecurityError } from "@duplachave/shared";
import { credentialTag, reviewPrepared, verifyAuthorized } from "@duplachave/custody";
import { enrollWallet, ORIGIN, registerPasskey, RP_ID, setupService } from "./support/service";

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

async function prepared(t: Awaited<ReturnType<typeof setupService>>) {
  const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
  const request = await t.custody.prepareIntent(r.intent.id);
  const review = await reviewPrepared(t.chain, request, await t.wallet.publicKey(), t.now());
  return { id: r.intent.id, request, review, message: Buffer.from(review.message).toString("base64") };
}

describe("biometria antes da assinatura do serviço", () => {
  it("a transação preparada não tem a assinatura do serviço; só sai com a biometria", async () => {
    const t = await setupService();
    const p = await prepared(t);
    const serverIdx = (tx: VersionedTransaction) => tx.message.staticAccountKeys.findIndex((k) => k.toBase58() === t.account.roles.server);
    const before = VersionedTransaction.deserialize(Buffer.from(p.request.transaction, "base64"));
    expect(before.signatures[serverIdx(before)]!.every((b) => b === 0)).toBe(true);
    const assertion = await softGet(t.passkey, { challenge: await transactionChallenge(p.review.message), rpId: RP_ID, origin: ORIGIN });
    const out = await t.custody.authorizeIntent(p.id, { message: p.message, assertion });
    const after = verifyAuthorized(p.review, out.transaction);
    expect(after.signatures[serverIdx(after)]!.some((b) => b !== 0)).toBe(true);
    const events = (await t.store.listAudit(t.account.id)).filter((e) => e.type === "SERVER_APPROVED");
    expect(events).toHaveLength(1);
    expect(events[0]!.details.device).toBe("Celular de teste");
  });

  it("biometria sobre outra transação, de outra origem ou de outra conta: recusada", async () => {
    const t = await setupService();
    const p = await prepared(t);
    const other = await transactionChallenge(new Uint8Array([1, 2, 3]));
    expect(await code(t.custody.authorizeIntent(p.id, { message: p.message, assertion: await softGet(t.passkey, { challenge: other, rpId: RP_ID, origin: ORIGIN }) }))).toBe("PASSKEY_INVALID");
    const challenge = await transactionChallenge(p.review.message);
    expect(await code(t.custody.authorizeIntent(p.id, { message: p.message, assertion: await softGet(t.passkey, { challenge, rpId: RP_ID, origin: "https://phishing.test" }) }))).toBe("PASSKEY_INVALID");
    const stranger = (await softCreate({ challenge: "AAAA", rpId: RP_ID, origin: ORIGIN })).credential;
    expect(await code(t.custody.authorizeIntent(p.id, { message: p.message, assertion: await softGet(stranger, { challenge, rpId: RP_ID, origin: ORIGIN }) }))).toBe("PASSKEY_UNKNOWN");
    // Uma mensagem que o serviço não preparou não é assinada nem com biometria válida.
    const forged = Buffer.from(p.review.message);
    forged[forged.length - 1]! ^= 1;
    expect(
      await code(t.custody.authorizeIntent(p.id, { message: forged.toString("base64"), assertion: await softGet(t.passkey, { challenge: await transactionChallenge(forged), rpId: RP_ID, origin: ORIGIN }) })),
    ).toBe("TX_NOT_EXPECTED");
  });

  it("conta sem biometria não assina nada: PASSKEY_REQUIRED", async () => {
    const t = await setupService();
    const w = DevMemorySigner.generate("SEM_BIOMETRIA");
    t.chain.airdrop(await w.publicKey(), SOL);
    const acc = await enrollWallet(t.custody, w);
    t.chain.airdrop(new (await import("@solana/web3.js")).PublicKey(acc.vault), 2n * SOL);
    const r = await t.custody.createTransferSol(acc.id, { destination: dest(), amountLamports: SOL.toString() });
    const request = await t.custody.prepareIntent(r.intent.id);
    const review = await reviewPrepared(t.chain, request, await w.publicKey(), t.now());
    const assertion = await softGet(t.passkey, { challenge: await transactionChallenge(review.message), rpId: RP_ID, origin: ORIGIN });
    expect(await code(t.custody.authorizeIntent(r.intent.id, { message: Buffer.from(review.message).toString("base64"), assertion }))).toBe("PASSKEY_REQUIRED");
  });
});

describe("vincular biometria", () => {
  it("o vínculo tem que ser assinado pela carteira da conta, numa origem permitida", async () => {
    const t = await setupService();
    expect(await code(t.custody.passkeyRegistrationOptions(t.account.id, "https://phishing.test", "x"))).toBe("ORIGIN_NOT_ALLOWED");
    const o = await t.custody.passkeyRegistrationOptions(t.account.id, ORIGIN, "Notebook");
    const { response } = await softCreate({ challenge: o.options.challenge, rpId: RP_ID, origin: ORIGIN });
    const thief = DevMemorySigner.generate("LADRAO");
    const text = passkeyBindingMessage({ publicKey: t.account.roles.client, account: t.account.multisig, cluster: "localnet", credential: credentialTag(response.id), device: "Notebook", challenge: o.options.challenge });
    const sig = (await import("bs58")).default.encode(await thief.sign(new TextEncoder().encode(text)));
    expect(await code(t.custody.registerPasskey(t.account.id, { challengeId: o.challengeId, response, walletSignature: sig }))).toBe("BAD_SIGNATURE");
  });

  it("segunda biometria sem aprovação de uma ativa espera o prazo; com aprovação vale na hora", async () => {
    const t = await setupService();
    const late = await registerPasskey(t.custody, t.account.id, t.wallet, { device: "Aparelho novo" });
    expect(late.status).toBe("PENDING");
    const r = await t.custody.createTransferSol(t.account.id, { destination: dest(), amountLamports: SOL.toString() });
    expect(await code(t.walletTx(r.intent.id, t.wallet, { passkey: late }))).toBe("PASSKEY_UNKNOWN");
    t.advance(121);
    expect(await code(t.walletTx(r.intent.id, t.wallet, { passkey: late }))).toBe("NO_ERROR");

    const approved = await registerPasskey(t.custody, t.account.id, t.wallet, { device: "Tablet", approval: t.passkey });
    expect(approved.status).toBe("ACTIVE");
    const types = (await t.store.listAudit(t.account.id)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["PASSKEY_ADDED", "PASSKEY_PENDING"]));
    expect(t.notifications.sent.some((n) => JSON.stringify(n).includes("PASSKEY_PENDING"))).toBe(true);
  });
});
