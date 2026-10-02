import { LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { DevMemorySigner } from "@duplachave/crypto";
import { DefaultPolicyEngine } from "@duplachave/policy-engine";
import {
  CustodyService,
  DevServerKeyProvider,
  type Email,
  EmailNotificationService,
  LogNotificationService,
  MemoryStore,
  reviewPrepared,
  reviewSecurityRequest,
  signAsWallet,
  type SecurityChangeRole,
  verifyAuthorized,
  vetoMessage,
} from "@duplachave/custody";
import { migrate, openPglite, openPostgres, PgStore } from "@duplachave/database";
import { LiteSvmChain } from "./litesvm-chain";

/** Banco novo por teste num Postgres real (DK_TEST_PG = URL de admin). */
async function postgresStore() {
  const admin = process.env.DK_TEST_PG ?? "postgres://postgres:dk@127.0.0.1:55432/dk";
  const name = `dk_${Math.random().toString(36).slice(2, 10)}`;
  const root = await openPostgres(admin);
  await root.exec(`CREATE DATABASE ${name}`);
  const db = await openPostgres(admin.replace(/\/[^/]*$/, `/${name}`));
  await migrate(db);
  return new PgStore(db);
}

async function pgliteStore() {
  const db = await openPglite();
  await migrate(db);
  return new PgStore(db);
}

const fromB64 = (b64: string) => VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
export const fakeBlob = (deviceName = "Celular de teste") => ({ credentialId: `cred-${Math.random().toString(36).slice(2)}`, salt: "c2FsdA", iv: "aXY", ciphertext: "Y2lmcmFkbw", deviceName });

/**
 * Backend completo sobre LiteSVM, modelo 2 de 3: a Phantom (WALLET_A) e a
 * chave do webapp (WEBAPP_A) do usuário, mais o serviço. O serviço não tem SOL.
 */
export async function setupService(opts: { depositSol?: number; walletSol?: number; store?: "memory" | "pglite" | "postgres"; securityDelay?: number; mailer?: { send(m: Email, key?: string): Promise<unknown> } } = {}) {
  const chain = new LiteSvmChain();
  let offset = 0;
  const now = () => Math.floor(Date.now() / 1000) + offset;
  const service = { operator: DevMemorySigner.generate("OPERATOR") };
  chain.warp(now() - (await chain.now()));

  const kind = opts.store ?? process.env.DK_TEST_STORE ?? "memory";
  const store = kind === "pglite" ? await pgliteStore() : kind === "postgres" ? await postgresStore() : new MemoryStore();
  const notifications = opts.mailer
    ? new EmailNotificationService({ mailer: opts.mailer, appUrl: "https://dupla.example", emailOf: async (id) => (await store.getUser(id))?.email ?? null })
    : new LogNotificationService();
  const serverKeys = new DevServerKeyProvider("localnet");
  const custody = new CustodyService({ cluster: "localnet", chain, store, policy: new DefaultPolicyEngine(), serverKeys, service, notifications, now, squadsTreasury: chain.treasury, securityDelay: opts.securityDelay });

  const wallet = DevMemorySigner.generate("WALLET_A");
  const webapp = DevMemorySigner.generate("WEBAPP_A");
  chain.airdrop(await wallet.publicKey(), BigInt(opts.walletSol ?? 1) * BigInt(LAMPORTS_PER_SOL));
  const account = await enrollWallet(custody, wallet, webapp);
  chain.airdrop(new PublicKey(account.vault), BigInt((opts.depositSol ?? 10) * LAMPORTS_PER_SOL));

  const advance = (seconds: number) => {
    offset += seconds;
    chain.warp(seconds);
  };

  /** O serviço prepara, o webapp confere (remontando os bytes) e assina com a chave dele, o operador assina, a Phantom assina. */
  const walletTx = async (intentId: string, signer: DevMemorySigner = wallet, key: DevMemorySigner = webapp) => {
    const request = await custody.prepareIntent(intentId);
    const review = await reviewPrepared(chain, request, { client: await signer.publicKey(), webapp: await key.publicKey() }, now());
    const webappSignature = bs58.encode(await key.sign(review.message));
    const { transaction } = await custody.authorizeIntent(intentId, { message: Buffer.from(review.message).toString("base64"), webappSignature });
    return signAsWallet(verifyAuthorized(review, transaction), signer);
  };

  /** Fluxo completo do cliente: preparar, conferir, webapp + operador, Phantom, enviar. */
  const sign = async (intentId: string, signer: DevMemorySigner = wallet, key: DevMemorySigner = webapp) => custody.submitIntent(intentId, await walletTx(intentId, signer, key));

  /**
   * Pede uma troca (passo 1): o webapp confere o pedido; na troca da Phantom a
   * chave do webapp vota; quem paga assina por último.
   */
  const requestChange = async (role: SecurityChangeRole, next: DevMemorySigner | null, by: { client?: DevMemorySigner; webapp?: DevMemorySigner } = {}) => {
    const client = by.client ?? wallet;
    const key = by.webapp ?? webapp;
    const r = await custody.requestSecurityChange(account.id, { role, newKey: next ? (await next.publicKey()).toBase58() : undefined, newKeyBlob: role === "WEBAPP" ? fakeBlob("Aparelho novo") : null });
    const tx = fromB64(r.transaction);
    const message = Buffer.from(tx.message.serialize()).toString("base64");
    const webappSignature = role === "CLIENT" ? bs58.encode(await key.sign(tx.message.serialize())) : undefined;
    const { transaction } = await custody.authorizeSecurityRequest(r.change.id, { message, webappSignature });
    const signed = fromB64(transaction);
    if (role === "WEBAPP" && next) signed.addSignature(await next.publicKey(), await next.sign(signed.message.serialize())); // memo: posse da chave nova
    const payer = role === "CLIENT" ? next! : client;
    const out = await custody.submitSecurityRequest(r.change.id, await signAsWallet(signed, payer));
    return { ...r, change: out, reviewMine: { client: await client.publicKey(), webapp: await key.publicKey() } };
  };

  /** Passo 2: depois do prazo, o operador assina a execução e quem paga assina. */
  const executeChange = async (changeId: string, payer: DevMemorySigner) => {
    const r = await custody.prepareSecurityExecute(changeId);
    return custody.submitSecurityExecute(changeId, await signAsWallet(fromB64(r.transaction), payer));
  };

  /** "Não fui eu", assinado pela chave indicada. */
  const veto = async (changeId: string, by: DevMemorySigner) => {
    const c = (await store.getSecurityChange(changeId))!;
    const acc = (await store.getAccount(account.id))!;
    const text = vetoMessage({ id: c.id, multisig: acc.multisig, role: c.role, newKey: c.newKey });
    return custody.vetoSecurityChange(changeId, { publicKey: (await by.publicKey()).toBase58(), signature: bs58.encode(await by.sign(new TextEncoder().encode(text))) });
  };

  return { chain, custody, store, notifications, serverKeys, service, wallet, webapp, account, now, advance, walletTx, sign, requestChange, executeChange, veto, reviewSecurityRequest };
}

/** Cadastro: o serviço prepara a criação da multisig; a chave do webapp e a Phantom assinam o memo; a Phantom paga. */
export async function enrollWallet(custody: CustodyService, wallet: DevMemorySigner, webapp: DevMemorySigner = DevMemorySigner.generate("WEBAPP"), walletName = "Phantom") {
  const p = await custody.prepareEnrollment({ publicKey: (await wallet.publicKey()).toBase58(), webappPublicKey: (await webapp.publicKey()).toBase58(), walletName });
  const tx = fromB64(p.transaction);
  tx.addSignature(await webapp.publicKey(), await webapp.sign(tx.message.serialize()));
  const { account } = await custody.submitEnrollment(p.enrollmentId, await signAsWallet(tx, wallet), fakeBlob());
  return account;
}

export type ServiceCtx = Awaited<ReturnType<typeof setupService>>;
