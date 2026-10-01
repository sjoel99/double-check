import { expect } from "vitest";
import { LAMPORTS_PER_SOL, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { DevMemorySigner } from "@duplachave/crypto";
import { DefaultPolicyEngine } from "@duplachave/policy-engine";
import { CustodyService, DevServerKeyProvider, LogNotificationService, MemoryStore, reviewPrepared, signAsWallet, verifyAuthorized } from "@duplachave/custody";
import { LiteSvmChain } from "../../../tests/support/litesvm-chain";
import { buildServer } from "../src/server";

export const ORIGIN = "https://dupla.example";
export const SOL = BigInt(LAMPORTS_PER_SOL);
export const fromB64 = (b64: string) => VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
export const signText = async (w: DevMemorySigner, text: string) => bs58.encode(await w.sign(new TextEncoder().encode(text)));
export const blob = (deviceName = "Android") => ({ credentialId: `cred-${Math.random().toString(36).slice(2)}`, salt: "c2FsdA", iv: "aXY", ciphertext: "Y2lmcmFkbw", deviceName });

export async function setup(opts: { securityDelay?: number } = {}) {
  const chain = new LiteSvmChain();
  const service = { operator: DevMemorySigner.generate("OPERATOR") };
  let offset = 0;
  const now = () => Math.floor(Date.now() / 1000) + offset;
  chain.warp(now() - (await chain.now()));
  const store = new MemoryStore();
  const custody = new CustodyService({ cluster: "localnet", chain, store, policy: new DefaultPolicyEngine(), serverKeys: new DevServerKeyProvider("localnet"), service, notifications: new LogNotificationService(), squadsTreasury: chain.treasury, now, securityDelay: opts.securityDelay });
  const app = await buildServer({ custody, store, chain, cluster: "localnet", sessionSecret: "s".repeat(64), adminToken: "admin-token-123456", airdrop: async (a, l) => chain.airdrop(a, BigInt(l)), publicUrl: ORIGIN, now });
  const call = async (method: "GET" | "POST", url: string, body?: unknown, token?: string, headers: Record<string, string> = {}) => {
    const r = await app.inject({ method, url, payload: body as object, headers: { origin: ORIGIN, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
    return { status: r.statusCode, json: r.json() as any };
  };
  const advance = (s: number) => {
    offset += s;
    chain.warp(s);
  };
  return { chain, app, call, now, advance, store, service, custody };
}
export type T = Awaited<ReturnType<typeof setup>>;

/** Cadastro pela API: a chave do webapp e a Phantom assinam; vai a cópia cifrada da chave do webapp. */
export async function enroll(t: T, wallet = DevMemorySigner.generate("PHANTOM"), webapp = DevMemorySigner.generate("WEBAPP")) {
  const publicKey = (await wallet.publicKey()).toBase58();
  t.chain.airdrop(await wallet.publicKey(), SOL);
  const p = await t.call("POST", "/v1/enrollment/prepare", { publicKey, webappPublicKey: (await webapp.publicKey()).toBase58(), walletName: "Phantom" });
  expect(p.status).toBe(200);
  const tx = fromB64(p.json.transaction);
  tx.addSignature(await webapp.publicKey(), await webapp.sign(tx.message.serialize()));
  const r = await t.call("POST", "/v1/enrollment/submit", { enrollmentId: p.json.enrollmentId, transaction: await signAsWallet(tx, wallet), keyBlob: blob() });
  expect(r.status).toBe(200);
  return { wallet, webapp, token: r.json.token as string, account: r.json.account };
}

/** Assinar uma intenção pela API (base = /v1/intents/:id ou /v1/handoff/:token). */
export async function signIntent(t: T, base: string, wallet: DevMemorySigner, webapp: DevMemorySigner, token?: string) {
  const prepared = await t.call("POST", `${base}/prepare`, {}, token);
  expect(prepared.status).toBe(200);
  const review = await reviewPrepared(t.chain, prepared.json, { client: await wallet.publicKey(), webapp: await webapp.publicKey() }, t.now());
  const auth = await t.call("POST", `${base}/authorize`, { message: Buffer.from(review.message).toString("base64"), webappSignature: bs58.encode(await webapp.sign(review.message)) }, token);
  expect(auth.status).toBe(200);
  return t.call("POST", `${base}/submit`, { transaction: await signAsWallet(verifyAuthorized(review, auth.json.transaction), wallet) }, token);
}
