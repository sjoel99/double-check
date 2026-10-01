import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { DevMemorySigner } from "@duplachave/crypto";
import { DefaultPolicyEngine } from "@duplachave/policy-engine";
import {
  CustodyService,
  DevServerKeyProvider,
  LogNotificationService,
  MemoryStore,
  signClientDecision,
  signPossession,
} from "@duplachave/custody";
import { LiteSvmChain } from "./litesvm-chain";
import { migrate, openPglite, openPostgres, PgStore } from "@duplachave/database";

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
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const db = await openPglite(process.env.DK_PGLITE_MEMORY ? undefined : mkdtempSync(`${tmpdir()}/dk-pglite-`));
  await migrate(db);
  return new PgStore(db);
}

/** Backend completo sobre LiteSVM, com relógio controlável e um app (CLIENT_A). */
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
  // Relógio da chain alinhado ao do servidor.
  chain.warp(now() - (await chain.now()));

  const kind = opts.store ?? process.env.DK_TEST_STORE ?? "memory";
  const store = kind === "pglite" ? await pgliteStore() : kind === "postgres" ? await postgresStore() : new MemoryStore();
  const notifications = new LogNotificationService();
  const serverKeys = new DevServerKeyProvider("localnet");
  const custody = new CustodyService({
    cluster: "localnet",
    chain,
    store,
    policy: new DefaultPolicyEngine(),
    serverKeys,
    service,
    notifications,
    now,
    squadsTreasury: chain.treasury,
  });

  const app = DevMemorySigner.generate("CLIENT_A");
  const ch = await custody.createChallenge("ENROLL_CLIENT_KEY", "user-1");
  const possession = await signPossession({ signer: app, operation: "ENROLL_CLIENT_KEY", cluster: "localnet", multisig: "", rotationId: ch.id, challenge: ch.challenge, now: now() });
  const { account } = await custody.enroll({ userId: "user-1", deviceName: "Pixel 9", challengeId: ch.id, possession });
  const { PublicKey } = await import("@solana/web3.js");
  chain.airdrop(new PublicKey(account.vault), BigInt((opts.depositSol ?? 10) * LAMPORTS_PER_SOL));

  const advance = (seconds: number) => {
    offset += seconds;
    chain.warp(seconds);
  };

  /** O app aprova (ou rejeita) depois de conferir na chain. */
  const decide = async (intentId: string, signer: DevMemorySigner = app, decision: "APPROVE" | "REJECT" = "APPROVE") => {
    const request = await custody.approvalRequest(intentId);
    return signClientDecision({ chain, request, signer, decision, now: now() });
  };

  return { chain, custody, store, notifications, serverKeys, service, app, account, now, advance, decide };
}

export type ServiceCtx = Awaited<ReturnType<typeof setupService>>;
