import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { DevMemorySigner, passkeyBindingMessage, type SoftCredential, softCreate, softGet, transactionChallenge } from "@duplachave/crypto";
import { DefaultPolicyEngine } from "@duplachave/policy-engine";
import {
  CustodyService,
  DevServerKeyProvider,
  LogNotificationService,
  MemoryStore,
  credentialTag,
  reviewPrepared,
  signAsWallet,
  verifyAuthorized,
  signWalletPossession,
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

/**
 * Backend completo sobre LiteSVM, com relógio controlável e a carteira comum
 * do usuário (WALLET_A, como seria a Phantom) já cadastrada. O serviço não tem
 * SOL nenhum: quem paga tudo é a carteira.
 */
export async function setupService(opts: { depositSol?: number; walletSol?: number; store?: "memory" | "pglite" | "postgres" } = {}) {
  const chain = new LiteSvmChain();
  let offset = 0;
  const now = () => Math.floor(Date.now() / 1000) + offset;
  const service = {
    executor: DevMemorySigner.generate("EXECUTOR"),
    proposer: DevMemorySigner.generate("PROPOSER"),
  };
  chain.warp(now() - (await chain.now()));

  const kind = opts.store ?? process.env.DK_TEST_STORE ?? "memory";
  const store = kind === "pglite" ? await pgliteStore() : kind === "postgres" ? await postgresStore() : new MemoryStore();
  const notifications = new LogNotificationService();
  const serverKeys = new DevServerKeyProvider("localnet");
  const custody = new CustodyService({ cluster: "localnet", chain, store, policy: new DefaultPolicyEngine(), serverKeys, service, notifications, now, squadsTreasury: chain.treasury, passkeys: { origins: [ORIGIN], resetDelay: 120 } });

  const wallet = DevMemorySigner.generate("WALLET_A");
  chain.airdrop(await wallet.publicKey(), BigInt(opts.walletSol ?? 1) * BigInt(LAMPORTS_PER_SOL));
  const account = await enrollWallet(custody, wallet);
  const passkey = await registerPasskey(custody, account.id, wallet);
  chain.airdrop(new PublicKey(account.vault), BigInt((opts.depositSol ?? 10) * LAMPORTS_PER_SOL));

  const advance = (seconds: number) => {
    offset += seconds;
    chain.warp(seconds);
  };

  /**
   * O serviço prepara, o app confere (remontando os bytes), a biometria confirma
   * esses bytes, o serviço assina, o app confere as assinaturas e a carteira assina.
   */
  const walletTx = async (intentId: string, signer: DevMemorySigner = wallet, extra: { initiatedHere?: (id: string) => boolean; passkey?: SoftCredential } = {}) => {
    const request = await custody.prepareIntent(intentId);
    const review = await reviewPrepared(chain, request, await signer.publicKey(), now(), extra);
    const assertion = await softGet(extra.passkey ?? passkey, { challenge: await transactionChallenge(review.message), rpId: RP_ID, origin: ORIGIN });
    const { transaction } = await custody.authorizeIntent(intentId, { message: Buffer.from(review.message).toString("base64"), assertion });
    return signAsWallet(verifyAuthorized(review, transaction), signer);
  };

  /** Fluxo completo do cliente: preparar, conferir, assinar na carteira, enviar. */
  const sign = async (intentId: string, signer: DevMemorySigner = wallet) => custody.submitIntent(intentId, await walletTx(intentId, signer));

  /** Troca de carteira: a atual pede, a nova prova posse. */
  const rotateTo = async (next: DevMemorySigner) => {
    const { rotation, fields } = await custody.requestClientRotation(account.id);
    const proof = await signWalletPossession(next, fields);
    const out = await custody.proveClientRotationKey(rotation.id, proof);
    void rotation;
    return { fields, proof, rotation: out.rotation, intent: out.intent };
  };

  return { chain, custody, store, notifications, serverKeys, service, wallet, account, passkey, now, advance, walletTx, sign, rotateTo };
}

export const ORIGIN = "https://app.test";
export const RP_ID = "app.test";

/** Vincula a biometria de teste: cria a passkey, a carteira assina o texto de vínculo. */
export async function registerPasskey(custody: CustodyService, accountId: string, wallet: DevMemorySigner, opts: { approval?: SoftCredential; device?: string; origin?: string } = {}) {
  const origin = opts.origin ?? ORIGIN;
  const rpId = new URL(origin).hostname;
  const device = opts.device ?? "Celular de teste";
  const o = await custody.passkeyRegistrationOptions(accountId, origin, device);
  const { credential, response } = await softCreate({ challenge: o.options.challenge, rpId, origin });
  const acc = (await (custody as unknown as { store: { getAccount(id: string): Promise<{ multisig: string }> } }).store.getAccount(accountId))!;
  const text = passkeyBindingMessage({ publicKey: (await wallet.publicKey()).toBase58(), account: acc.multisig, cluster: "localnet", credential: credentialTag(credential.id), device, challenge: o.options.challenge });
  const walletSignature = (await import("bs58")).default.encode(await wallet.sign(new TextEncoder().encode(text)));
  const approval = opts.approval ? await softGet(opts.approval, { challenge: Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).toString("base64url"), rpId, origin }) : null;
  const out = await custody.registerPasskey(accountId, { challengeId: o.challengeId, response, walletSignature, approval });
  return Object.assign(credential, { status: out.status });
}

/** Cadastro: o serviço prepara a criação da multisig, a carteira assina e paga. */
export async function enrollWallet(custody: CustodyService, wallet: DevMemorySigner, walletName = "Phantom") {
  const pk = (await wallet.publicKey()).toBase58();
  const p = await custody.prepareEnrollment({ publicKey: pk, walletName });
  const { VersionedTransaction } = await import("@solana/web3.js");
  const signed = await signAsWallet(VersionedTransaction.deserialize(Buffer.from(p.transaction, "base64")), wallet);
  const { account } = await custody.submitEnrollment(p.enrollmentId, signed);
  return account;
}

export type ServiceCtx = Awaited<ReturnType<typeof setupService>>;
