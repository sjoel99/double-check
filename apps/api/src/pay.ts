import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { SecurityError } from "@duplachave/shared";
import { type CustodyService, type HandoffRecord, intentSummary, qrLabel, renderIntent, type Store } from "@duplachave/custody";
import { HttpError } from "./errors";

/**
 * Continuar no celular. O computador mostra um QR com `<URL do app>/#/m/<token>`:
 * a câmera abre o NOSSO app no navegador do celular, que confere a transação,
 * pede a biometria e só então chama a carteira (Mobile Wallet Adapter).
 *
 * O token só diz o que abrir; quem assina continua sendo a carteira da conta
 * (o celular entra com ela) e a biometria. O computador acompanha por
 * GET /v1/pay/:poll — `poll` é um segredo separado, que só o computador recebe:
 * quem só viu o QR não lê o resultado (no CONNECT ele traz o token de sessão).
 *
 * Os pedidos ficam no banco (não em memória): sobrevivem a um restart da API.
 */

type Kind = HandoffRecord["kind"];

const TTL = 10 * 60;

export type PayDeps = {
  custody: CustodyService;
  store: Store;
  /** URL pública do app (HTTPS para o celular de verdade). */
  appUrl: string;
  issueToken: (acc: { userId: string; id: string; roles: { client: string } }) => string;
  now: () => number;
  ownAccount: (req: FastifyRequest, accountId: string) => Promise<unknown>;
};

export function registerPay(app: FastifyInstance, d: PayDeps) {
  const base = d.appUrl.replace(/\/$/, "");

  const create = async (kind: Kind, subject: string | null, accountId: string | null, label: string) => {
    const token = randomBytes(24).toString("hex");
    const poll = randomBytes(24).toString("hex");
    const now = d.now();
    await d.store.saveHandoff({ token, poll, kind, label, subject, accountId, createdAt: now, expiresAt: now + TTL, status: "WAITING", error: null, result: null });
    const url = `${base}/#/m/${token}`;
    return { token, poll, url, link: url, expiresAt: now + TTL, https: url.startsWith("https://") };
  };

  /** Vencido enquanto esperava: marca e grava. */
  const settle = async (h: HandoffRecord | null) => {
    if (!h) throw new SecurityError("PAY_NOT_FOUND", "pedido não existe ou expirou; gere outro QR");
    if (h.status === "WAITING" && d.now() > h.expiresAt) {
      h.status = "EXPIRED";
      await d.store.saveHandoff(h);
    }
    return h;
  };
  const byToken = async (token: string) => settle(await d.store.getHandoff(token));
  const byPoll = async (poll: string) => settle(await d.store.getHandoffByPoll(poll));

  /** Para o computador: em assinatura, o estado vem da própria intenção. */
  const view = async (h: HandoffRecord) => {
    if (h.kind === "SIGN_INTENT" && h.status === "WAITING") {
      const rec = await d.store.getIntent(h.subject!);
      if (rec && rec.status !== "AWAITING_CLIENT") {
        h.status = "DONE";
        h.result = { status: rec.status };
        await d.store.saveHandoff(h);
      }
    }
    return { status: h.status, kind: h.kind, error: h.error, result: h.result, expiresAt: h.expiresAt };
  };

  const used = (what: "USED" | "NOT_SIGN" = "USED") => new SecurityError("PAY_USED", what === "USED" ? "este QR já foi usado ou expirou" : "este QR não é de assinatura", { what });

  // ------------------------------------------------------------ o computador cria e acompanha
  app.post("/v1/pay/connect", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async () => create("CONNECT", null, null, "Entrar ou criar sua conta"));

  app.post("/v1/intents/:id/pay", async (req) => {
    const { id } = req.params as { id: string };
    const rec = await d.store.getIntent(id);
    if (!rec) throw new SecurityError("INTENT_NOT_FOUND", id, { id });
    await d.ownAccount(req, rec.accountId);
    return create("SIGN_INTENT", id, rec.accountId, qrLabel(rec.intent).replace(/^Double Check · /, ""));
  });

  /** Quem criou o pedido acompanha, pelo segredo que só o computador recebeu. */
  app.get("/v1/pay/:poll", async (req) => view(await byPoll((req.params as { poll: string }).poll)));

  // ------------------------------------------------------------ o celular (nosso app)
  /** O que o celular vai fazer (o token é o segredo). `summary` é estruturado para a tela traduzir; `label` em pt fica por compatibilidade. */
  app.get("/v1/handoff/:token", async (req) => {
    const h = await byToken((req.params as { token: string }).token);
    if (h.status !== "WAITING") throw used();
    const rec = h.kind === "SIGN_INTENT" ? await d.store.getIntent(h.subject!) : null;
    const wallet = h.kind === "SIGN_INTENT" && h.accountId ? ((await d.store.getAccount(h.accountId))?.roles.client ?? null) : null;
    const summary = h.kind === "CONNECT" ? { type: "CONNECT" as const } : rec ? intentSummary(rec.intent) : null;
    return { kind: h.kind, label: h.label, summary, intentId: h.kind === "SIGN_INTENT" ? h.subject : null, accountId: h.accountId, wallet, fields: null };
  });

  // ------------------------------------------------------------ assinar pelo celular, sem entrar na conta
  // O token do QR (segredo que só o computador da conta mostrou) dá acesso a ESTA intenção.
  // Quem autoriza de fato continua sendo a biometria e a carteira da conta: o
  // serviço só assina com biometria válida, e só envia o que a carteira assinou.
  const signHandoff = async (req: FastifyRequest) => {
    const h = await byToken((req.params as { token: string }).token);
    if (h.kind !== "SIGN_INTENT" || h.status !== "WAITING") throw used();
    return h;
  };
  const intentView = async (id: string) => {
    const rec = await d.store.getIntent(id);
    if (!rec) throw new SecurityError("INTENT_NOT_FOUND", id, { id });
    return { ...rec, display: renderIntent(rec.intent, { riskFlags: rec.riskFlags }) };
  };

  app.get("/v1/handoff/:token/intent", async (req) => {
    const h = await byToken((req.params as { token: string }).token);
    if (h.kind !== "SIGN_INTENT") throw used("NOT_SIGN");
    return { record: await intentView(h.subject!) };
  });

  app.post("/v1/handoff/:token/prepare", async (req) => {
    const h = await signHandoff(req);
    const acc = (await d.store.getAccount(h.accountId!))!;
    return d.custody.prepareIntent(h.subject!, acc.roles.client);
  });

  app.post("/v1/handoff/:token/authorize", async (req) => {
    const h = await signHandoff(req);
    const body = z.object({ message: z.string().min(100).max(4096), webappSignature: z.string().min(64).max(100) }).parse(req.body);
    return d.custody.authorizeIntent(h.subject!, body);
  });

  app.post("/v1/handoff/:token/submit", async (req) => {
    const h = await signHandoff(req);
    const { transaction } = z.object({ transaction: z.string().min(100).max(4096) }).parse(req.body);
    await d.custody.submitIntent(h.subject!, transaction);
    return intentView(h.subject!);
  });

  /** As cópias cifradas da chave do webapp desta conta (só a biometria do aparelho abre). */
  app.get("/v1/handoff/:token/key", async (req) => {
    const h = await signHandoff(req);
    return { keys: (await d.custody.webappKeys(h.accountId!)).map((k) => ({ publicKey: k.publicKey, blob: k.blob, deviceName: k.deviceName })) };
  });

  app.post("/v1/handoff/:token/reject", async (req) => {
    const h = await signHandoff(req);
    await d.custody.rejectByClient(h.subject!);
    return intentView(h.subject!);
  });

  /** Entrar pelo celular: o celular já entrou com a carteira; o computador recebe uma sessão da mesma conta. */
  app.post("/v1/handoff/:token/claim", async (req) => {
    const h = await byToken((req.params as { token: string }).token);
    if (h.kind !== "CONNECT" || h.status !== "WAITING") throw used();
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!token) throw new HttpError(401, "PHONE_NOT_SIGNED_IN", "entre no celular primeiro");
    const { accountId } = z.object({ accountId: z.string().uuid() }).parse(req.body);
    await d.ownAccount(req, accountId);
    const acc = (await d.store.getAccount(accountId))!;
    h.status = "DONE";
    h.result = { accountId, sessionToken: d.issueToken(acc), walletName: "Carteira do celular", publicKey: acc.roles.client };
    await d.store.saveHandoff(h);
    return { ok: true };
  });
}
