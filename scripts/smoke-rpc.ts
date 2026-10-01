// Fluxo completo contra uma RPC (surfpool, validador local ou devnet), sem o app:
// carteira comum cadastra (e paga), envia numa transação atômica (servidor assina antes, carteira
// assina por último e paga), troca a chave do servidor. O serviço não tem SOL.
// Uso: SOLANA_RPC_URL=http://127.0.0.1:8899 pnpm smoke
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { DevMemorySigner } from "@duplachave/crypto";
import { RpcChain } from "@duplachave/solana";
import { DefaultPolicyEngine } from "@duplachave/policy-engine";
import { VersionedTransaction } from "@solana/web3.js";
import { CustodyService, DevServerKeyProvider, LogNotificationService, MemoryStore, reviewPrepared, signAsWallet } from "@duplachave/custody";

const rpc = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const cluster = (process.env.SOLANA_CLUSTER ?? "localnet") as "localnet" | "devnet";
const chain = new RpcChain(rpc, cluster);
const conn = chain.connection;
const airdrop = async (pk: PublicKey, sol: number) => {
  const sig = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
};

const service = { executor: DevMemorySigner.generate("EXECUTOR", cluster), proposer: DevMemorySigner.generate("PROPOSER", cluster) };
const cfg = await multisig.accounts.ProgramConfig.fromAccountAddress(conn, multisig.getProgramConfigPda({})[0]);
const store = new MemoryStore();
const custody = new CustodyService({ cluster, chain, store, policy: new DefaultPolicyEngine(), serverKeys: new DevServerKeyProvider(cluster), service, notifications: new LogNotificationService(console.log), squadsTreasury: cfg.treasury });
const now = () => Math.floor(Date.now() / 1000);

const wallet = DevMemorySigner.generate("CARTEIRA", cluster);
const pk = (await wallet.publicKey()).toBase58();
await airdrop(await wallet.publicKey(), 1);
const prepared = await custody.prepareEnrollment({ publicKey: pk, walletName: "smoke" });
const { account } = await custody.submitEnrollment(prepared.enrollmentId, await signAsWallet(VersionedTransaction.deserialize(Buffer.from(prepared.transaction, "base64")), wallet));
console.log("multisig", account.multisig, "vault", account.vault);
await airdrop(new PublicKey(account.vault), 3);

const sign = async (intentId: string) => {
  const request = await custody.prepareIntent(intentId);
  const { transaction } = await reviewPrepared(chain, request, await wallet.publicKey(), now());
  return custody.submitIntent(intentId, await signAsWallet(transaction, wallet));
};

const dest = Keypair.generate().publicKey;
const rec = await custody.createTransferSol(account.id, { destination: dest.toBase58(), amountLamports: String(LAMPORTS_PER_SOL) });
const out = await sign(rec.intent.id);
console.log("status", out.status, "destino recebeu", (await conn.getBalance(dest)) / LAMPORTS_PER_SOL, "SOL");

const rot = await custody.requestServerRotation(account.id, "smoke");
await sign(rot.intent.id);
console.log("rotação do servidor:", (await store.getRotation(rot.rotation.id))?.status);
console.log("custo total para a carteira:", (LAMPORTS_PER_SOL - (await conn.getBalance(await wallet.publicKey()))) / LAMPORTS_PER_SOL, "SOL");
