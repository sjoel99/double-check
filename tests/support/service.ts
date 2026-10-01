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

/** Backend completo sobre LiteSVM, com relógio controlável e um app (CLIENT_A). */
export async function setupService(opts: { depositSol?: number } = {}) {
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

  const store = new MemoryStore();
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
