/**
 * Mensagens de erro para a tela, pelo CÓDIGO e pelos PARÂMETROS que o serviço
 * (ou o próprio webapp, em client.ts) manda junto: `{ error, message, params }`.
 * O texto em português do serviço só serve de fallback para código desconhecido;
 * nada aqui interpreta a frase do servidor.
 *
 * Mesmos códigos dos `deny(...)`/`SecurityError(...)` em packages/* e apps/api.
 */
import { fmtWhen, tr } from "./i18n";
import { sol } from "./chain";

export type Params = Record<string, string | number | boolean | null | undefined>;
type Rule = string | ((p: Params) => string);

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const short = (k: unknown) => (str(k).length > 12 ? `${str(k).slice(0, 4)}…${str(k).slice(-4)}` : str(k));
const lamports = (v: unknown) => {
  try {
    return sol(str(v) || "0", 9);
  } catch {
    return str(v);
  }
};

/** Estado de um envio ou de uma troca, no idioma do app. */
export function statusText(s: unknown): string {
  const map: Record<string, string> = {
    EXECUTED: tr("executado", "executed"),
    REJECTED: tr("recusado", "rejected"),
    CANCELLED: tr("cancelado", "cancelled"),
    EXPIRED: tr("expirado", "expired"),
    FAILED: tr("com falha", "failed"),
    PENDING: tr("pendente", "pending"),
    APPROVED: tr("aprovado", "approved"),
    PREPARED: tr("preparado", "prepared"),
    VETOED: tr("vetado", "vetoed"),
    AWAITING_CLIENT: tr("aguardando a carteira", "awaiting the wallet"),
    EXECUTING: tr("executando", "executing"),
    APPROVED_PENDING_EXECUTION: tr("aguardando execução", "waiting to execute"),
  };
  const k = str(s);
  return map[k] ?? (k ? tr(`em ${k}`, `in ${k}`) : tr("em outro estado", "in another state"));
}

/** O que já aconteceu com um envio que não dá mais para assinar. */
const notPending = (status: unknown) => {
  const k = str(status);
  const what: Record<string, string> = {
    EXECUTED: tr("já foi executado", "was already executed"),
    REJECTED: tr("foi cancelado", "was cancelled"),
    CANCELLED: tr("foi cancelado", "was cancelled"),
    EXPIRED: tr("expirou", "has expired"),
    FAILED: tr("falhou", "failed"),
  };
  const w = what[k] ?? (k ? tr(`está em ${k}`, `is ${statusText(k)}`) : tr("saiu do estado de espera", "is no longer pending"));
  return tr(`Este envio ${w}; não dá mais para assinar.`, `This transfer ${w}; it can no longer be signed.`);
};

const changeState = (what: { pt: string; en: string }) => (p: Params) => tr(`Esta troca de chave ${what.pt} (estado: ${statusText(p.status)}).`, `This key change ${what.en} (status: ${statusText(p.status)}).`);

const RULES: Record<string, Rule> = {
  // conta, usuário, cadastro
  ACCOUNT_NOT_FOUND: (p) => (p.id ? tr(`Conta ${p.id} não existe.`, `Account ${p.id} does not exist.`) : tr("Conta não encontrada.", "Account not found.")),
  USER_NOT_FOUND: (p) => (p.id ? tr(`Usuário ${p.id} não existe.`, `User ${p.id} does not exist.`) : tr("Usuário não encontrado.", "User not found.")),
  ENROLLMENT_NOT_FOUND: tr("Cadastro não existe ou expirou. Comece de novo.", "Sign-up not found or expired. Start again."),
  WALLET_ALREADY_ENROLLED: tr("Esta carteira já tem uma conta.", "This wallet already has an account."),
  WALLET_BAD_SIGNATURE: tr("Assinatura da carteira inválida.", "Invalid wallet signature."),
  WRONG_WALLET: tr("Esta não é a carteira da conta.", "This is not the account's wallet."),
  NOT_A_CLIENT_KEY: tr("Esta carteira não é a carteira atual de nenhuma conta.", "This wallet is not the current wallet of any account."),
  NOT_A_WEBAPP_KEY: tr("Esta chave não é a chave do webapp de nenhuma conta.", "This key is not the webapp key of any account."),
  NOT_A_VOTER: tr("Esta carteira não é votante desta conta.", "This wallet is not a voter on this account."),
  WEBAPP_NOT_A_VOTER: tr("A chave deste webapp não é votante desta conta.", "This webapp's key is not a voter on this account."),
  WEBAPP_IS_WALLET: tr("A chave do webapp não pode ser a carteira.", "The webapp key can't be the wallet."),
  WEBAPP_KEY_MISSING: (p) => (p.which === "NEW" ? tr("Falta a chave nova do webapp cifrada.", "The new encrypted webapp key is missing.") : tr("Falta a chave do webapp cifrada.", "The encrypted webapp key is missing.")),
  WEBAPP_KEY_NOT_FOUND: tr("Nenhuma conta com esta biometria.", "No account uses these biometrics."),
  CREDENTIAL_IN_USE: tr("Esta biometria já guarda a chave de outra conta. Use outra passkey.", "These biometrics already hold another account's key. Use another passkey."),
  WEBAPP_SIGNATURE_MISSING: tr("Trocar a carteira exige a chave do webapp (biometria).", "Changing the wallet requires the webapp key (biometrics)."),
  WEBAPP_BAD_SIGNATURE: (p) =>
    p.what === "COPY"
      ? tr("A cópia não foi assinada pela chave do webapp.", "The copy was not signed by the webapp key.")
      : p.what === "EMAIL"
        ? tr("O e-mail não foi confirmado pela chave do webapp.", "The email was not confirmed by the webapp key.")
        : p.what === "MISSING"
          ? tr("Falta a assinatura da chave do webapp.", "The webapp key signature is missing.")
          : tr("A assinatura não é da chave do webapp desta conta.", "The signature is not from this account's webapp key."),
  CLIENT_KEY_IS_SERVER_KEY: tr("A chave do serviço não pode ser do usuário.", "The service key can't be the user's key."),
  CHALLENGE_INVALID: (p) => (p.what === "EMAIL" ? tr("Código vencido ou já usado. Peça outro.", "Code expired or already used. Request a new one.") : tr("Desafio de entrada inválido. Tente de novo.", "Invalid sign-in challenge. Try again.")),
  EMAIL_INVALID: tr("E-mail inválido.", "Invalid email."),
  EMAIL_CODE_WRONG: tr("Código errado. Peça outro.", "Wrong code. Request a new one."),
  ENROLL_TX_UNEXPECTED: (p) => {
    const en: Record<string, string> = {
      LOOKUP_TABLE: "The account creation uses a lookup table.",
      PAYER: "The account creation is not paid by this wallet.",
      INSTRUCTION_COUNT: "The account creation has too many or too few instructions.",
      MEMO: "The first instruction is not the wallet and webapp memo.",
      NOT_SQUADS: "The second instruction is not from Squads.",
      NOT_CREATE_V2: "It is not multisig_create_v2.",
      CREATOR: "The account is not created by this wallet.",
      CONFIG_AUTHORITY: "The multisig has a config authority.",
      THRESHOLD: "It is not 2-of-3 without a time lock.",
      RENT_COLLECTOR: "The rent does not return to this wallet.",
      MEMBERS: "The members don't match the 2-of-3 model.",
      OPERATOR: "Operator missing or executor not unique.",
    };
    const pt: Record<string, string> = {
      LOOKUP_TABLE: "A criação da conta usa uma lookup table.",
      PAYER: "Quem paga a criação não é esta carteira.",
      INSTRUCTION_COUNT: "A criação da conta tem instruções a mais ou a menos.",
      MEMO: "A primeira instrução não é o memo da carteira e do webapp.",
      NOT_SQUADS: "A segunda instrução não é da Squads.",
      NOT_CREATE_V2: "Não é multisig_create_v2.",
      CREATOR: "Quem cria não é esta carteira.",
      CONFIG_AUTHORITY: "A multisig tem config authority.",
      THRESHOLD: "Não é 2 de 3 sem time lock.",
      RENT_COLLECTOR: "O rent não volta para esta carteira.",
      MEMBERS: "Os membros não batem com o modelo 2 de 3.",
      OPERATOR: "Operador ausente ou executor não é único.",
    };
    const k = str(p.what);
    return tr(pt[k] ?? "A transação de criação da conta não é a esperada.", en[k] ?? "The account creation transaction is not what was expected.");
  },

  // estado da multisig
  BAD_STATE: (p) =>
    p.what === "VOTER_PERMS"
      ? tr("Um votante tem permissão além de votar.", "A voter has permissions beyond voting.")
      : p.what === "EXECUTOR"
        ? tr("Executor ausente ou não é único.", "Executor missing or not unique.")
        : tr("A multisig não está no modelo 2 de 3.", "The multisig is not in the 2-of-3 model."),
  CONFIG_AUTHORITY_SET: (p) =>
    p.authority ? tr(`Multisig controlada por ${short(p.authority)}: uma chave sozinha mudaria os membros.`, `Multisig controlled by ${short(p.authority)}: a single key could change the members.`) : tr("Multisig controlada por uma chave sozinha.", "Multisig controlled by a single key."),
  MULTISIG_NOT_FOUND: (p) => (p.address ? tr(`A multisig ${short(p.address)} não existe.`, `Multisig ${short(p.address)} does not exist.`) : tr("Multisig não encontrada.", "Multisig not found.")),
  MULTISIG_WRONG_OWNER: tr("A conta não pertence ao programa Squads v4.", "The account does not belong to the Squads v4 program."),
  EXECUTOR_NOT_UNIQUE: tr("Mais de um membro pode executar.", "More than one member can execute."),
  OPERATOR_MISMATCH: tr("Operador ausente ou com permissões além de criar e executar.", "Operator missing or with permissions beyond create and execute."),
  THRESHOLD_NOT_2: (p) => (p.threshold !== undefined && p.threshold !== null ? tr(`Threshold on-chain é ${p.threshold} (esperado 2).`, `On-chain threshold is ${p.threshold} (expected 2).`) : tr("Threshold on-chain não é 2.", "On-chain threshold is not 2.")),
  TIMELOCK_MISMATCH: (p) => (p.timeLock !== undefined && p.timeLock !== null ? tr(`Time lock on-chain inesperado: ${p.timeLock}.`, `Unexpected on-chain time lock: ${p.timeLock}.`) : tr("Time lock on-chain inesperado.", "Unexpected on-chain time lock.")),
  UNEXPECTED_MEMBERS: (p) => (p.count !== undefined && p.count !== null ? tr(`${p.count} membros on-chain; esperado 4.`, `${p.count} members on-chain; expected 4.`) : tr("Número de membros on-chain inesperado (esperado 4).", "Unexpected number of members on-chain (expected 4).")),
  VOTERS_MISMATCH: tr("Os votantes on-chain não são os esperados.", "The on-chain voters are not the expected ones."),
  VOTER_PERMISSIONS: (p) => (p.key ? tr(`O votante ${short(p.key)} tem permissões ${p.permissions} (esperado só Vote).`, `Voter ${short(p.key)} has permissions ${p.permissions} (expected Vote only).`) : tr("Um votante tem permissões além de Vote.", "A voter has permissions beyond Vote.")),
  KEY_ALREADY_MEMBER: tr("Essa chave já é membro.", "This key is already a member."),
  KEY_REVOKED: (p) => (p.what === "WALLET" ? tr("Esta carteira foi substituída e não volta a valer.", "This wallet was replaced and can't be used again.") : tr("Chave substituída não volta a valer.", "A replaced key can't be used again.")),
  REVOKED_KEY_REUSE: tr("Chave revogada não volta a valer.", "A revoked key can't be used again."),
  SERVER_KEY_UNAVAILABLE: (p) => (p.what === "NEW" ? tr("Chave nova do serviço indisponível.", "The new service key is unavailable.") : tr("Chave do serviço indisponível.", "The service key is unavailable.")),

  // envio (intenção)
  INTENT_NOT_FOUND: tr("Envio não encontrado.", "Transfer not found."),
  INTENT_EXPIRED: (p) =>
    p.minutes
      ? tr(`O prazo de ${p.minutes} minutos para assinar este envio acabou. Nada saiu da sua conta; crie o envio de novo.`, `The ${p.minutes}-minute window to sign this transfer is over. Nothing left your account; create the transfer again.`)
      : tr("O prazo para assinar acabou.", "The time to sign is over."),
  INTENT_NOT_PENDING: (p) => notPending(p.status),
  INTENT_HASH_INVALID: tr("O hash da intenção não confere com os campos.", "The intent hash does not match its fields."),
  INTENT_TTL_TOO_LONG: tr("Validade acima do máximo.", "Validity period above the maximum."),
  INTENT_MISMATCH: (p) =>
    p.what === "SERVER_RETURNED_OTHER" ? tr("O serviço devolveu outra transação.", "The service returned a different transaction.") : tr("O que o servidor mostrou não é o que a transação faz.", "What the server showed is not what the transaction does."),
  BAD_INTENT: tr("O Vault da intenção não é o desta conta.", "The intent's Vault is not this account's Vault."),
  INVALID_AMOUNT: (p) => (p.what === "POSITIVE" ? tr("O valor deve ser positivo.", "The amount must be positive.") : tr("Valor em SOL inválido (até 9 casas, sem separador de milhar).", "Invalid SOL amount (up to 9 decimal places, no thousands separator).")),
  POLICY_DENIED: (p) => {
    switch (str(p.reason)) {
      case "ZERO_AMOUNT":
        return tr("O valor não pode ser zero.", "The amount can't be zero.");
      case "LIMIT_EXCEEDED":
        return tr(`Acima do limite de ${lamports(p.limitLamports)} SOL por envio.`, `Above the limit of ${lamports(p.limitLamports)} SOL per transfer.`);
      case "DESTINATION_IS_PROGRAM":
        return tr("O destino é um programa, não uma carteira. Confira o endereço.", "The destination is a program, not a wallet. Check the address.");
      case "DESTINATION_NOT_IN_ADDRESS_BOOK":
        return tr("O destino não está na sua lista de endereços.", "The destination is not in your address book.");
      case "RENT_MINIMUM":
        return tr("O Vault ficaria com menos que o mínimo da Solana (~0,00089 SOL). Envie tudo ou deixe um pouco mais.", "The Vault would drop below Solana's minimum (~0.00089 SOL). Send everything or leave a bit more.");
      case "INSUFFICIENT_FUNDS":
        return tr("O Vault não tem saldo para este envio.", "The Vault doesn't have enough balance for this transfer.");
      case "SIMULATION_FAILED":
        return tr("A Solana recusaria esta transação na simulação. Nada foi enviado.", "Solana would reject this transaction in simulation. Nothing was sent.");
      default:
        return tr("A política da conta não permite esta transação.", "The account policy does not allow this transaction.");
    }
  },
  UNSUPPORTED: (p) =>
    p.what === "CHAIN"
      ? tr("Esta chain não acompanha transações enviadas pela carteira.", "This chain doesn't track transactions sent by the wallet.")
      : p.type
        ? tr(`O tipo ${p.type} não é uma operação.`, `Type ${p.type} is not an operation.`)
        : tr("Não suportado.", "Not supported."),
  WRONG_CLUSTER: (p) => {
    const kind = p.kind === "CHANGE" ? tr("Troca de chave", "Key change") : tr("Intenção", "Intent");
    return p.want ? tr(`${kind} para ${p.want}, app em ${p.have}.`, `${kind} for ${p.want}, app on ${p.have}.`) : tr("Rede errada.", "Wrong cluster.");
  },
  STALE_INDEX: tr("Outra transação entrou antes desta. Volte e abra de novo.", "Another transaction got in before this one. Go back and open it again."),

  // transação
  TX_MALFORMED: tr("A transação recebida está ilegível.", "The received transaction is unreadable."),
  TX_MISMATCH: tr("A transação não pertence a esta multisig/índice.", "The transaction does not belong to this multisig/index."),
  TX_NOT_EXPECTED: (p) => (p.what === "SIGNED" ? tr("A transação assinada não é a preparada.", "The signed transaction is not the prepared one.") : tr("Esta transação não foi preparada pelo serviço.", "This transaction was not prepared by the service.")),
  TX_UNKNOWN_KIND: tr("Tipo de transação não suportado.", "Unsupported transaction type."),
  TX_WRONG_OWNER: tr("Conta da transação com dono inesperado.", "Transaction account with an unexpected owner."),
  TX_EXPIRED: tr(
    "A transação venceu enquanto esperava a assinatura na carteira (ela vale cerca de 1 minuto). Nada saiu da sua conta; assine de novo.",
    "The transaction expired while waiting for the wallet signature (it lasts about 1 minute). Nothing left your account; sign again.",
  ),
  ALT_NOT_SUPPORTED: tr("A transação usa uma address lookup table.", "The transaction uses an address lookup table."),
  BAD_MESSAGE: (p) => (p.what ? tr(`Mensagem malformada (${p.what}).`, `Malformed message (${p.what}).`) : tr("Mensagem malformada.", "Malformed message.")),
  BAD_SIGNATURE: (p) =>
    p.what === "VETO"
      ? tr("O veto não foi assinado por essa chave.", "The veto was not signed by this key.")
      : p.what === "MISSING"
        ? tr("Assinatura ausente.", "Signature missing.")
        : p.what === "LENGTH"
          ? tr("Assinatura com tamanho inválido.", "Signature has an invalid length.")
          : tr("Assinatura inválida.", "Invalid signature."),
  PREPARED_EXPIRED: (p) => (p.what === "REQUEST" ? tr("O pedido venceu. Peça de novo.", "The request expired. Request it again.") : tr("A transação preparada venceu. Prepare de novo.", "The prepared transaction expired. Prepare again.")),
  SERVER_NOT_SIGNED: (p) => (p.key ? tr(`Falta a assinatura de ${short(p.key)}.`, `Missing signature from ${short(p.key)}.`) : tr("Falta a assinatura do serviço na transação.", "The service signature is missing from the transaction.")),
  NO_TRANSACTION: tr("Falta a transação assinada pela carteira.", "The transaction signed by the wallet is missing."),
  SIMULATION_FAILED: (p) => (p.detail ? tr(`A transação falharia na Solana (${p.detail}).`, `The transaction would fail on Solana (${p.detail}).`) : tr("A simulação falhou.", "The simulation failed.")),
  WALLET_NO_SOL: (p) => {
    switch (str(p.need)) {
      case "ENROLL":
        return tr("Sua carteira precisa de SOL para esta transação (~0,003 SOL para criar a conta).", "Your wallet needs SOL for this transaction (~0.003 SOL to create the account).");
      case "SIGN":
        return tr(
          "Sua carteira precisa de SOL para esta transação (tenha ~0,007 SOL: o depósito das contas volta na mesma transação e o custo real é ~0,000015 SOL).",
          "Your wallet needs SOL for this transaction (keep ~0.007 SOL: the account deposit comes back in the same transaction and the real cost is ~0.000015 SOL).",
        );
      case "CHANGE":
        return tr("Sua carteira precisa de SOL para esta transação (a carteira que paga precisa de ~0,006 SOL, que voltam quando a troca executar).", "Your wallet needs SOL for this transaction (the paying wallet needs ~0.006 SOL, returned when the change executes).");
      default:
        return tr("Sua carteira precisa de SOL para esta transação.", "Your wallet needs SOL for this transaction.");
    }
  },
  WALLET_TX_FAILED: (p) => (p.detail ? tr(`A transação falhou (${p.detail}).`, `The transaction failed (${p.detail}).`) : tr("A transação falhou.", "The transaction failed.")),

  // trocas de chave
  CHANGE_NOT_FOUND: tr("Troca de chave não encontrada.", "Key change not found."),
  CHANGE_IN_PROGRESS: tr("Já existe uma troca de chave em andamento.", "A key change is already in progress."),
  CHANGE_MISMATCH: tr("A transação da troca é diferente da que o webapp monta.", "The key change transaction differs from the one the webapp builds."),
  CHANGE_NOT_APPROVED: (p) =>
    p.status === null || p.status === undefined || p.status === ""
      ? tr("O pedido não está mais aprovado na chain.", "The request is no longer approved on-chain.")
      : tr(`O pedido na chain está ${statusText(p.status)}.`, `The on-chain request is ${statusText(p.status)}.`),
  CHANGE_NOT_DUE: (p) => {
    const t = Number(p.executeAfter);
    return Number.isFinite(t) && t > 0 ? tr(`A troca só pode executar a partir de ${fmtWhen(t)}.`, `The key change can only execute from ${fmtWhen(t)}.`) : tr("A troca ainda não pode executar.", "The key change can't execute yet.");
  },
  CHANGE_NOT_OPEN: changeState({ pt: "não está mais aberta", en: "is no longer open" }),
  CHANGE_NOT_PENDING: changeState({ pt: "não está pendente", en: "is not pending" }),
  CHANGE_NOT_PREPARED: changeState({ pt: "não está preparada", en: "is not prepared" }),
  BAD_CHANGE: (p) => (p.what === "NEW_KEY_MEMBER" ? tr("A chave nova já é membro.", "The new key is already a member.") : tr("A chave a trocar não é a atual na chain.", "The key to replace is not the current one on-chain.")),
  NEW_KEY_MISSING: tr("Falta a chave nova.", "The new key is missing."),
  VETO_NOT_ALLOWED: (p) =>
    p.role === "CLIENT"
      ? tr("Só a carteira atual veta a troca dela.", "Only the current wallet can veto its own change.")
      : p.role === "WEBAPP"
        ? tr("Só a chave atual do webapp veta a troca dela.", "Only the current webapp key can veto its own change.")
        : tr("Só uma chave do usuário veta.", "Only one of the user's keys can veto."),
  PROPOSAL_NOT_ACTIVE: tr("A proposta não está mais aberta na Solana.", "The proposal is no longer open on Solana."),
  PROPOSAL_STALE: tr("A proposta ficou obsoleta depois de uma troca de chave.", "The proposal became stale after a key change."),
  ROTATION_NOT_REQUESTED_HERE: tr("Você não pediu esta troca de carteira neste app.", "You didn't request this wallet change in this app."),
  ROTATION_PROOF_INVALID: tr("A prova de que a chave nova pertence a quem diz não confere.", "The proof that the new key belongs to who it claims doesn't check out."),
  ROTATION_PROOF_MISSING: tr("Falta a prova de que a chave nova pertence a quem diz.", "The proof that the new key belongs to who it claims is missing."),

  // QR / celular
  PAY_NOT_FOUND: tr("Pedido não existe ou expirou. Gere outro QR.", "Request not found or expired. Generate a new QR."),
  PAY_USED: (p) => (p.what === "NOT_SIGN" ? tr("Este QR não é de assinatura.", "This QR is not for signing.") : tr("Este QR já foi usado ou expirou.", "This QR was already used or has expired.")),

  // HTTP do serviço
  BAD_REQUEST: tr("Pedido inválido.", "Invalid request."),
  UNAUTHORIZED: tr("Sem autorização.", "Not authorized."),
  SESSION_INVALID: tr("Sessão inválida. Entre de novo.", "Invalid session. Sign in again."),
  SESSION_STALE_WALLET: tr("Esta sessão é de uma carteira que não é mais a da conta.", "This session is from a wallet that is no longer the account's wallet."),
  FORBIDDEN_ACCOUNT: tr("Esta conta é de outro usuário.", "This account belongs to another user."),
  PHONE_NOT_SIGNED_IN: tr("Entre no celular primeiro.", "Sign in on your phone first."),
  INTERNAL: tr("Erro interno do serviço.", "Internal service error."),
  KEY_WIPED: tr("A chave do webapp já foi apagada da memória.", "The webapp key was already wiped from memory."),
};

/** Sem "[CÓDIGO]" e com maiúscula no começo. */
export const sentence = (m: string) => {
  const t = String(m).replace(/^\[[A-Z0-9_]+\]\s*/, "").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/**
 * A frase para este código e estes parâmetros, no idioma do app. Código sem
 * regra: o texto do servidor (`fallback`), nas duas línguas. Para BAD_REQUEST o
 * detalhe do servidor (campo inválido) vai junto: ajuda a quem está testando.
 */
export function errorMessage(code: string, params: Params | null | undefined, fallback: string): string {
  const rule = RULES[code];
  const p = params ?? {};
  if (rule === undefined) return sentence(fallback || code);
  const text = typeof rule === "string" ? rule : rule(p);
  if (code === "BAD_REQUEST" && fallback) return `${text} (${sentence(fallback)})`;
  return sentence(text);
}
