import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { SecurityError } from "@duplachave/shared";
import { type CustodyService, qrLabel, renderIntent, type Store } from "@duplachave/custody";

/**
 * Continuar no celular. O computador mostra um QR com `<URL do app>/#/m/<token>`:
 * a câmera abre o NOSSO app no navegador do celular, que confere a transação,
 * pede a biometria e só então chama a carteira (Mobile Wallet Adapter).
 *
 * O token só diz o que abrir; quem assina continua sendo a carteira da conta
 * (o celular entra com ela) e a biometria. O computador acompanha por GET /v1/pay/:token.
 */

type Kind = "CONNECT" | "SIGN_INTENT";

type Handoff = {
  token: string;
  kind: Kind;
  label: string;
  /** intentId (SIGN_INTENT) */
  subject: string | null;
  accountId: string | null;
  createdAt: number;
  expiresAt: number;
  status: "WAITING" | "DONE" | "FAILED" | "EXPIRED";
  error: string | null;
  result: Record<string, unknown> | null;
};

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
  const handoffs = new Map<string, Handoff>();
  const base = d.appUrl.replace(/\/$/, "");

  const create = (kind: Kind, subject: string | null, accountId: string | null, label: string) => {
    for (const [k, h] of handoffs) if (d.now() > h.expiresAt + 600) handoffs.delete(k);
    const token = randomBytes(24).toString("hex");
    const now = d.now();
    handoffs.set(token, { token, kind, label, subject, accountId, createdAt: now, expiresAt: now + TTL, status: "WAITING", error: null, result: null });
    const url = `${base}/#/m/${token}`;
    return { token, url, link: url, expiresAt: now + TTL, https: url.startsWith("https://") };
  };

  const get = (token: string) => {
    const h = handoffs.get(token);
    if (!h) throw new SecurityError("PAY_NOT_FOUND", "pedido não existe ou expirou; gere outro QR");
    if (h.status === "WAITING" && d.now() > h.expiresAt) h.status = "EXPIRED";
    return h;
  };

  /** Para o computador: em assinatura, o estado vem da própria intenção. */
  const view = async (h: Handoff) => {
    if (h.kind === "SIGN_INTENT" && h.status === "WAITING") {
      const rec = await d.store.getIntent(h.subject!);
      if (rec && rec.status !== "AWAITING_CLIENT") {
        h.status = "DONE";
        h.result = { status: rec.status };
      }
    }
    return { status: h.status, kind: h.kind, error: h.error, result: h.result, expiresAt: h.expiresAt };
  };

  // ------------------------------------------------------------ o computador cria e acompanha
  app.post("/v1/pay/connect", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async () => create("CONNECT", null, null, "Entrar ou criar sua conta"));

  app.post("/v1/intents/:id/pay", async (req) => {
    const { id } = req.params as { id: string };
    const rec = await d.store.getIntent(id);
    if (!rec) throw new SecurityError("INTENT_NOT_FOUND", id);
    await d.ownAccount(req, rec.accountId);
    return create("SIGN_INTENT", id, rec.accountId, qrLabel(rec.intent).replace(/^Double Check · /, ""));
  });

  /** Quem criou o pedido acompanha. O token é segredo do QR que o computador mostra. */
  app.get("/v1/pay/:token", async (req) => view(get((req.params as { token: string }).token)));

  // ------------------------------------------------------------ o celular (nosso app)
  /** O que o celular vai fazer (o token é o segredo). `fields` fica null: era do modelo 2 de 2. */
  app.get("/v1/handoff/:token", async (req) => {
    const h = get((req.params as { token: string }).token);
    if (h.status !== "WAITING") throw new SecurityError("PAY_USED", "este QR já foi usado ou expirou");
    const wallet = h.kind === "SIGN_INTENT" && h.accountId ? ((await d.store.getAccount(h.accountId))?.roles.client ?? null) : null;
    return { kind: h.kind, label: h.label, intentId: h.kind === "SIGN_INTENT" ? h.subject : null, accountId: h.accountId, wallet, fields: null };
  });

  // ------------------------------------------------------------ assinar pelo celular, sem entrar na conta
  // O token do QR (segredo que só o computador da conta mostrou) dá acesso a ESTA intenção.
  // Quem autoriza de fato continua sendo a biometria e a carteira da conta: o
  // serviço só assina com biometria válida, e só envia o que a carteira assinou.
  const signHandoff = (req: FastifyRequest) => {
    const h = get((req.params as { token: string }).token);
    if (h.kind !== "SIGN_INTENT" || h.status !== "WAITING") throw new SecurityError("PAY_USED", "este QR já foi usado ou expirou");
    return h;
  };
  const intentView = async (id: string) => {
    const rec = await d.store.getIntent(id);
    if (!rec) throw new SecurityError("INTENT_NOT_FOUND", id);
    return { ...rec, display: renderIntent(rec.intent, { riskFlags: rec.riskFlags }) };
  };

  app.get("/v1/handoff/:token/intent", async (req) => {
    const h = get((req.params as { token: string }).token);
    if (h.kind !== "SIGN_INTENT") throw new SecurityError("PAY_USED", "este QR não é de assinatura");
    return { record: await intentView(h.subject!) };
  });

  app.post("/v1/handoff/:token/prepare", async (req) => {
    const h = signHandoff(req);
    const acc = (await d.store.getAccount(h.accountId!))!;
    return d.custody.prepareIntent(h.subject!, acc.roles.client);
  });

  app.post("/v1/handoff/:token/authorize", async (req) => {
    const h = signHandoff(req);
    const body = z.object({ message: z.string().min(100).max(4096), webappSignature: z.string().min(64).max(100) }).parse(req.body);
    return d.custody.authorizeIntent(h.subject!, body);
  });

  app.post("/v1/handoff/:token/submit", async (req) => {
    const h = signHandoff(req);
    const { transaction } = z.object({ transaction: z.string().min(100).max(4096) }).parse(req.body);
    await d.custody.submitIntent(h.subject!, transaction);
    return intentView(h.subject!);
  });

  /** As cópias cifradas da chave do webapp desta conta (só a biometria do aparelho abre). */
  app.get("/v1/handoff/:token/key", async (req) => {
    const h = signHandoff(req);
    return { keys: (await d.custody.webappKeys(h.accountId!)).map((k) => ({ publicKey: k.publicKey, blob: k.blob, deviceName: k.deviceName })) };
  });

  app.post("/v1/handoff/:token/reject", async (req) => {
    const h = signHandoff(req);
    await d.custody.rejectByClient(h.subject!);
    return intentView(h.subject!);
  });

  /** Entrar pelo celular: o celular já entrou com a carteira; o computador recebe uma sessão da mesma conta. */
  app.post("/v1/handoff/:token/claim", async (req) => {
    const h = get((req.params as { token: string }).token);
    if (h.kind !== "CONNECT" || h.status !== "WAITING") throw new SecurityError("PAY_USED", "este QR já foi usado ou expirou");
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!token) throw Object.assign(new Error("entre no celular primeiro"), { statusCode: 401 });
    const { accountId } = z.object({ accountId: z.string().uuid() }).parse(req.body);
    await d.ownAccount(req, accountId);
    const acc = (await d.store.getAccount(accountId))!;
    h.status = "DONE";
    h.result = { accountId, sessionToken: d.issueToken(acc), walletName: "Carteira do celular", publicKey: acc.roles.client };
    return { ok: true };
  });

  return { handoffs };
}
