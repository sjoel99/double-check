export type NotificationTarget = { userId: string; accountId: string };

/**
 * Eventos que o usuário precisa saber. Uma notificação nunca carrega dado que
 * autorize algo — ela só avisa; o webapp sempre busca e confere na chain.
 */
export type AlertEvent =
  | { kind: "CHANGE_REQUESTED"; changeId: string; role: "CLIENT" | "WEBAPP" | "SERVER"; newKey: string; executeAfter: number }
  | { kind: "CHANGE_VETOED"; changeId: string; role: "CLIENT" | "WEBAPP" | "SERVER"; newKey: string }
  | { kind: "CHANGE_EXECUTED"; changeId: string; role: "CLIENT" | "WEBAPP" | "SERVER"; newKey: string }
  | { kind: "TRANSFER_EXECUTED"; amountLamports: string; destination: string; signature: string }
  | { kind: "EMAIL_CHANGED"; newEmail: string }
  | { kind: "INVARIANT_VIOLATION"; message: string };

export interface NotificationService {
  transactionApprovalRequested(t: NotificationTarget, p: { intentId: string; summary: string }): Promise<void>;
  /** Evento para o usuário (por e-mail, quando ele tem um confirmado). */
  event(t: NotificationTarget, e: AlertEvent, opts?: { alsoTo?: string | null }): Promise<void>;
  /** Código de confirmação de um e-mail novo (vai para o endereço a confirmar). */
  sendCode(email: string, code: string): Promise<void>;
}

/** Registra em memória e no log (testes e ambiente sem Resend). */
export class LogNotificationService implements NotificationService {
  readonly sent: { kind: string; target: NotificationTarget | null; payload: unknown }[] = [];
  constructor(private readonly log: (msg: string) => void = () => {}) {}
  protected push(kind: string, target: NotificationTarget | null, payload: unknown) {
    this.sent.push({ kind, target, payload });
    // O código de confirmação não vai para o log.
    this.log(`[notificação] ${kind} ${kind === "sendCode" ? "(código enviado)" : JSON.stringify(payload)}`);
  }
  async transactionApprovalRequested(t: NotificationTarget, p: { intentId: string; summary: string }) { this.push("transactionApprovalRequested", t, p); }
  async event(t: NotificationTarget, e: AlertEvent, opts?: { alsoTo?: string | null }) { this.push(`event:${e.kind}`, t, { ...e, alsoTo: opts?.alsoTo ?? null }); }
  async sendCode(email: string, code: string) { this.push("sendCode", null, { email, code }); }
}

// ---------------------------------------------------------------------------
// e-mail pela Resend
// ---------------------------------------------------------------------------

export type Email = { to: string; subject: string; text: string; html: string };

const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;
const ROLE: Record<"CLIENT" | "WEBAPP" | "SERVER", string> = { CLIENT: "carteira", WEBAPP: "chave do webapp (biometria)", SERVER: "chave do serviço" };
const sol = (lamports: string) => (Number(BigInt(lamports)) / 1e9).toLocaleString("pt-BR", { maximumFractionDigits: 9 });
const when = (t: number) => new Date(t * 1000).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }) + " (Brasília)";
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Texto dos e-mails. Sem link que faça algo: só aponta para o webapp, onde tudo é conferido. */
export function renderEmail(e: AlertEvent | { kind: "CODE"; code: string }, appUrl: string): { subject: string; lines: string[] } {
  const security = `${appUrl.replace(/\/$/, "")}/#/security`;
  switch (e.kind) {
    case "CHANGE_REQUESTED":
      return {
        subject: `Alerta: pedido para trocar a ${ROLE[e.role]} da sua conta`,
        lines: [
          `Foi pedido trocar a ${ROLE[e.role]} da sua conta Double Check pela chave ${short(e.newKey)}.`,
          `Se ninguém vetar, a troca executa em ${when(e.executeAfter)}.`,
          `Não foi você? Abra ${security} e toque em "Não fui eu" antes disso.`,
          "Este pedido sozinho não move fundos.",
        ],
      };
    case "CHANGE_VETOED":
      return { subject: "Troca de chave cancelada", lines: [`O pedido para trocar a ${ROLE[e.role]} pela chave ${short(e.newKey)} foi cancelado ("Não fui eu").`] };
    case "CHANGE_EXECUTED":
      return { subject: "Troca de chave concluída", lines: [`A ${ROLE[e.role]} da sua conta agora é ${short(e.newKey)}. A anterior não vale mais.`, `Não reconhece? Abra ${security}.`] };
    case "TRANSFER_EXECUTED":
      return { subject: `Envio executado: ${sol(e.amountLamports)} SOL`, lines: [`Saíram ${sol(e.amountLamports)} SOL do seu Vault para ${e.destination}.`, `Transação: ${e.signature}`] };
    case "EMAIL_CHANGED":
      return { subject: "E-mail de alerta alterado", lines: [`Os alertas da sua conta Double Check passam a ir para ${e.newEmail}.`, `Não foi você? Abra ${security}.`] };
    case "INVARIANT_VIOLATION":
      return { subject: "Alerta: configuração da conta diferente do esperado", lines: ["A conferência na Solana encontrou a sua conta diferente do modelo esperado. Não assine nada até conferir.", security] };
    case "CODE":
      return { subject: `Código de confirmação: ${e.code}`, lines: [`Seu código para confirmar este e-mail no Double Check é ${e.code}.`, "Vale por 10 minutos. Se não foi você, ignore."] };
  }
}

function toEmail(to: string, r: { subject: string; lines: string[] }): Email {
  const text = [...r.lines, "", "— Double Check"].join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111">${r.lines.map((l) => `<p>${esc(l)}</p>`).join("")}<p style="color:#666;font-size:13px">— Double Check</p></div>`;
  return { to, subject: r.subject, text, html };
}

/** Envia pela API HTTP da Resend (sem SDK). */
export class ResendMailer {
  constructor(private readonly cfg: { apiKey: string; from: string; fetchImpl?: typeof fetch }) {}
  async send(m: Email, idempotencyKey?: string) {
    const r = await (this.cfg.fetchImpl ?? fetch)("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.cfg.apiKey}`, "content-type": "application/json", ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
      body: JSON.stringify({ from: this.cfg.from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
    });
    if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return (await r.json()) as { id: string };
  }
}

/**
 * Alertas por e-mail: para o endereço confirmado do usuário (e, numa troca de
 * e-mail, também para o antigo). Também registra no log. Falha de envio não
 * derruba a operação — fica no log.
 */
export class EmailNotificationService extends LogNotificationService {
  constructor(
    private readonly deps: { mailer: { send(m: Email, key?: string): Promise<unknown> }; appUrl: string; emailOf: (userId: string) => Promise<string | null>; log?: (msg: string) => void },
  ) {
    super(deps.log);
  }
  private async deliver(to: string, r: { subject: string; lines: string[] }, key?: string) {
    try {
      await this.deps.mailer.send(toEmail(to, r), key);
    } catch (e) {
      this.deps.log?.(`[e-mail] falhou para ${to.replace(/(.).+@/, "$1***@")}: ${String(e)}`);
    }
  }
  override async event(t: NotificationTarget, e: AlertEvent, opts?: { alsoTo?: string | null }) {
    await super.event(t, e, opts);
    const to = await this.deps.emailOf(t.userId);
    const r = renderEmail(e, this.deps.appUrl);
    const key = "changeId" in e ? `${e.kind}:${e.changeId}` : undefined;
    for (const addr of new Set([to, opts?.alsoTo].filter(Boolean) as string[])) await this.deliver(addr, r, key && `${key}:${addr}`);
  }
  override async sendCode(email: string, code: string) {
    await super.sendCode(email, code);
    await this.deliver(email, renderEmail({ kind: "CODE", code }, this.deps.appUrl));
  }
}
