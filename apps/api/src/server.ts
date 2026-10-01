import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { z } from "zod";
import { SecurityError } from "@duplachave/shared";
import { verifyEd25519, type WalletProof } from "@duplachave/crypto";
import type { CustodyService, Store, ChallengeStore, IntentRecord } from "@duplachave/custody";
import { renderIntent } from "@duplachave/custody";
import { type Chain, ChainTxError, parseInstruction } from "@duplachave/solana";
import { issueSession, readSession, type Session } from "./session";

export type ApiDeps = {
  custody: CustodyService;
  store: Store & ChallengeStore;
  chain: Chain;
  cluster: string;
  sessionSecret: string;
  adminToken: string | null;
  feePayer: string;
  /** Assina como pagador de taxas (depósito vindo da carteira). */
  signAsFeePayer: (message: Uint8Array) => Promise<Uint8Array>;
  /** Só em localnet: airdrop para testar. */
  airdrop?: (address: PublicKey, lamports: number) => Promise<void>;
  now?: () => number;
  log?: boolean;
};

const pubkey = z.string().refine((s) => {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}, "chave pública inválida");
const signature = z.string().min(64).max(100);
const txB64 = z.string().min(100).max(4096);

/** Converte "1,5" ou "1.5" SOL em lamports, sem float. */
export function solToLamports(input: string): string {
  const s = input.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,9})?$/.test(s)) throw new SecurityError("INVALID_AMOUNT", "valor em SOL inválido (até 9 casas, sem separador de milhar)");
  const [int, frac = ""] = s.split(".");
  return (BigInt(int!) * BigInt(LAMPORTS_PER_SOL) + BigInt(frac.padEnd(9, "0"))).toString();
}

export async function buildServer(d: ApiDeps) {
  const now = d.now ?? (() => Math.floor(Date.now() / 1000));
  const app = Fastify({ logger: d.log ? { level: "info", redact: ["req.headers.authorization", "req.headers['x-admin-token']"] } : false, bodyLimit: 64 * 1024 });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof SecurityError) return reply.status(err.code.endsWith("NOT_FOUND") ? 404 : 422).send({ error: err.code, message: err.message });
    if (err instanceof z.ZodError) return reply.status(400).send({ error: "BAD_REQUEST", message: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.status(status).send({ error: status >= 500 ? "INTERNAL" : "ERROR", message: status >= 500 ? "erro interno" : (err as Error).message });
  });

  const session = async (req: FastifyRequest): Promise<Session> => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const s = readSession(d.sessionSecret, token, now());
    if (!s) throw Object.assign(new Error("sessão inválida"), { statusCode: 401 });
    // Sessão de carteira substituída morre junto com ela.
    const acc = await d.store.getAccount(s.acc);
    if (!acc || acc.roles.client !== s.key) throw Object.assign(new Error("sessão de uma carteira que não é mais a da conta"), { statusCode: 401 });
    return s;
  };
  const ownAccount = async (req: FastifyRequest, accountId: string) => {
    const s = await session(req);
    if (s.acc !== accountId) throw Object.assign(new Error("conta de outro usuário"), { statusCode: 403 });
    return s;
  };
  const ownIntent = async (req: FastifyRequest, id: string) => {
    const rec = await d.store.getIntent(id);
    if (!rec) throw new SecurityError("INTENT_NOT_FOUND", id);
    await ownAccount(req, rec.accountId);
    return rec;
  };
  const view = (rec: IntentRecord) => ({ ...rec, display: renderIntent(rec.intent, { riskFlags: rec.riskFlags }) });
  const tokenFor = (acc: { userId: string; id: string; roles: { client: string } }) =>
    issueSession(d.sessionSecret, { sub: acc.userId, acc: acc.id, key: acc.roles.client, exp: now() + 12 * 3600 });

  app.get("/healthz", async () => ({ ok: true }));

  // A RPC que o app usa para conferir NÃO vem daqui: é fixada no build do app.
  app.get("/v1/config", async () => ({ cluster: d.cluster, feePayer: d.feePayer, mode: "STRICT_2_OF_2", devTools: Boolean(d.airdrop) }));

  // ---------------------------------------------------------------- cadastro
  // Cadastro cria multisig paga pelo serviço: limite apertado por IP (produção: convite/captcha + cota).
  const enrollLimit = { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } };

  /** Devolve o texto exato que a carteira vai assinar (e mostrar na janela dela). */
  app.post("/v1/enrollment/challenge", enrollLimit, async (req) => {
    const { publicKey } = z.object({ publicKey: pubkey }).parse(req.body);
    const c = await d.custody.createChallenge("ENROLL_CLIENT_KEY", publicKey);
    return { challengeId: c.id, message: c.message, expiresAt: c.expiresAt };
  });

  app.post("/v1/enrollment", enrollLimit, async (req) => {
    const body = z.object({ challengeId: z.string().uuid(), publicKey: pubkey, signature, walletName: z.string().min(1).max(40) }).parse(req.body);
    const { account } = await d.custody.enroll(body);
    return { account, token: tokenFor(account) };
  });

  /** Esta carteira já tem conta? (o app decide entre entrar e criar sem pedir duas assinaturas) */
  app.get("/v1/wallets/:publicKey", async (req) => {
    const { publicKey } = z.object({ publicKey: pubkey }).parse(req.params);
    return { enrolled: Boolean(await d.store.findAccountByClientKey(publicKey)), revoked: await d.store.isRevokedKey(publicKey) };
  });

  // ---------------------------------------------------------------- sessão
  app.post("/v1/auth/challenge", async (req) => {
    const { publicKey } = z.object({ publicKey: pubkey }).parse(req.body);
    const c = await d.custody.createChallenge("AUTH", publicKey);
    return { challengeId: c.id, message: c.message, expiresAt: c.expiresAt };
  });

  app.post("/v1/auth/verify", async (req) => {
    const body = z.object({ challengeId: z.string().uuid(), publicKey: pubkey, signature }).parse(req.body);
    const acc = await d.custody.login(body);
    return { token: tokenFor(acc), account: acc };
  });

  // ---------------------------------------------------------------- conta
  app.get("/v1/accounts/:id/security", async (req) => {
    const { id } = req.params as { id: string };
    await ownAccount(req, id);
    const o = await d.custody.securityOverview(id);
    return { ...o, events: await d.store.listSecurityEvents(id) };
  });

  app.get("/v1/accounts/:id/audit", async (req) => {
    const { id } = req.params as { id: string };
    await ownAccount(req, id);
    return { events: await d.store.listAudit(id) };
  });

  /**
   * Depósito vindo da carteira: só aceita UMA transferência de SOL da carteira
   * da conta para o Vault dela. O serviço paga a taxa.
   */
  app.post("/v1/accounts/:id/deposit", async (req) => {
    const { id } = req.params as { id: string };
    await ownAccount(req, id);
    const { transaction } = z.object({ transaction: txB64 }).parse(req.body);
    const acc = (await d.store.getAccount(id))!;
    const tx = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
    if (tx.message.addressTableLookups.length) throw new SecurityError("ALT_IN_TX", "lookup table não é aceita");
    const msg = TransactionMessage.decompile(tx.message);
    const fee = new PublicKey(d.feePayer);
    const wallet = new PublicKey(acc.roles.client);
    if (!msg.payerKey.equals(fee) || msg.instructions.length !== 1) throw new SecurityError("DEPOSIT_NOT_EXPECTED", "depósito deve ser uma transferência paga pelo serviço");
    const ix = msg.instructions[0]!;
    const p = parseInstruction({ programId: ix.programId, keys: ix.keys, data: new Uint8Array(ix.data) });
    if (p.kind !== "SYSTEM_TRANSFER" || p.from !== wallet.toBase58() || p.to !== acc.vault) throw new SecurityError("DEPOSIT_NOT_EXPECTED", "só transferência de SOL da sua carteira para o seu Vault");
    const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
    const wi = signers.findIndex((k) => k.equals(wallet));
    if (signers.length !== 2 || wi < 0 || !verifyEd25519(tx.message.serialize(), tx.signatures[wi]!, wallet)) throw new SecurityError("WALLET_BAD_SIGNATURE", "assinatura da carteira inválida");
    tx.addSignature(fee, await d.signAsFeePayer(tx.message.serialize()));
    try {
      return { signature: await d.chain.sendTransaction(tx), lamports: p.lamports.toString() };
    } catch (e) {
      if (e instanceof ChainTxError) throw new SecurityError("DEPOSIT_FAILED", e.programError ?? e.message);
      throw e;
    }
  });

  // ---------------------------------------------------------------- operações
  app.post("/v1/accounts/:id/intents", async (req) => {
    const { id } = req.params as { id: string };
    await ownAccount(req, id);
    const body = z.object({ type: z.literal("TRANSFER_SOL"), destination: pubkey, amountSol: z.string().max(32) }).parse(req.body);
    return view(await d.custody.createTransferSol(id, { destination: body.destination, amountLamports: solToLamports(body.amountSol) }));
  });

  app.get("/v1/accounts/:id/intents", async (req) => {
    const { id } = req.params as { id: string };
    await ownAccount(req, id);
    await d.custody.expireDue(id);
    return { intents: (await d.store.listIntents(id)).map(view) };
  });

  app.get("/v1/intents/:id", async (req) => {
    const { id } = req.params as { id: string };
    const rec = await ownIntent(req, id);
    const pending = rec.status === "AWAITING_CLIENT" || rec.status === "APPROVED_PENDING_EXECUTION";
    return { record: view(rec), approvals: await d.store.listApprovals(id), approvalRequest: pending ? await d.custody.approvalRequest(id) : null };
  });

  /** Transação assinada pela carteira do cliente (aprovar + executar, aprovar, ou cancelar). */
  app.post("/v1/intents/:id/sign", async (req) => {
    const { id } = req.params as { id: string };
    await ownIntent(req, id);
    const { transaction } = z.object({ transaction: txB64 }).parse(req.body);
    return view(await d.custody.submitWalletTransaction(id, transaction));
  });

  app.post("/v1/intents/:id/reject", async (req) => {
    const { id } = req.params as { id: string };
    await ownIntent(req, id);
    return view(await d.custody.rejectByClient(id));
  });

  app.post("/v1/intents/:id/execute", async (req) => {
    const { id } = req.params as { id: string };
    await ownIntent(req, id);
    return view(await d.custody.retryExecution(id));
  });

  // ---------------------------------------------------------------- troca de carteira
  app.post("/v1/accounts/:id/rotations/client", async (req) => {
    const { id } = req.params as { id: string };
    await ownAccount(req, id);
    const { newWalletName } = z.object({ newWalletName: z.string().min(1).max(40).optional() }).parse(req.body ?? {});
    const { rotation, fields } = await d.custody.requestClientRotation(id, { newWalletName });
    // fields inclui o desafio: só a sessão da carteira atual o recebe, uma vez.
    return { rotationId: rotation.id, status: rotation.status, expiresAt: rotation.expiresAt, fields };
  });

  /** A carteira nova prova posse (o app está logado com a carteira atual da mesma conta). */
  app.post("/v1/rotations/:id/proof", async (req) => {
    const { id } = req.params as { id: string };
    const rot = await d.store.getRotation(id);
    if (!rot) throw new SecurityError("ROTATION_NOT_FOUND", id);
    await ownAccount(req, rot.accountId);
    const proof = z
      .object({
        operation: z.literal("ROTATE_CLIENT_KEY"),
        publicKey: pubkey,
        account: z.string(),
        cluster: z.string(),
        challenge: z.string().regex(/^[0-9a-f]{64}$/),
        expiresAt: z.number().int(),
        signature,
      })
      .parse((req.body as { proof?: unknown })?.proof);
    return d.custody.proveClientRotationKey(id, proof as WalletProof);
  });

  app.get("/v1/accounts/:id/rotations", async (req) => {
    const { id } = req.params as { id: string };
    await ownAccount(req, id);
    const list = await d.store.listRotations(id);
    return { rotations: list.map(({ challenge: _c, possession: _p, ...r }) => r) };
  });

  app.post("/v1/admin/accounts/:id/rotations/server", async (req, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const tok = req.headers["x-admin-token"];
    if (!d.adminToken || tok !== d.adminToken) return reply.status(401).send({ error: "UNAUTHORIZED" });
    const { reason } = z.object({ reason: z.string().min(1).max(200) }).parse(req.body);
    return d.custody.requestServerRotation(id, reason);
  });

  // ---------------------------------------------------------------- dev
  if (d.airdrop) {
    app.post("/v1/dev/airdrop", async (req) => {
      const { address, sol } = z.object({ address: pubkey, sol: z.number().positive().max(100) }).parse(req.body);
      await d.airdrop!(new PublicKey(address), Math.round(sol * LAMPORTS_PER_SOL));
      return { ok: true };
    });
    // Atalho de dev para o pedido de rotação do servidor (continua exigindo a carteira do cliente).
    app.post("/v1/dev/accounts/:id/rotations/server", async (req) => {
      const { id } = req.params as { id: string };
      await ownAccount(req, id);
      return d.custody.requestServerRotation(id, "rotação programada (simulada)");
    });
    // Simula um servidor malicioso para ver o app recusar (só dev).
    app.get("/v1/dev/intents/:id/tampered", async (req) => {
      const { id } = req.params as { id: string };
      await ownIntent(req, id);
      const request = await d.custody.approvalRequest(id);
      const { sealIntent, intentBody } = await import("@duplachave/shared");
      if (request.intent.type !== "TRANSFER_SOL") return request;
      const body = intentBody(request.intent) as { amountLamports: string };
      const tampered = sealIntent({ ...body, amountLamports: (BigInt(body.amountLamports) / 10n).toString() } as never);
      return { ...request, intent: tampered, note: "intenção adulterada: mostra 1/10 do valor real" };
    });
  }

  void SystemProgram;
  return app;
}
