// Fluxo completo contra uma RPC (surfpool, validador local ou devnet), sem o app:
// carteira comum cadastra, envia (servidor aprova, carteira aprova + executa), troca a chave do servidor.
// Uso: SOLANA_RPC_URL=http://127.0.0.1:8899 pnpm smoke
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import bs58 from "bs58";
import { DevMemorySigner } from "@duplachave/crypto";
import { RpcChain } from "@duplachave/solana";
import { DefaultPolicyEngine } from "@duplachave/policy-engine";
import { buildWalletTransaction, CustodyService, DevServerKeyProvider, LogNotificationService, MemoryStore, signAsWallet } from "@duplachave/custody";

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
const now = () => Math.floor(Date.now() / 1000);

const wallet = DevMemorySigner.generate("CARTEIRA", cluster);
const pk = (await wallet.publicKey()).toBase58();
const ch = await custody.createChallenge("ENROLL_CLIENT_KEY", pk);
const { account } = await custody.enroll({ challengeId: ch.id, publicKey: pk, signature: bs58.encode(await wallet.sign(new TextEncoder().encode(ch.message))), walletName: "smoke" });
console.log("multisig", account.multisig, "vault", account.vault);
await airdrop(new PublicKey(account.vault), 3);

const sign = async (intentId: string) => {
  const request = await custody.approvalRequest(intentId);
  const { transaction } = await buildWalletTransaction({ chain, request, wallet: await wallet.publicKey(), now: now() });
  return custody.submitWalletTransaction(intentId, await signAsWallet(transaction, wallet));
};

const dest = Keypair.generate().publicKey;
const rec = await custody.createTransferSol(account.id, { destination: dest.toBase58(), amountLamports: String(LAMPORTS_PER_SOL) });
const out = await sign(rec.intent.id);
console.log("status", out.status, "destino recebeu", (await conn.getBalance(dest)) / LAMPORTS_PER_SOL, "SOL");

const rot = await custody.requestServerRotation(account.id, "smoke");
await sign(rot.intent.id);
console.log("rotação do servidor:", (await store.getRotation(rot.rotation.id))?.status);
