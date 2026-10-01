// Fluxo completo contra uma RPC (surfpool, validador local ou devnet), sem o webapp, no modelo 2 de 3:
// a Phantom (aqui uma chave de teste) e a chave do webapp criam a conta (a Phantom paga), um envio
// (webapp + operador + Phantom) e uma troca da chave do serviço com prazo (aqui 5 s). O serviço não tem SOL.
// Uso: SOLANA_RPC_URL=http://127.0.0.1:8899 pnpm smoke
import { LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import bs58 from "bs58";
import { DevMemorySigner } from "@duplachave/crypto";
import { RpcChain } from "@duplachave/solana";
import { DefaultPolicyEngine } from "@duplachave/policy-engine";
import { CustodyService, DevServerKeyProvider, LogNotificationService, MemoryStore, reviewPrepared, signAsWallet, verifyAuthorized } from "@duplachave/custody";

const rpc = process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899";
const cluster = (process.env.SOLANA_CLUSTER ?? "localnet") as "localnet" | "devnet";
const chain = new RpcChain(rpc, cluster);
const conn = chain.connection;
const airdrop = async (pk: PublicKey, sol: number) => {
  const sig = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
};
const fromB64 = (b: string) => VersionedTransaction.deserialize(Buffer.from(b, "base64"));

const service = { operator: DevMemorySigner.generate("OPERATOR", cluster) };
const cfg = await multisig.accounts.ProgramConfig.fromAccountAddress(conn, multisig.getProgramConfigPda({})[0]);
const store = new MemoryStore();
const custody = new CustodyService({ cluster, chain, store, policy: new DefaultPolicyEngine(), serverKeys: new DevServerKeyProvider(cluster), service, notifications: new LogNotificationService(console.log), squadsTreasury: cfg.treasury, securityDelay: 5 });
const now = () => Math.floor(Date.now() / 1000);

const wallet = DevMemorySigner.generate("PHANTOM", cluster);
const webapp = DevMemorySigner.generate("WEBAPP", cluster);
await airdrop(await wallet.publicKey(), 1);
const p = await custody.prepareEnrollment({ publicKey: (await wallet.publicKey()).toBase58(), webappPublicKey: (await webapp.publicKey()).toBase58(), walletName: "smoke" });
const enrollTx = fromB64(p.transaction);
enrollTx.addSignature(await webapp.publicKey(), await webapp.sign(enrollTx.message.serialize()));
const { account } = await custody.submitEnrollment(p.enrollmentId, await signAsWallet(enrollTx, wallet), { credentialId: "smoke-cred", salt: "cw", iv: "aQ", ciphertext: "Yw", deviceName: "smoke" });
console.log("multisig", account.multisig, "vault", account.vault);
await airdrop(new PublicKey(account.vault), 3);

const mine = { client: await wallet.publicKey(), webapp: await webapp.publicKey() };
const rec = await custody.createTransferSol(account.id, { destination: (await DevMemorySigner.generate("DEST").publicKey()).toBase58(), amountLamports: String(LAMPORTS_PER_SOL) });
const request = await custody.prepareIntent(rec.intent.id);
const review = await reviewPrepared(chain, request, mine, now());
const { transaction } = await custody.authorizeIntent(rec.intent.id, { message: Buffer.from(review.message).toString("base64"), webappSignature: bs58.encode(await webapp.sign(review.message)) });
console.log("envio:", (await custody.submitIntent(rec.intent.id, await signAsWallet(verifyAuthorized(review, transaction), wallet))).status);

const req = await custody.requestSecurityChange(account.id, { role: "SERVER" });
const msg = Buffer.from(fromB64(req.transaction).message.serialize()).toString("base64");
const signed = await custody.authorizeSecurityRequest(req.change.id, { message: msg });
await custody.submitSecurityRequest(req.change.id, await signAsWallet(fromB64(signed.transaction), wallet));
console.log("troca da chave do serviço pedida; esperando o prazo de teste (5 s)…");
await new Promise((r) => setTimeout(r, 6000));
const exec = await custody.prepareSecurityExecute(req.change.id);
console.log("troca:", (await custody.submitSecurityExecute(req.change.id, await signAsWallet(fromB64(exec.transaction), wallet))).status);
console.log("custo total para a Phantom:", (LAMPORTS_PER_SOL - (await conn.getBalance(await wallet.publicKey()))) / LAMPORTS_PER_SOL, "SOL");
