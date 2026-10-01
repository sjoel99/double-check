import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { DevMemorySigner } from "@duplachave/crypto";
import { DefaultPolicyEngine } from "@duplachave/policy-engine";
import {
  CustodyService,
  DevServerKeyProvider,
  LogNotificationService,
  MemoryStore,
  reviewPrepared,
  signAsWallet,
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
  const custody = new CustodyService({ cluster: "localnet", chain, store, policy: new DefaultPolicyEngine(), serverKeys, service, notifications, now, squadsTreasury: chain.treasury });

  const wallet = DevMemorySigner.generate("WALLET_A");
  chain.airdrop(await wallet.publicKey(), BigInt(opts.walletSol ?? 1) * BigInt(LAMPORTS_PER_SOL));
  const account = await enrollWallet(custody, wallet);
  chain.airdrop(new PublicKey(account.vault), BigInt((opts.depositSol ?? 10) * LAMPORTS_PER_SOL));

  const advance = (seconds: number) => {
    offset += seconds;
    chain.warp(seconds);
  };

  /** O serviço prepara, o app confere (remontando os bytes) e a carteira assina. Devolve o base64. */
  const walletTx = async (intentId: string, signer: DevMemorySigner = wallet, extra: { initiatedHere?: (id: string) => boolean } = {}) => {
    const request = await custody.prepareIntent(intentId);
    const { transaction } = await reviewPrepared(chain, request, await signer.publicKey(), now(), extra);
    return signAsWallet(transaction, signer);
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

  return { chain, custody, store, notifications, serverKeys, service, wallet, account, now, advance, walletTx, sign, rotateTo };
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
