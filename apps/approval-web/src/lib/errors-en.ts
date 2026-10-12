/**
 * Mensagens de erro do serviço em inglês, pelo código (`{ error: CODE, message }`).
 * O serviço continua respondendo em português; o webapp troca o texto aqui.
 * Código desconhecido: `null`, e quem chama mostra a mensagem original.
 * Mesmos códigos dos `deny(...)`/`SecurityError(...)` em packages/* e apps/api.
 */

type Rule = string | ((pt: string) => string | null);

/** Texto do serviço para comparação: sem "[CÓDIGO]", sem ponto final, minúsculo. */
const norm = (m: string) =>
  String(m)
    .replace(/^\[[A-Z0-9_]+\]\s*/, "")
    .trim()
    .replace(/\.$/, "")
    .toLowerCase();

/** Vários textos possíveis para o mesmo código: escolhe pelo texto, senão o padrão. */
const pick =
  (byText: Record<string, string>, fallback: string | ((pt: string) => string | null)): Rule =>
  (pt) =>
    byText[norm(pt)] ?? (typeof fallback === "string" ? fallback : fallback(pt));

/** Número no formato brasileiro ("1.234,5") para o americano ("1,234.5"). */
const num = (pt: string) => {
  const n = Number(pt.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: 9 }) : pt;
};

/** Primeira captura de `re` no texto original (sem "[CÓDIGO]"). */
const grab = (pt: string, re: RegExp) => re.exec(String(pt).replace(/^\[[A-Z0-9_]+\]\s*/, "").trim())?.[1];

const statusEn: Record<string, string> = {
  EXECUTED: "executed",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
  FAILED: "failed",
  PENDING: "pending",
  APPROVED: "approved",
  PREPARED: "prepared",
  VETOED: "vetoed",
  AWAITING_CLIENT: "awaiting the wallet",
};
const st = (s: string | undefined) => (s ? (statusEn[s] ?? s) : "in another state");

const changeState = (what: string) => (pt: string) => `This key change ${what} (status: ${st(grab(pt, /^troca em (\S+)/))}).`;

const NOT_PENDING: Record<string, string> = {
  "já foi executado": "was already executed",
  "foi cancelado": "was cancelled",
  expirou: "has expired",
  falhou: "failed",
};

const ERRORS_EN: Record<string, Rule> = {
  // conta, usuário, cadastro
  ACCOUNT_NOT_FOUND: (pt) => {
    const id = grab(pt, /^conta (\S+) não existe/);
    return id ? `Account ${id} does not exist.` : "Account not found.";
  },
  USER_NOT_FOUND: (pt) => {
    const id = grab(pt, /^usuário (\S+) não existe/);
    return id ? `User ${id} does not exist.` : "User not found.";
  },
  ENROLLMENT_NOT_FOUND: "Sign-up not found or expired. Start again.",
  WALLET_ALREADY_ENROLLED: "This wallet already has an account.",
  WALLET_BAD_SIGNATURE: "Invalid wallet signature.",
  WRONG_WALLET: "This is not the account's wallet.",
  NOT_A_CLIENT_KEY: "This wallet is not the current wallet of any account.",
  NOT_A_WEBAPP_KEY: "This key is not the webapp key of any account.",
  NOT_A_VOTER: "This wallet is not a voter on this account.",
  WEBAPP_NOT_A_VOTER: "This webapp's key is not a voter on this account.",
  WEBAPP_IS_WALLET: "The webapp key can't be the wallet.",
  WEBAPP_KEY_MISSING: pick({ "falta a chave nova do webapp cifrada": "The new encrypted webapp key is missing." }, "The encrypted webapp key is missing."),
  WEBAPP_KEY_NOT_FOUND: "No account uses these biometrics.",
  WEBAPP_SIGNATURE_MISSING: "Changing the wallet requires the webapp key (biometrics).",
  WEBAPP_BAD_SIGNATURE: pick(
    {
      "a assinatura não é da chave do webapp desta conta": "The signature is not from this account's webapp key.",
      "a cópia não foi assinada pela chave do webapp": "The copy was not signed by the webapp key.",
      "o e-mail não foi confirmado pela chave do webapp": "The email was not confirmed by the webapp key.",
      "falta a assinatura da chave do webapp": "The webapp key signature is missing.",
    },
    "The signature is not from this account's webapp key.",
  ),
  CLIENT_KEY_IS_SERVER_KEY: "The service key can't be the user's key.",
  CHALLENGE_INVALID: pick({ "código vencido ou já usado; peça outro": "Code expired or already used. Request a new one." }, "Invalid challenge."),
  EMAIL_INVALID: "Invalid email.",
  EMAIL_CODE_WRONG: "Wrong code. Request a new one.",
  ENROLL_TX_UNEXPECTED: pick(
    {
      "lookup table na criação da conta": "The account creation uses a lookup table.",
      "quem paga a criação não é esta carteira": "The account creation is not paid by this wallet.",
      "a criação da conta tem instruções a mais ou a menos": "The account creation has too many or too few instructions.",
      "primeira instrução não é o memo da carteira e do webapp": "The first instruction is not the wallet and webapp memo.",
      "segunda instrução não é da squads": "The second instruction is not from Squads.",
      "não é multisig_create_v2": "It is not multisig_create_v2.",
      "quem cria não é esta carteira": "The account is not created by this wallet.",
      "multisig com config authority": "The multisig has a config authority.",
      "não é 2 de 3 sem time lock": "It is not 2-of-3 without a time lock.",
      "o rent não volta para esta carteira": "The rent does not return to this wallet.",
      "membros diferentes do modelo 2 de 3": "The members don't match the 2-of-3 model.",
      "operador ausente ou executor não é único": "Operator missing or executor not unique.",
    },
    "The account creation transaction is not what was expected.",
  ),

  // estado da multisig
  BAD_STATE: pick(
    {
      "a multisig não está no modelo 2 de 3": "The multisig is not in the 2-of-3 model.",
      "votante com permissão além de votar": "A voter has permissions beyond voting.",
      "executor ausente ou não é único": "Executor missing or not unique.",
    },
    "The multisig is not in the expected state.",
  ),
  CONFIG_AUTHORITY_SET: (pt) => {
    const k = grab(pt, /^multisig controlada por (\S+?):/);
    return k ? `Multisig controlled by ${k}: a single key could change the members.` : "Multisig controlled by a single key.";
  },
  MULTISIG_NOT_FOUND: (pt) => {
    const a = grab(pt, /^multisig (\S+) não existe/);
    return a ? `Multisig ${a} does not exist.` : "Multisig not found.";
  },
  MULTISIG_WRONG_OWNER: "The account does not belong to the Squads v4 program.",
  EXECUTOR_NOT_UNIQUE: "More than one member can execute.",
  OPERATOR_MISMATCH: "Operator missing or with permissions beyond create and execute.",
  THRESHOLD_NOT_2: (pt) => {
    const n = grab(pt, /threshold on-chain = (\S+)/);
    return n ? `On-chain threshold is ${n} (expected 2).` : "On-chain threshold is not 2.";
  },
  TIMELOCK_MISMATCH: (pt) => {
    const n = grab(pt, /time lock on-chain = (\S+)/);
    return n ? `Unexpected on-chain time lock: ${n}.` : "Unexpected on-chain time lock.";
  },
  UNEXPECTED_MEMBERS: (pt) => {
    const n = grab(pt, /^(\d+) membros/);
    return n ? `${n} members on-chain; expected 4.` : "Unexpected number of members on-chain (expected 4).";
  },
  VOTERS_MISMATCH: "The on-chain voters are not the expected ones.",
  VOTER_PERMISSIONS: (pt) => {
    const m = /votante (\S+) com permissões (\S+)/.exec(pt);
    return m ? `Voter ${m[1]} has permissions ${m[2]} (expected Vote only).` : "A voter has permissions beyond Vote.";
  },
  KEY_ALREADY_MEMBER: "This key is already a member.",
  KEY_REVOKED: pick({ "esta carteira foi substituída e não volta a valer": "This wallet was replaced and can't be used again." }, "A replaced key can't be used again."),
  REVOKED_KEY_REUSE: "A revoked key can't be used again.",
  SERVER_KEY_UNAVAILABLE: pick({ "chave nova do serviço indisponível": "The new service key is unavailable." }, "The service key is unavailable."),

  // envio (intenção)
  INTENT_NOT_FOUND: "Transfer not found.",
  INTENT_EXPIRED: (pt) => {
    const min = grab(pt, /prazo de (\d+) minutos/);
    return min ? `The ${min}-minute window to sign this transfer is over. Nothing left your account; create the transfer again.` : "The transfer has expired.";
  },
  INTENT_NOT_PENDING: (pt) => {
    const t = String(pt).replace(/^\[[A-Z0-9_]+\]\s*/, "").trim();
    if (/^[A-Z_]+$/.test(t)) return `This transfer is ${st(t)}; it can no longer be signed.`;
    const what = grab(pt, /^este envio (.+?); não dá mais/i);
    if (!what) return "This transfer can no longer be signed.";
    const en = NOT_PENDING[what.toLowerCase()] ?? `is ${st(grab(what, /^está em (\S+)/))}`;
    return `This transfer ${en}; it can no longer be signed.`;
  },
  INTENT_HASH_INVALID: "The intent hash does not match its fields.",
  INTENT_TTL_TOO_LONG: "Validity period above the maximum.",
  INTENT_MISMATCH: pick({ "o serviço devolveu outra transação": "The service returned a different transaction." }, "The received transaction differs from the one the webapp builds from the screen."),
  BAD_INTENT: "The intent's Vault is not this account's Vault.",
  INVALID_AMOUNT: pick({ "valor deve ser positivo": "The amount must be positive." }, "Invalid SOL amount (up to 9 decimal places, no thousands separator)."),
  POLICY_DENIED: (pt) => {
    const t = norm(pt);
    if (t === "o valor não pode ser zero") return "The amount can't be zero.";
    const lim = grab(pt, /acima do limite de ([\d.,]+) SOL/);
    if (lim) return `Above the limit of ${num(lim)} SOL per transfer.`;
    if (t.startsWith("o destino é um programa")) return "The destination is a program, not a wallet. Check the address.";
    if (t === "o destino não está na sua lista de endereços") return "The destination is not in your address book.";
    if (t.startsWith("o vault ficaria com menos")) return "The Vault would drop below Solana's minimum (~0.00089 SOL). Send everything or leave a bit more.";
    if (t === "o vault não tem saldo para este envio") return "The Vault doesn't have enough balance for this transfer.";
    if (t.startsWith("a solana recusaria")) return "Solana would reject this transaction in simulation. Nothing was sent.";
    return "The account policy does not allow this transaction.";
  },
  UNSUPPORTED: (pt) => {
    if (norm(pt) === "esta chain não acompanha transações enviadas pela carteira") return "This chain doesn't track transactions sent by the wallet.";
    const ty = grab(pt, /tipo (\S+) não é/);
    return ty ? `Type ${ty} is not an operation.` : "Not supported.";
  },
  WRONG_CLUSTER: (pt) => {
    const m = /^(intenção|troca) para (\S+), app em (\S+)/.exec(String(pt).replace(/^\[[A-Z0-9_]+\]\s*/, ""));
    return m ? `${m[1] === "troca" ? "Key change" : "Intent"} for ${m[2]}, app on ${m[3]}.` : "Wrong cluster.";
  },
  STALE_INDEX: "Another transaction got in first. Prepare again.",

  // transação
  TX_MALFORMED: "Unreadable transaction.",
  TX_MISMATCH: "The transaction does not belong to this multisig/index.",
  TX_NOT_EXPECTED: pick({ "a transação assinada não é a preparada": "The signed transaction is not the prepared one." }, "This transaction was not prepared by the service."),
  TX_UNKNOWN_KIND: "Unsupported transaction type (batch is not used by this system).",
  TX_WRONG_OWNER: "Transaction account with an unexpected owner.",
  TX_EXPIRED: "The transaction expired while waiting for the wallet signature (it lasts about 1 minute). Nothing left your account; sign again.",
  ALT_NOT_SUPPORTED: "The transaction uses an address lookup table.",
  BAD_MESSAGE: pick(
    {
      "programidindex fora da tabela": "programIdIndex out of range.",
      "accountindex fora da tabela": "accountIndex out of range.",
    },
    "Malformed message.",
  ),
  BAD_SIGNATURE: pick(
    {
      "veto não assinado por essa chave": "The veto was not signed by this key.",
      "assinatura ausente": "Signature missing.",
      "assinatura com tamanho inválido": "Signature has an invalid length.",
    },
    "Invalid signature.",
  ),
  PREPARED_EXPIRED: pick({ "o pedido venceu; peça de novo": "The request expired. Request it again." }, "The prepared transaction expired. Prepare again."),
  SERVER_NOT_SIGNED: (pt) => {
    const k = grab(pt, /falta a assinatura de (\S+)/);
    return k ? `Missing signature from ${k}.` : "The service signature is missing from the transaction.";
  },
  NO_TRANSACTION: "The transaction signed by the wallet is missing.",
  SIMULATION_FAILED: (pt) => (norm(pt) === "simulação falhou" ? "The simulation failed." : `The transaction would fail on Solana (${String(pt).replace(/^\[[A-Z0-9_]+\]\s*/, "")}).`),
  WALLET_NO_SOL: (pt) => {
    const need = norm(grab(pt, /para esta transação \((.*)\)$/s) ?? "");
    if (need.includes("criar a conta")) return "Your wallet needs SOL for this transaction (~0.003 SOL to create the account).";
    if (need.startsWith("tenha")) return "Your wallet needs SOL for this transaction (keep ~0.007 SOL: the account deposit comes back in the same transaction and the real cost is ~0.000015 SOL).";
    if (need.includes("troca executar")) return "Your wallet needs SOL for this transaction (the paying wallet needs ~0.006 SOL, returned when the change executes).";
    return "Your wallet needs SOL for this transaction.";
  },
  WALLET_TX_FAILED: (pt) => (norm(pt) === "a transação falhou" ? "The transaction failed." : `The transaction failed (${String(pt).replace(/^\[[A-Z0-9_]+\]\s*/, "")}).`),

  // trocas de chave
  CHANGE_NOT_FOUND: "Key change not found.",
  CHANGE_IN_PROGRESS: "A key change is already in progress.",
  CHANGE_MISMATCH: "The key change transaction differs from the one the webapp builds.",
  CHANGE_NOT_APPROVED: (pt) => {
    if (norm(pt) === "o pedido não está mais aprovado na chain") return "The request is no longer approved on-chain.";
    const s = grab(pt, /^pedido na chain em (\S+)/);
    return s === "inexistente" ? "The request does not exist on-chain." : `The on-chain request is ${st(s)}.`;
  },
  CHANGE_NOT_DUE: (pt) => {
    const iso = grab(pt, /a partir de (\S+)/);
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime())
      ? `The key change can only execute from ${d.toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })}.`
      : "The key change can't execute yet.";
  },
  CHANGE_NOT_OPEN: changeState("is no longer open"),
  CHANGE_NOT_PENDING: changeState("is not pending"),
  CHANGE_NOT_PREPARED: changeState("is not prepared"),
  BAD_CHANGE: pick({ "a chave nova já é membro": "The new key is already a member." }, "The key to replace is not the current one on-chain."),
  NEW_KEY_MISSING: "The new key is missing.",
  VETO_NOT_ALLOWED: (pt) => {
    const t = norm(pt);
    if (t.startsWith("só a carteira atual")) return "Only the current wallet can veto its own change.";
    if (t.startsWith("só a chave atual do webapp")) return "Only the current webapp key can veto its own change.";
    return "Only one of the user's keys can veto.";
  },

  // QR / celular
  PAY_NOT_FOUND: "Request not found or expired. Generate a new QR.",
  PAY_USED: pick({ "este qr não é de assinatura": "This QR is not for signing." }, "This QR was already used or has expired."),

  // HTTP do serviço
  BAD_REQUEST: (pt) => `Invalid request (${String(pt)}).`,
  UNAUTHORIZED: "Not authorized.",
  INTERNAL: "Internal error.",
  ERROR: pick(
    {
      "sessão inválida": "Invalid session. Sign in again.",
      "sessão de uma carteira que não é mais a da conta": "This session is from a wallet that is no longer the account's wallet.",
      "conta de outro usuário": "This account belongs to another user.",
      "entre no celular primeiro": "Sign in on your phone first.",
    },
    () => null,
  ),
};

/** A mensagem em inglês para este código, ou `null` (mostrar a original). */
export function errorEn(code: string, pt: string): string | null {
  const rule = ERRORS_EN[code];
  if (rule === undefined) return null;
  return typeof rule === "string" ? rule : rule(String(pt ?? ""));
}

/** Quantos códigos têm tradução (para o teste e para conferência). */
export const ERROR_CODES_EN = Object.keys(ERRORS_EN);
