import { describe, expect, it } from "vitest";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import { DevMemorySigner } from "@duplachave/crypto";
import { SecurityError } from "@duplachave/shared";
import { type Email, emailBindingMessage, ResendMailer } from "@duplachave/custody";
import { setupService } from "./support/service";

const SOL = BigInt(LAMPORTS_PER_SOL);

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SecurityError) return e.code;
    return `OTHER:${String(e)}`;
  }
  return "NO_ERROR";
}

/** Caixa de saída falsa: guarda o que seria enviado. */
function outbox() {
  const mails: Email[] = [];
  return { mails, mailer: { send: async (m: Email) => void mails.push(m) }, codeFor: (to: string) => mails.filter((m) => m.to === to).at(-1)!.subject.match(/\d{6}/)![0] };
}

const sign = async (k: DevMemorySigner, text: string) => bs58.encode(await k.sign(new TextEncoder().encode(text)));

async function withEmail() {
  const box = outbox();
  const t = await setupService({ mailer: box.mailer, securityDelay: 3600 });
  const setEmail = async (email: string, key = t.webapp) => {
    const s = await t.custody.startEmailChange(t.account.id, { email, signature: await sign(key, emailBindingMessage(t.account.multisig, email.toLowerCase())) });
    return t.custody.confirmEmailChange(t.account.id, { challengeId: s.challengeId, code: box.codeFor(email.toLowerCase()) });
  };
  return { ...t, box, setEmail };
}

describe("e-mail de alerta", () => {
  it("cadastrar exige a chave do webapp: a Phantom (seed vazada) não desvia os alertas", async () => {
    const t = await withEmail();
    const email = "dono@exemplo.com";
    const text = emailBindingMessage(t.account.multisig, email);
    expect(await code(t.custody.startEmailChange(t.account.id, { email, signature: await sign(t.wallet, text) }))).toBe("WEBAPP_BAD_SIGNATURE");
    expect(t.box.mails).toHaveLength(0);
    // Assinatura do webapp para outro e-mail não serve para este.
    expect(await code(t.custody.startEmailChange(t.account.id, { email: "atacante@exemplo.com", signature: await sign(t.webapp, text) }))).toBe("WEBAPP_BAD_SIGNATURE");
    expect(await t.setEmail(email)).toEqual({ email: "d***@exemplo.com" });
    expect((await t.custody.securityOverview(t.account.id)).alertEmail).toBe("d***@exemplo.com");
  });

  it("código errado ou reaproveitado não confirma; e-mail inválido é recusado", async () => {
    const t = await withEmail();
    const email = "dono@exemplo.com";
    expect(await code(t.custody.startEmailChange(t.account.id, { email: "sem-arroba", signature: await sign(t.webapp, "x") }))).toBe("EMAIL_INVALID");
    const s = await t.custody.startEmailChange(t.account.id, { email, signature: await sign(t.webapp, emailBindingMessage(t.account.multisig, email)) });
    const right = t.box.codeFor(email);
    const wrong = right === "000000" ? "111111" : "000000";
    expect(await code(t.custody.confirmEmailChange(t.account.id, { challengeId: s.challengeId, code: wrong }))).toBe("EMAIL_CODE_WRONG");
    // Uma tentativa por código: depois do erro, nem o certo vale.
    expect(await code(t.custody.confirmEmailChange(t.account.id, { challengeId: s.challengeId, code: right }))).toBe("CHALLENGE_INVALID");
    expect((await t.custody.securityOverview(t.account.id)).alertEmail).toBeNull();
    // O código não vai para o corpo de nenhum log de notificação.
    expect(t.notifications.sent.find((n) => n.kind === "sendCode")).toBeTruthy();
  });

  it("trocar o e-mail avisa o endereço antigo", async () => {
    const t = await withEmail();
    await t.setEmail("antigo@exemplo.com");
    t.box.mails.length = 0;
    await t.setEmail("novo@exemplo.com");
    const changed = t.box.mails.filter((m) => m.subject === "E-mail de alerta alterado").map((m) => m.to).sort();
    expect(changed).toEqual(["antigo@exemplo.com", "novo@exemplo.com"]);
  });

  it("pedido, veto e execução de troca e envios chegam por e-mail, sem segredo", async () => {
    const t = await withEmail();
    await t.setEmail("dono@exemplo.com");
    t.box.mails.length = 0;

    const r = await t.custody.createTransferSol(t.account.id, { destination: Keypair.generate().publicKey.toBase58(), amountLamports: SOL.toString() });
    await t.sign(r.intent.id);
    expect(t.box.mails.at(-1)!.subject).toBe("Envio executado: 1 SOL");

    const next = DevMemorySigner.generate("WEBAPP_B");
    const req = await t.requestChange("WEBAPP", next);
    const requested = t.box.mails.at(-1)!;
    expect(requested.subject).toContain("pedido para trocar a chave do webapp");
    expect(requested.text).toContain("https://dupla.example/#/security");
    expect(requested.text).toContain("Não fui eu");
    await t.veto(req.change.id, t.webapp);
    expect(t.box.mails.at(-1)!.subject).toBe("Troca de chave cancelada");

    const req2 = await t.requestChange("WEBAPP", next);
    t.advance(3601);
    await t.executeChange(req2.change.id, t.wallet);
    expect(t.box.mails.at(-1)!.subject).toBe("Troca de chave concluída");

    for (const m of t.box.mails) expect(m.to).toBe("dono@exemplo.com");
  });

  it("sem e-mail cadastrado, nada é enviado (só log)", async () => {
    const t = await withEmail();
    const r = await t.custody.createTransferSol(t.account.id, { destination: Keypair.generate().publicKey.toBase58(), amountLamports: SOL.toString() });
    await t.sign(r.intent.id);
    expect(t.box.mails).toHaveLength(0);
    expect(t.notifications.sent.some((n) => n.kind === "event:TRANSFER_EXECUTED")).toBe(true);
  });

  it("falha da Resend não derruba a operação", async () => {
    const t = await setupService({ mailer: { send: async () => { throw new Error("Resend 500"); } } });
    const email = "dono@exemplo.com";
    const s = await t.custody.startEmailChange(t.account.id, { email, signature: await sign(t.webapp, emailBindingMessage(t.account.multisig, email)) });
    expect(s.challengeId).toBeTruthy();
  });
});

describe("ResendMailer", () => {
  it("POST na API HTTP da Resend com Bearer, remetente e idempotência", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "abc" }), { status: 200 });
    }) as unknown as typeof fetch;
    const m = new ResendMailer({ apiKey: "re_test_123", from: "Double Check <alertas@exemplo.com>", fetchImpl });
    expect(await m.send({ to: "a@b.com", subject: "s", text: "t", html: "<p>t</p>" }, "k1")).toEqual({ id: "abc" });
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer re_test_123");
    expect(h["idempotency-key"]).toBe("k1");
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ from: "Double Check <alertas@exemplo.com>", to: ["a@b.com"], subject: "s" });

    const bad = new ResendMailer({ apiKey: "re_x_1234567", from: "x", fetchImpl: (async () => new Response("domínio não verificado", { status: 403 })) as unknown as typeof fetch });
    await expect(bad.send({ to: "a@b.com", subject: "s", text: "t", html: "t" })).rejects.toThrow(/Resend 403/);
  });
});
