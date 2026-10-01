import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { SecurityError } from "@duplachave/shared";
import type { WalletProof } from "@duplachave/crypto";
import { type CustodyService, qrLabel, type Store } from "@duplachave/custody";

/**
 * Continuar no celular. O computador mostra um QR com `<URL do app>/#/m/<token>`:
 * a câmera abre o NOSSO app no navegador do celular, que confere a transação,
 * pede a biometria e só então chama a carteira (Mobile Wallet Adapter). Antes
 * era Solana Pay e a carteira recebia a transação direto do servidor, sem
 * conferência independente (THREAT_MODEL #26).
 *
 * O token só diz o que abrir; quem assina continua sendo a carteira da conta
 * (o celular entra com ela) e a biometria. O computador acompanha por GET /v1/pay/:token.
 */

type Kind = "CONNECT" | "SIGN_INTENT" | "ROTATION_PROOF";

type Handoff = {
  token: string;
  kind: Kind;
  label: string;
  /** intentId ou rotationId */
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

const proofSchema = z.object({
  operation: z.literal("ROTATE_CLIENT_KEY"),
  publicKey: z.string().min(32).max(44),
  account: z.string(),
  cluster: z.string(),
  challenge: z.string().regex(/^[0-9a-f]{64}$/),
  expiresAt: z.number().int(),
  signature: z.string().min(64).max(100),
});

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
    return create("SIGN_INTENT", id, rec.accountId, qrLabel(rec.intent).replace(/^Dupla Chave · /, ""));
  });

  app.post("/v1/rotations/:id/pay-proof", async (req) => {
    const { id } = req.params as { id: string };
    const rot = await d.store.getRotation(id);
    if (!rot) throw new SecurityError("ROTATION_NOT_FOUND", id);
    await d.ownAccount(req, rot.accountId);
    return create("ROTATION_PROOF", id, rot.accountId, "Provar que a carteira nova é sua");
  });

  /** Quem criou o pedido acompanha. O token é segredo do QR que o computador mostra. */
  app.get("/v1/pay/:token", async (req) => view(get((req.params as { token: string }).token)));

  // ------------------------------------------------------------ o celular (nosso app)
  /** O que o celular vai fazer. Na troca, inclui os campos do texto de posse (o token é o segredo). */
  app.get("/v1/handoff/:token", async (req) => {
    const h = get((req.params as { token: string }).token);
    if (h.status !== "WAITING") throw new SecurityError("PAY_USED", "este QR já foi usado ou expirou");
    let fields: unknown = null;
    if (h.kind === "ROTATION_PROOF") {
      const rot = await d.store.getRotation(h.subject!);
      const acc = rot && (await d.store.getAccount(rot.accountId));
      if (!rot || !acc || rot.status !== "REQUESTED") throw new SecurityError("ROTATION_BAD_STATE", rot?.status ?? "inexistente");
      fields = d.custody.possessionFieldsFor(rot, acc.multisig);
    }
    return { kind: h.kind, label: h.label, intentId: h.kind === "SIGN_INTENT" ? h.subject : null, accountId: h.accountId, fields };
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

  /** A carteira nova (no celular) prova posse; o token autoriza só esta rotação. */
  app.post("/v1/handoff/:token/proof", async (req) => {
    const h = get((req.params as { token: string }).token);
    if (h.kind !== "ROTATION_PROOF" || h.status !== "WAITING") throw new SecurityError("PAY_USED", "este QR já foi usado ou expirou");
    const proof = proofSchema.parse((req.body as { proof?: unknown })?.proof);
    try {
      const out = await d.custody.proveClientRotationKey(h.subject!, proof as WalletProof);
      h.status = "DONE";
      h.result = { intentId: out.intent.id, newKey: proof.publicKey };
      return { ok: true };
    } catch (e) {
      h.error = e instanceof SecurityError ? e.message : String(e);
      throw e;
    }
  });

  return { handoffs };
}
