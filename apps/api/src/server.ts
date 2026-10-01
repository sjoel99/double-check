import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { randomUUID } from "node:crypto";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { SecurityError } from "@duplachave/shared";
import { randomHex, verifyStatement } from "@duplachave/crypto";
import type { CustodyService, Store, ChallengeStore, IntentRecord } from "@duplachave/custody";
import { renderIntent } from "@duplachave/custody";
import type { Chain } from "@duplachave/solana";
import { issueSession, readSession, type Session } from "./session";

export type ApiDeps = {
  custody: CustodyService;
  store: Store & ChallengeStore;
  chain: Chain;
  cluster: string;
  appRpcUrl: string;
  sessionSecret: string;
  adminToken: string | null;
  feePayer: string;
  /** Só em localnet: airdrop para testar. */
  airdrop?: (address: PublicKey, lamports: number) => Promise<void>;
  now?: () => number;
  log?: boolean;
};

const signed = z.object({ statement: z.record(z.string(), z.unknown()), signature: z.string() });
const pubkey = z.string().refine((s) => {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}, "chave pública inválida");

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
    // Sessão de chave revogada morre junto com a chave.
    const acc = await d.store.getAccount(s.acc);
    if (!acc || acc.roles.client !== s.key) throw Object.assign(new Error("sessão de chave que não é mais a CLIENT atual"), { statusCode: 401 });
    return s;
  };
  const ownAccount = async (req: FastifyRequest, accountId: string) => {
    const s = await session(req);
    if (s.acc !== accountId) throw Object.assign(new Error("conta de outro usuário"), { statusCode: 403 });
    return s;
  };
  const view = async (rec: IntentRecord) => ({
    ...rec,
    display: renderIntent(rec.intent, { riskFlags: rec.riskFlags }),
  });

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/v1/config", async () => ({
    cluster: d.cluster,
    rpcUrl: d.appRpcUrl,
    feePayer: d.feePayer,
    mode: "STRICT_2_OF_2",
    devTools: Boolean(d.airdrop),
  }));

  // ---------------------------------------------------------------- cadastro
  app.post("/v1/enrollment/challenge", async (req) => {
    // Sempre um usuário novo: vincular contas a um usuário existente exige
    // autenticação dele, o que esta versão ainda não tem.
    const userId = randomUUID();
    const c = await d.custody.createChallenge("ENROLL_CLIENT_KEY", userId);
    return { userId, challengeId: c.id, challenge: c.challenge, expiresAt: c.expiresAt, cluster: d.cluster };
  });

  app.post("/v1/enrollment", async (req) => {
    const body = z.object({ userId: z.string().uuid(), userName: z.string().max(80).optional(), deviceName: z.string().min(1).max(60), challengeId: z.string().uuid(), possession: signed }).parse(req.body);
    const { account, deviceId } = await d.custody.enroll(body);
    const token = issueSession(d.sessionSecret, { sub: account.userId, acc: account.id, key: account.roles.client, exp: now() + 12 * 3600 });
    return { account, deviceId, token };
  });

  // ---------------------------------------------------------------- sessão
  app.post("/v1/auth/challenge", async (req) => {
    const { publicKey } = z.object({ publicKey: pubkey }).parse(req.body);
    const c = await d.custody.createChallenge("AUTH", publicKey);
    return { challengeId: c.id, challenge: c.challenge, expiresAt: c.expiresAt, cluster: d.cluster };
  });

  app.post("/v1/auth/verify", async (req) => {
    const body = z.object({ challengeId: z.string().uuid(), signed }).parse(req.body);
    const ch = await d.store.takeChallenge(body.challengeId);
    if (!ch || ch.purpose !== "AUTH" || ch.expiresAt < now()) throw new SecurityError("CHALLENGE_INVALID", "desafio inválido");
    const st = z.object({ domain: z.literal("duplachave/auth/v1"), challenge: z.literal(ch.challenge), publicKey: z.literal(ch.subject), cluster: z.literal(d.cluster) }).passthrough().safeParse(body.signed.statement);
    if (!st.success) throw new SecurityError("AUTH_STATEMENT_INVALID", st.error.message);
    if (!verifyStatement(body.signed, new PublicKey(ch.subject))) throw new SecurityError("BAD_SIGNATURE", "assinatura inválida");
    const acc = await d.store.findAccountByClientKey(ch.subject);
    if (!acc) {
      if (await d.store.isRevokedKey(ch.subject)) throw new SecurityError("KEY_REVOKED", "esta chave foi substituída e não volta a valer");
      throw new SecurityError("NOT_A_CLIENT_KEY", "chave não é a CLIENT atual de nenhuma conta");
    }
    const token = issueSession(d.sessionSecret, { sub: acc.userId, acc: acc.id, key: ch.subject, exp: now() + 12 * 3600 });
    return { token, account: acc };
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

  // ---------------------------------------------------------------- operações
  app.post("/v1/accounts/:id/intents", async (req) => {
    const { id } = req.params as { id: string };
    await ownAccount(req, id);
    const body = z.object({ type: z.literal("TRANSFER_SOL"), destination: pubkey, amountSol: z.string().max(32) }).parse(req.body);
    const rec = await d.custody.createTransferSol(id, { destination: body.destination, amountLamports: solToLamports(body.amountSol) });
    return view(rec);
  });

  app.get("/v1/accounts/:id/intents", async (req) => {
    const { id } = req.params as { id: string };
    await ownAccount(req, id);
    await d.custody.expireDue(id);
    const list = await d.store.listIntents(id);
    return { intents: await Promise.all(list.map(view)) };
  });

  app.get("/v1/intents/:id", async (req) => {
    const { id } = req.params as { id: string };
    const rec = await d.store.getIntent(id);
    if (!rec) throw new SecurityError("INTENT_NOT_FOUND", id);
    await ownAccount(req, rec.accountId);
    const approvals = await d.store.listApprovals(id);
    return { record: await view(rec), approvals, approvalRequest: rec.status === "AWAITING_CLIENT" ? await d.custody.approvalRequest(id) : null };
  });

  app.post("/v1/intents/:id/decision", async (req) => {
    const { id } = req.params as { id: string };
    const rec = await d.store.getIntent(id);
    if (!rec) throw new SecurityError("INTENT_NOT_FOUND", id);
    await ownAccount(req, rec.accountId);
    const body = z.object({ statement: signed, approveTransaction: z.string().max(4096).optional() }).parse(req.body);
    const out = await d.custody.submitClientDecision(id, body as never);
    return view(out);
  });

  // ---------------------------------------------------------------- rotação
  app.post("/v1/accounts/:id/rotations/client", async (req) => {
    const { id } = req.params as { id: string };
    await ownAccount(req, id);
    const { newDeviceName } = z.object({ newDeviceName: z.string().min(1).max(60) }).parse(req.body);
    const rot = await d.custody.requestClientRotation(id, { newDeviceName });
    const acc = (await d.store.getAccount(id))!;
    // O desafio vai no QR/link mostrado pelo aparelho atual: é ele que autoriza o novo a provar posse.
    return { rotation: rot, pairing: { rotationId: rot.id, challenge: rot.challenge, multisig: acc.multisig, cluster: d.cluster, expiresAt: rot.expiresAt } };
  });

  app.get("/v1/rotations/:id/pairing", async (req) => {
    const { id } = req.params as { id: string };
    const { c } = z.object({ c: z.string().regex(/^[0-9a-f]{64}$/) }).parse(req.query);
    const rot = await d.store.getRotation(id);
    if (!rot || rot.challenge !== c) throw new SecurityError("ROTATION_NOT_FOUND", id);
    const acc = (await d.store.getAccount(rot.accountId))!;
    return { rotationId: rot.id, status: rot.status, role: rot.role, newKey: rot.newKey, multisig: acc.multisig, cluster: d.cluster, expiresAt: rot.expiresAt, newDeviceName: rot.newDeviceName };
  });

  app.post("/v1/rotations/:id/proof", async (req) => {
    const { id } = req.params as { id: string };
    const { possession } = z.object({ possession: signed }).parse(req.body);
    const out = await d.custody.proveClientRotationKey(id, possession);
    return out;
  });

  app.get("/v1/accounts/:id/rotations", async (req) => {
    const { id } = req.params as { id: string };
    await ownAccount(req, id);
    return { rotations: await d.store.listRotations(id) };
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
    // Atalho de dev para o pedido de rotação do servidor (continua exigindo o app).
    app.post("/v1/dev/accounts/:id/rotations/server", async (req) => {
      const { id } = req.params as { id: string };
      await ownAccount(req, id);
      return d.custody.requestServerRotation(id, "rotação programada (simulada)");
    });
    // Simula um ataque de servidor malicioso para ver o app recusar (só dev).
    app.get("/v1/dev/intents/:id/tampered", async (req) => {
      const { id } = req.params as { id: string };
      const rec = await d.store.getIntent(id);
      if (!rec) throw new SecurityError("INTENT_NOT_FOUND", id);
      await ownAccount(req, rec.accountId);
      const request = await d.custody.approvalRequest(id);
      const { sealIntent, intentBody } = await import("@duplachave/shared");
      if (request.intent.type !== "TRANSFER_SOL") return request;
      const body = intentBody(request.intent) as { amountLamports: string };
      const tampered = sealIntent({ ...body, amountLamports: (BigInt(body.amountLamports) / 10n).toString() } as never);
      return { ...request, intent: tampered, note: "intenção adulterada: mostra 1/10 do valor real" };
    });
  }

  void randomHex;
  return app;
}
