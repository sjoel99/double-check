import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { SecurityError } from "@duplachave/shared";
import type { CustodyService, Store, ChallengeStore, IntentRecord } from "@duplachave/custody";
import { renderIntent } from "@duplachave/custody";
import type { Chain } from "@duplachave/solana";
import { issueSession, readSession, type Session } from "./session";
import { registerPay } from "./pay";

export type ApiDeps = {
  custody: CustodyService;
  store: Store & ChallengeStore;
  chain: Chain;
  cluster: string;
  sessionSecret: string;
  adminToken: string | null;
  /** Só em localnet: airdrop para testar. */
  airdrop?: (address: PublicKey, lamports: number) => Promise<void>;
  /** URL pública do app (HTTPS) que o celular alcança, para o QR "continuar no celular". */
  publicUrl?: string;
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
    // O código vai em `error`; a mensagem é para a tela (sem o "[CÓDIGO]" do começo).
    if (err instanceof SecurityError) return reply.status(err.code.endsWith("NOT_FOUND") ? 404 : 422).send({ error: err.code, message: err.message.replace(/^\[[A-Z0-9_]+\]\s*/, "") });
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

  // Diagnóstico do celular: só eventos e mensagens de erro do app (nada de assinatura ou chave).
  app.post("/v1/client-log", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req) => {
    const b = z.object({ event: z.string().max(60), detail: z.string().max(500).optional(), t: z.number().optional() }).parse(req.body);
    const clean = (s: string) => s.replace(/[\u0000-\u001f]/g, " ");
    app.log.warn({ cliente: clean(b.event), detalhe: clean(b.detail ?? ""), t: b.t }, "cliente");
    return { ok: true };
  });

  // A RPC que o app usa para conferir NÃO vem daqui: é fixada no build do app.
  app.get("/v1/config", async () => ({ cluster: d.cluster, mode: "2_DE_3_OPERADOR", securityDelay: d.custody.securityDelaySeconds, devTools: Boolean(d.airdrop) }));

  // ---------------------------------------------------------------- cadastro
  // A carteira paga a criação da multisig; o limite por IP segura a geração de chaves do servidor.
  const enrollLimit = { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } };

  /** A chave do webapp cifrada pela passkey (o serviço só guarda o texto cifrado). */
  const keyBlob = z.object({ credentialId: z.string().min(8).max(512), salt: z.string().max(128), iv: z.string().max(64), ciphertext: z.string().max(512), deviceName: z.string().min(1).max(40) });

  /** Monta a criação da conta 2 de 3 (Phantom + chave do webapp + serviço), paga pela Phantom. */
  app.post("/v1/enrollment/prepare", enrollLimit, async (req) => {
    const body = z.object({ publicKey: pubkey, webappPublicKey: pubkey, walletName: z.string().min(1).max(40) }).parse(req.body);
    return d.custody.prepareEnrollment(body);
  });

  /** Transação assinada pela chave do webapp e pela Phantom + a chave do webapp cifrada pela biometria. */
  app.post("/v1/enrollment/submit", enrollLimit, async (req) => {
    const { enrollmentId, transaction, keyBlob: blob } = z.object({ enrollmentId: z.string().uuid(), transaction: txB64, keyBlob }).parse(req.body);
    const { account } = await d.custody.submitEnrollment(enrollmentId, transaction, blob);
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

  /** Entrar com a chave do webapp (biometria), para quem perdeu a Phantom. */
  app.post("/v1/auth/webapp", async (req) => {
    const body = z.object({ challengeId: z.string().uuid(), publicKey: pubkey, signature }).parse(req.body);
    const acc = await d.custody.loginWithWebapp(body);
    return { token: tokenFor(acc), account: acc };
  });

  /**
   * A cópia cifrada da chave do webapp pela passkey (o aparelho descobre a
   * passkey e pede a cópia dela). Só texto cifrado: sem a biometria, não abre.
   */
  app.post("/v1/webapp-keys/lookup", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const { credentialId } = z.object({ credentialId: z.string().min(8).max(512) }).parse(req.body);
    return d.custody.webappKeyByCredential(credentialId);
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
    return { record: view(rec), approvals: await d.store.listApprovals(id) };
  });

  /**
   * A transação atômica, ainda sem assinaturas: o app confere os bytes, a chave
   * do webapp assina (/authorize) e a carteira assina por último. Vale ~1 minuto
   * (blockhash); o app prepara de novo se passar.
   */
  app.post("/v1/intents/:id/prepare", async (req) => {
    const { id } = req.params as { id: string };
    const s = await session(req);
    await ownIntent(req, id);
    return d.custody.prepareIntent(id, s.key);
  });

  /** A chave do webapp (biometria) assinou os bytes conferidos pelo app: o operador assina a parte dele. */
  app.post("/v1/intents/:id/authorize", async (req) => {
    const { id } = req.params as { id: string };
    await ownIntent(req, id);
    const body = z.object({ message: txB64, webappSignature: signature }).parse(req.body);
    return d.custody.authorizeIntent(id, body);
  });

  /** A transação assinada pela carteira: o backend confere que é a preparada e envia. */
  app.post("/v1/intents/:id/submit", async (req) => {
    const { id } = req.params as { id: string };
    await ownIntent(req, id);
    const { transaction } = z.object({ transaction: txB64 }).parse(req.body);
    return view(await d.custody.submitIntent(id, transaction));
  });

  app.post("/v1/intents/:id/reject", async (req) => {
    const { id } = req.params as { id: string };
    await ownIntent(req, id);
    return view(await d.custody.rejectByClient(id));
  });

  // ---------------------------------------------------------------- chave do webapp (cifrada)
  app.get("/v1/accounts/:id/webapp-keys", async (req) => {
    const { id } = req.params as { id: string };
    await ownAccount(req, id);
    return { keys: (await d.custody.webappKeys(id)).map((k) => ({ publicKey: k.publicKey, blob: k.blob, deviceName: k.deviceName })) };
  });

  app.post("/v1/accounts/:id/webapp-keys", async (req) => {
    const { id } = req.params as { id: string };
    await ownAccount(req, id);
    const { blob, deviceName, signature: sig } = z.object({ blob: keyBlob.omit({ deviceName: true }), deviceName: z.string().min(1).max(40), signature }).parse(req.body);
    await d.custody.addWebappKeyCopy(id, { blob, deviceName, signature: sig });
    return { ok: true };
  });

  // ---------------------------------------------------------------- e-mail de alerta
  // Cadastrar/trocar exige a chave do webapp (biometria) e o código enviado ao endereço novo.
  app.post("/v1/accounts/:id/email/start", { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } }, async (req) => {
    const { id } = req.params as { id: string };
    await ownAccount(req, id);
    const body = z.object({ email: z.string().min(3).max(254), signature }).parse(req.body);
    return d.custody.startEmailChange(id, body);
  });

  app.post("/v1/accounts/:id/email/confirm", { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } }, async (req) => {
    const { id } = req.params as { id: string };
    await ownAccount(req, id);
    const body = z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\s*\d{6}\s*$/) }).parse(req.body);
    return d.custody.confirmEmailChange(id, body);
  });

  // ---------------------------------------------------------------- trocas de chave (72 h)
  const changeView = (c: Awaited<ReturnType<CustodyService["listSecurityChanges"]>>[number]) => {
    const { prepared: _p, newKeyBlob: _b, ...rest } = c;
    return rest;
  };
  const ownChange = async (req: FastifyRequest, id: string) => {
    const c = await d.custody.listSecurityChangesById(id);
    if (!c) throw new SecurityError("CHANGE_NOT_FOUND", id);
    await ownAccount(req, c.accountId);
    return c;
  };

  app.get("/v1/accounts/:id/security-changes", async (req) => {
    const { id } = req.params as { id: string };
    await ownAccount(req, id);
    return { changes: (await d.custody.listSecurityChanges(id)).map(changeView) };
  });

  /** Pede uma troca: CLIENT (trocar a Phantom) ou WEBAPP (recuperar o webapp). SERVER só pelo admin. */
  app.post("/v1/accounts/:id/security-changes", async (req) => {
    const { id } = req.params as { id: string };
    await ownAccount(req, id);
    const body = z.object({ role: z.enum(["CLIENT", "WEBAPP"]), newKey: pubkey, newKeyBlob: keyBlob.nullish() }).parse(req.body);
    const r = await d.custody.requestSecurityChange(id, body);
    return { change: changeView(r.change), desc: r.desc, transaction: r.transaction };
  });

  app.post("/v1/security-changes/:id/authorize", async (req) => {
    const { id } = req.params as { id: string };
    await ownChange(req, id);
    const body = z.object({ message: txB64, webappSignature: signature.optional() }).parse(req.body);
    return d.custody.authorizeSecurityRequest(id, body);
  });

  app.post("/v1/security-changes/:id/submit", async (req) => {
    const { id } = req.params as { id: string };
    await ownChange(req, id);
    const { transaction } = z.object({ transaction: txB64 }).parse(req.body);
    return changeView(await d.custody.submitSecurityRequest(id, transaction));
  });

  /** "Não fui eu": a assinatura da chave que seria trocada é a autorização (vale sem sessão). */
  app.post("/v1/security-changes/:id/veto", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ publicKey: pubkey, signature }).parse(req.body);
    return changeView(await d.custody.vetoSecurityChange(id, body));
  });

  app.post("/v1/security-changes/:id/execute-prepare", async (req) => {
    const { id } = req.params as { id: string };
    await ownChange(req, id);
    return d.custody.prepareSecurityExecute(id);
  });

  app.post("/v1/security-changes/:id/execute", async (req) => {
    const { id } = req.params as { id: string };
    await ownChange(req, id);
    const { transaction } = z.object({ transaction: txB64 }).parse(req.body);
    return changeView(await d.custody.submitSecurityExecute(id, transaction));
  });

  app.post("/v1/admin/accounts/:id/security-changes/server", async (req, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const tok = req.headers["x-admin-token"];
    if (!d.adminToken || tok !== d.adminToken) return reply.status(401).send({ error: "UNAUTHORIZED" });
    const r = await d.custody.requestSecurityChange(id, { role: "SERVER" });
    return { change: changeView(r.change), desc: r.desc, transaction: r.transaction };
  });

  // ---------------------------------------------------------------- dev
  if (d.airdrop) {
    app.post("/v1/dev/airdrop", async (req) => {
      const { address, sol } = z.object({ address: pubkey, sol: z.number().positive().max(100) }).parse(req.body);
      await d.airdrop!(new PublicKey(address), Math.round(sol * LAMPORTS_PER_SOL));
      return { ok: true };
    });
    // Atalho de dev para o pedido de troca da chave do serviço (continua exigindo a Phantom e o prazo).
    app.post("/v1/dev/accounts/:id/security-changes/server", async (req) => {
      const { id } = req.params as { id: string };
      await ownAccount(req, id);
      const r = await d.custody.requestSecurityChange(id, { role: "SERVER" });
      return { change: changeView(r.change), desc: r.desc, transaction: r.transaction };
    });
    // Simula um servidor malicioso para ver o app recusar (só dev).
    app.post("/v1/dev/intents/:id/prepare-tampered", async (req) => {
      const { id } = req.params as { id: string };
      const s = await session(req);
      await ownIntent(req, id);
      const request = await d.custody.prepareIntent(id, s.key);
      const { sealIntent, intentBody } = await import("@duplachave/shared");
      if (request.intent.type !== "TRANSFER_SOL") return request;
      const body = intentBody(request.intent) as { amountLamports: string };
      const tampered = sealIntent({ ...body, amountLamports: (BigInt(body.amountLamports) / 10n).toString() } as never);
      return { ...request, intent: tampered, note: "intenção adulterada: mostra 1/10 do valor real" };
    });
  }

  // Continuar no celular: o QR abre o nosso app no celular.
  const pay = registerPay(app, { custody: d.custody, store: d.store, appUrl: d.publicUrl ?? "http://127.0.0.1:5173", issueToken: tokenFor, now, ownAccount });

  return Object.assign(app, { pay });
}
