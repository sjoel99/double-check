import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { DevMemorySigner } from "@duplachave/crypto";
import { DefaultPolicyEngine } from "@duplachave/policy-engine";
import {
  buildWalletTransaction,
  CustodyService,
  DevServerKeyProvider,
  LogNotificationService,
  MemoryStore,
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
 * do usuário (WALLET_A, como seria a Phantom) já cadastrada.
 */
export async function setupService(opts: { depositSol?: number; store?: "memory" | "pglite" | "postgres" } = {}) {
  const chain = new LiteSvmChain();
  let offset = 0;
  const now = () => Math.floor(Date.now() / 1000) + offset;
  const service = {
    executor: DevMemorySigner.generate("EXECUTOR"),
    proposer: DevMemorySigner.generate("PROPOSER"),
    feePayer: DevMemorySigner.generate("FEE_PAYER"),
  };
  chain.airdrop(await service.feePayer.publicKey(), 100n * BigInt(LAMPORTS_PER_SOL));
  chain.warp(now() - (await chain.now()));

  const kind = opts.store ?? process.env.DK_TEST_STORE ?? "memory";
  const store = kind === "pglite" ? await pgliteStore() : kind === "postgres" ? await postgresStore() : new MemoryStore();
  const notifications = new LogNotificationService();
  const serverKeys = new DevServerKeyProvider("localnet");
  const custody = new CustodyService({ cluster: "localnet", chain, store, policy: new DefaultPolicyEngine(), serverKeys, service, notifications, now, squadsTreasury: chain.treasury });

  const wallet = DevMemorySigner.generate("WALLET_A");
  const account = await enrollWallet(custody, wallet);
  chain.airdrop(new PublicKey(account.vault), BigInt((opts.depositSol ?? 10) * LAMPORTS_PER_SOL));

  const advance = (seconds: number) => {
    offset += seconds;
    chain.warp(seconds);
  };

  /** O app monta a transação (conferindo a chain) e a carteira assina. Devolve o base64. */
  const walletTx = async (intentId: string, signer: DevMemorySigner = wallet, extra: { initiatedHere?: (id: string) => boolean } = {}) => {
    const request = await custody.approvalRequest(intentId);
    const { transaction } = await buildWalletTransaction({ chain, request, wallet: await signer.publicKey(), now: now(), ...extra });
    return signAsWallet(transaction, signer);
  };

  /** Fluxo completo do cliente: conferir, assinar na carteira, enviar. */
  const sign = async (intentId: string, signer: DevMemorySigner = wallet) => custody.submitWalletTransaction(intentId, await walletTx(intentId, signer));

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

export async function enrollWallet(custody: CustodyService, wallet: DevMemorySigner, walletName = "Phantom") {
  const pk = (await wallet.publicKey()).toBase58();
  const ch = await custody.createChallenge("ENROLL_CLIENT_KEY", pk);
  const signature = (await import("bs58")).default.encode(await wallet.sign(new TextEncoder().encode(ch.message)));
  const { account } = await custody.enroll({ challengeId: ch.id, publicKey: pk, signature, walletName });
  return account;
}

export type ServiceCtx = Awaited<ReturnType<typeof setupService>>;
