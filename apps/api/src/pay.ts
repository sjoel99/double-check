import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { SecurityError } from "@duplachave/shared";
import type { CustodyService, Store } from "@duplachave/custody";

/**
 * Assinatura pelo celular com Solana Pay "transaction request".
 *
 * O app mostra um QR com `solana:<URL HTTPS>/pay/<token>`. A carteira do celular:
 *   GET  → { label, icon }
 *   POST { account } → { transaction (já assinada pelo pagador), message }
 * e então assina e ENVIA a transação ela mesma. O backend acompanha o id (a
 * assinatura do pagador, que é a primeira) até confirmar e conclui o pedido.
 * O desktop acompanha por GET /v1/pay/:token.
 */

type Kind = "CONNECT" | "SIGN_INTENT" | "ROTATION_PROOF";

type PayRequest = {
  token: string;
  kind: Kind;
  /** intentId ou rotationId */
  subject: string | null;
  accountId: string | null;
  createdAt: number;
  expiresAt: number;
  status: "WAITING_SCAN" | "WAITING_SIGNATURE" | "DONE" | "FAILED" | "EXPIRED";
  wallet: string | null;
  txid: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
  /** Dados para concluir (transação montada, plano de cadastro…). Nunca sai pela API. */
  pending: any;
  attempts: number;
};

const TTL = 5 * 60;

export type PayDeps = {
  custody: CustodyService;
  store: Store;
  publicUrl: string;
  issueToken: (acc: { userId: string; id: string; roles: { client: string } }) => string;
  now: () => number;
  ownAccount: (req: FastifyRequest, accountId: string) => Promise<unknown>;
  log: (m: string) => void;
};

export function registerPay(app: FastifyInstance, d: PayDeps) {
  const requests = new Map<string, PayRequest>();
  const base = d.publicUrl.replace(/\/$/, "");

  const create = (kind: Kind, subject: string | null, accountId: string | null) => {
    const token = randomBytes(24).toString("hex");
    const now = d.now();
    const r: PayRequest = { token, kind, subject, accountId, createdAt: now, expiresAt: now + TTL, status: "WAITING_SCAN", wallet: null, txid: null, error: null, result: null, pending: null, attempts: 0 };
    requests.set(token, r);
    const url = `${base}/pay/${token}`;
    return { token, url, link: `solana:${encodeURIComponent(url)}`, expiresAt: r.expiresAt, https: url.startsWith("https://") };
  };

  const publicView = (r: PayRequest) => ({ status: r.status, kind: r.kind, wallet: r.wallet, txid: r.txid, error: r.error, result: r.result, expiresAt: r.expiresAt });

  // ------------------------------------------------------------ o desktop cria e acompanha
  app.post("/v1/pay/connect", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async () => create("CONNECT", null, null));

  app.post("/v1/intents/:id/pay", async (req) => {
    const { id } = req.params as { id: string };
    const rec = await d.store.getIntent(id);
    if (!rec) throw new SecurityError("INTENT_NOT_FOUND", id);
    await d.ownAccount(req, rec.accountId);
    return create("SIGN_INTENT", id, rec.accountId);
  });

  app.post("/v1/rotations/:id/pay-proof", async (req) => {
    const { id } = req.params as { id: string };
    const rot = await d.store.getRotation(id);
    if (!rot) throw new SecurityError("ROTATION_NOT_FOUND", id);
    await d.ownAccount(req, rot.accountId);
    return create("ROTATION_PROOF", id, rot.accountId);
  });

  /** Quem criou o pedido acompanha. O token é segredo do desktop (só aparece no QR que ele mostra). */
  app.get("/v1/pay/:token", async (req) => {
    const { token } = req.params as { token: string };
    const r = requests.get(token);
    if (!r) throw new SecurityError("PAY_NOT_FOUND", "pedido não existe ou expirou");
    return publicView(r);
  });

  // ------------------------------------------------------------ o celular (Solana Pay)
  app.get("/pay/icon.svg", async (_req, reply) => {
    reply.header("content-type", "image/svg+xml").header("cache-control", "public, max-age=86400");
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="18" fill="#14171C"/><circle cx="25" cy="32" r="10" fill="none" stroke="#C8F169" stroke-width="4"/><circle cx="39" cy="32" r="10" fill="none" stroke="#EDEEF0" stroke-width="4"/></svg>`;
  });

  app.get("/pay/:token", async (req) => {
    const { token } = req.params as { token: string };
    const r = requests.get(token);
    if (!r || r.status === "EXPIRED") throw new SecurityError("PAY_NOT_FOUND", "pedido não existe ou expirou");
    return { label: "Dupla Chave", icon: `${base}/pay/icon.svg` };
  });

  app.post("/pay/:token", async (req) => {
    const { token } = req.params as { token: string };
    const { account } = z.object({ account: z.string() }).parse(req.body);
    new PublicKey(account);
    const r = requests.get(token);
    if (!r || d.now() > r.expiresAt) throw new SecurityError("PAY_NOT_FOUND", "pedido não existe ou expirou");
    if (r.status === "DONE" || r.status === "FAILED") throw new SecurityError("PAY_USED", "este QR já foi usado");
    if (++r.attempts > 5) throw new SecurityError("PAY_TOO_MANY", "tentativas demais; gere outro QR");
    // Um QR, uma carteira: depois do primeiro POST, outra carteira não troca o pedido.
    if (r.wallet && r.wallet !== account) throw new SecurityError("PAY_WRONG_WALLET", "este QR já está com outra carteira");

    let built: { transaction: string; txid: string; message: string };
    if (r.kind === "CONNECT") {
      const tx = await d.custody.phoneConnectTransaction(account, token);
      r.pending = tx;
      built = tx;
    } else if (r.kind === "SIGN_INTENT") {
      const tx = await d.custody.phoneSignTransaction(r.subject!, account);
      built = tx;
    } else {
      const tx = await d.custody.phoneRotationProofTransaction(r.subject!, account);
      r.pending = tx;
      built = tx;
    }
    r.wallet = account;
    r.txid = built.txid;
    r.status = "WAITING_SIGNATURE";
    r.error = null;
    return { transaction: built.transaction, message: built.message };
  });

  // ------------------------------------------------------------ acompanhamento na chain
  const tick = async () => {
    const now = d.now();
    for (const r of requests.values()) {
      if (r.status === "DONE" || r.status === "FAILED" || r.status === "EXPIRED") {
        if (now > r.expiresAt + 600) requests.delete(r.token);
        continue;
      }
      if (now > r.expiresAt + 120) {
        r.status = "EXPIRED";
        continue;
      }
      if (r.status !== "WAITING_SIGNATURE" || !r.txid || !r.wallet) continue;
      try {
        if (r.kind === "CONNECT") {
          const out = await d.custody.phoneConnectComplete(r.pending, r.wallet, "Carteira do celular");
          if (!out) continue;
          r.result = { accountId: out.account.id, created: out.created, sessionToken: d.issueToken(out.account), walletName: "Carteira do celular", publicKey: r.wallet };
        } else if (r.kind === "SIGN_INTENT") {
          const out = await d.custody.phoneSignComplete(r.subject!, r.txid);
          if (!out) continue;
          r.result = { status: out.status };
        } else {
          const out = await d.custody.phoneRotationProofComplete(r.subject!, r.pending);
          if (!out) continue;
          r.result = { intentId: out.intent.id, newKey: r.wallet };
        }
        r.status = "DONE";
      } catch (e) {
        r.status = "FAILED";
        r.error = e instanceof SecurityError ? e.message : String(e);
        d.log(`pay ${r.kind} ${r.token.slice(0, 8)}: ${r.error}`);
      }
    }
  };
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } finally {
      running = false;
    }
  }, 1500);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));

  return { requests, tick };
}
