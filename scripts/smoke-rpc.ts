// Fluxo completo contra uma RPC (surfpool, validador local ou devnet).
// Uso: SOLANA_RPC_URL=http://127.0.0.1:8899 pnpm tsx scripts/smoke-rpc.ts
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { DevMemorySigner } from "@duplachave/crypto";
import { RpcChain } from "@duplachave/solana";
import { DefaultPolicyEngine } from "@duplachave/policy-engine";
import { CustodyService, DevServerKeyProvider, LogNotificationService, MemoryStore, signClientDecision, signPossession } from "@duplachave/custody";

const rpc = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const cluster = (process.env.SOLANA_CLUSTER ?? "localnet") as "localnet" | "devnet";
const chain = new RpcChain(rpc, cluster);
const conn = chain.connection;
const airdrop = async (pk: PublicKey, sol: number) => {
  const sig = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
};

const service = { executor: DevMemorySigner.generate("EXECUTOR", cluster), proposer: DevMemorySigner.generate("PROPOSER", cluster), feePayer: DevMemorySigner.generate("FEE_PAYER", cluster) };
await airdrop(await service.feePayer.publicKey(), 5);
const cfg = await multisig.accounts.ProgramConfig.fromAccountAddress(conn, multisig.getProgramConfigPda({})[0]);
const store = new MemoryStore();
const custody = new CustodyService({ cluster, chain, store, policy: new DefaultPolicyEngine(), serverKeys: new DevServerKeyProvider(cluster), service, notifications: new LogNotificationService(console.log), squadsTreasury: cfg.treasury });

const app = DevMemorySigner.generate("CLIENT_A", cluster);
const ch = await custody.createChallenge("ENROLL_CLIENT_KEY", "smoke");
const now = () => Math.floor(Date.now() / 1000);
const { account } = await custody.enroll({ userId: "smoke", deviceName: "smoke", challengeId: ch.id, possession: await signPossession({ signer: app, operation: "ENROLL_CLIENT_KEY", cluster, multisig: "", rotationId: ch.id, challenge: ch.challenge, now: now() }) });
console.log("multisig", account.multisig, "vault", account.vault);
await airdrop(new PublicKey(account.vault), 3);

const dest = Keypair.generate().publicKey;
const rec = await custody.createTransferSol(account.id, { destination: dest.toBase58(), amountLamports: String(LAMPORTS_PER_SOL) });
const request = await custody.approvalRequest(rec.intent.id);
const out = await custody.submitClientDecision(rec.intent.id, await signClientDecision({ chain, request, signer: app, decision: "APPROVE", now: now() }));
console.log("status", out.status, "destino recebeu", (await conn.getBalance(dest)) / LAMPORTS_PER_SOL, "SOL");

const rot = await custody.requestServerRotation(account.id, "smoke");
await custody.submitClientDecision(rot.intent.id, await signClientDecision({ chain, request: await custody.approvalRequest(rot.intent.id), signer: app, decision: "APPROVE", now: now() }));
console.log("rotação do servidor:", (await store.getRotation(rot.rotation.id))?.status);
