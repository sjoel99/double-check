import { type MessageV0, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { deny, type TransactionIntent, verifyIntentHash } from "@duplachave/shared";
import { MEMO_PROGRAM_ID, verifyEd25519 } from "@duplachave/crypto";
import { type Chain, parseInstruction, type ParsedInstruction } from "@duplachave/solana";
import * as squads from "@sqds/multisig";
import { atomicVaultInstructions, configRequestInstructions, innerVaultInstructions, type MultisigState, readMultisig, rotationActions, vaultPda } from "@duplachave/squads";

/**
 * Código compartilhado entre o serviço e o webapp: os dois montam exatamente a
 * mesma transação a partir da intenção (ou da troca) e do estado da chain, e o
 * webapp compara byte a byte o que o serviço entregou.
 *
 * Modelo 2 de 3: votam a Phantom (client), a chave do webapp (webapp) e o
 * serviço (server); só o operador do serviço cria e executa.
 */

/** O que o serviço entrega ao webapp para assinar uma operação. Nada disso é confiável até ser conferido. */
export type ApprovalRequest = {
  intent: TransactionIntent;
  riskFlags: string[];
  /** Transação sem assinaturas (base64). */
  transaction: string;
};

export const MAX_INTENT_TTL = 60 * 60;

/** Memo da transação da Squads: liga o que entra na chain à intenção (auditoria). */
export const intentMemo = (intent: TransactionIntent) => `dk1:${intent.intentHash.slice(0, 32)}`;

/** Quem é quem, lido da chain. O webapp sabe a própria chave; o serviço é o votante que sobra. */
export type AccountRoles = { client: PublicKey; webapp: PublicKey; server: PublicKey; operator: PublicKey };

export function rolesFromState(state: MultisigState, mine: { client: PublicKey; webapp: PublicKey }): AccountRoles {
  const voters = state.members.filter((m) => m.vote);
  const has = (k: PublicKey) => voters.find((m) => m.key === k.toBase58());
  if (!has(mine.client)) deny("NOT_A_VOTER", "esta carteira não é votante desta conta");
  if (!has(mine.webapp)) deny("WEBAPP_NOT_A_VOTER", "a chave deste webapp não é votante desta conta");
  const others = voters.filter((m) => m.key !== mine.client.toBase58() && m.key !== mine.webapp.toBase58());
  const operators = state.members.filter((m) => m.mask === 5);
  if (voters.length !== 3 || others.length !== 1 || state.threshold !== 2) deny("BAD_STATE", "a multisig não está no modelo 2 de 3");
  if (voters.some((m) => m.mask !== 2)) deny("BAD_STATE", "votante com permissão além de votar");
  if (state.members.filter((m) => m.mask & 4).length !== 1 || operators.length !== 1) deny("BAD_STATE", "executor ausente ou não é único");
  if (state.configAuthority !== PublicKey.default.toBase58()) deny("CONFIG_AUTHORITY_SET", "multisig controlada por uma chave");
  return { client: mine.client, webapp: mine.webapp, server: new PublicKey(others[0]!.key), operator: new PublicKey(operators[0]!.key) };
}

/** O rent das contas da proposta só volta (fechando-as) se o rent_collector é a Phantom. */
const rentBack = (state: MultisigState, client: PublicKey) => (state.rentCollector === client.toBase58() ? client : null);

/** Operação: Phantom + webapp votam, o operador executa, a Phantom paga. */
export function atomicInstructionsFor(intent: TransactionIntent, roles: AccountRoles, state: MultisigState): TransactionInstruction[] {
  if (intent.type !== "TRANSFER_SOL") deny("UNSUPPORTED", `o tipo ${intent.type} não é uma operação atômica`);
  const multisig = new PublicKey(intent.multisig);
  const vault = vaultPda(multisig, 0);
  if (intent.vault !== vault.toBase58()) deny("BAD_INTENT", "o Vault da intenção não é o desta conta");
  return atomicVaultInstructions({
    multisig,
    index: BigInt(intent.transactionIndex),
    operator: roles.operator,
    voters: [roles.client, roles.webapp],
    payer: roles.client,
    rentCollector: rentBack(state, roles.client),
    memo: intentMemo(intent),
    instructions: [SystemProgram.transfer({ fromPubkey: vault, toPubkey: new PublicKey(intent.destination), lamports: BigInt(intent.amountLamports) })],
  });
}

export function compileAtomic(instructions: TransactionInstruction[], payer: PublicKey, recentBlockhash: string): MessageV0 {
  return new TransactionMessage({ payerKey: payer, recentBlockhash, instructions }).compileToV0Message();
}

export function memoIx(text: string, signers: PublicKey[]) {
  return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: signers.map((pubkey) => ({ pubkey, isSigner: true, isWritable: false })), data: Buffer.from(text, "utf8") });
}

// ---------------------------------------------------------------------------
// trocas de votante (pedido com prazo)
// ---------------------------------------------------------------------------

export type SecurityChangeRole = "CLIENT" | "WEBAPP" | "SERVER";
export type SecurityChangeDesc = { id: string; role: SecurityChangeRole; oldKey: string; newKey: string; multisig: string; index: string; cluster: string; delaySeconds: number };

/**
 * Quem vota e quem paga cada troca:
 * - CLIENT (trocar a Phantom): webapp + serviço votam; a Phantom NOVA paga (e prova posse assinando);
 * - WEBAPP (recuperar o webapp): Phantom + serviço votam e a Phantom paga; a chave nova assina o memo;
 * - SERVER (chave do serviço): Phantom + serviço votam e a Phantom paga; a chave nova (do serviço) assina o memo.
 */
export function securityChangeParties(role: SecurityChangeRole, roles: AccountRoles, newKey: PublicKey) {
  if (role === "CLIENT") return { voters: [roles.webapp, roles.server] as [PublicKey, PublicKey], payer: newKey };
  return { voters: [roles.client, roles.server] as [PublicKey, PublicKey], payer: roles.client };
}

/** Texto que a chave nova assina (memo): prova de posse ligada a esta troca e a esta conta. */
export function securityChangeMemo(c: SecurityChangeDesc) {
  const what = c.role === "CLIENT" ? "nova Phantom" : c.role === "WEBAPP" ? "nova chave do webapp" : "nova chave do serviço";
  return `Dupla Chave: ${what} na conta ${c.multisig} (${c.cluster}). Pedido ${c.id}. Executa em ${Math.round(c.delaySeconds / 3600)} h, se ninguém vetar.`;
}

export function securityRequestInstructionsFor(c: SecurityChangeDesc, roles: AccountRoles): TransactionInstruction[] {
  const newKey = new PublicKey(c.newKey);
  const { voters, payer } = securityChangeParties(c.role, roles, newKey);
  return [
    memoIx(securityChangeMemo(c), [newKey]),
    ...configRequestInstructions({
      multisig: new PublicKey(c.multisig),
      index: BigInt(c.index),
      operator: roles.operator,
      voters,
      payer,
      actions: rotationActions(new PublicKey(c.oldKey), newKey, c.role),
      memo: `dk1:troca:${c.id.slice(0, 8)}`,
    }),
  ];
}

/** Texto do "Não fui eu", assinado por um votante do usuário que não está sendo trocado. */
export function vetoMessage(c: { id: string; multisig: string; role: SecurityChangeRole; newKey: string }) {
  return ["Dupla Chave", "Não fui eu: cancelar esta troca de chave.", "", `Conta: ${c.multisig}`, `Troca: ${c.role} → ${c.newKey}`, `Pedido: ${c.id}`].join("\n");
}

// ---------------------------------------------------------------------------
// conferência no webapp
// ---------------------------------------------------------------------------

export type Review = { transaction: VersionedTransaction; state: MultisigState; roles: AccountRoles; message: Uint8Array };

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

function decodeTransaction(b64: string): VersionedTransaction {
  try {
    return VersionedTransaction.deserialize(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  } catch {
    deny("TX_MALFORMED", "transação ilegível");
  }
}

/**
 * Conferência do lado do webapp, com a RPC fixada no build: a multisig está no
 * modelo 2 de 3 com esta Phantom e esta chave do webapp, e a transação é, byte
 * a byte, a que o webapp monta sozinho a partir da intenção exibida.
 */
export async function reviewPrepared(chain: Chain, request: ApprovalRequest, mine: { client: PublicKey; webapp: PublicKey }, now: number): Promise<Review> {
  const { intent } = request;
  if (!verifyIntentHash(intent)) deny("INTENT_HASH_INVALID", "hash da intenção não confere com os campos");
  if (intent.cluster !== chain.cluster) deny("WRONG_CLUSTER", `intenção para ${intent.cluster}, app em ${chain.cluster}`);
  if (now > intent.expiresAt) deny("INTENT_EXPIRED", "intenção expirada");
  if (intent.expiresAt - intent.createdAt > MAX_INTENT_TTL) deny("INTENT_TTL_TOO_LONG", "validade acima do máximo");
  const state = await readMultisig(chain, new PublicKey(intent.multisig));
  const roles = rolesFromState(state, mine);
  if (BigInt(intent.transactionIndex) !== state.transactionIndex + 1n) deny("STALE_INDEX", "outra transação entrou antes; prepare de novo");
  const tx = decodeTransaction(request.transaction);
  const expected = compileAtomic(atomicInstructionsFor(intent, roles, state), roles.client, tx.message.recentBlockhash);
  const bytes = tx.message.serialize();
  if (!sameBytes(expected.serialize(), bytes)) deny("INTENT_MISMATCH", "a transação recebida é diferente da que o webapp monta a partir da tela");
  return { transaction: tx, state, roles, message: bytes };
}

/** Pedido de troca: o webapp remonta e compara os bytes. */
export async function reviewSecurityRequest(chain: Chain, change: SecurityChangeDesc, transactionB64: string, mine: { client: PublicKey; webapp: PublicKey }): Promise<Review> {
  if (change.cluster !== chain.cluster) deny("WRONG_CLUSTER", `troca para ${change.cluster}, app em ${chain.cluster}`);
  const state = await readMultisig(chain, new PublicKey(change.multisig));
  const roles = rolesFromState(state, mine);
  const oldNow = change.role === "CLIENT" ? roles.client : change.role === "WEBAPP" ? roles.webapp : roles.server;
  if (oldNow.toBase58() !== change.oldKey) deny("BAD_CHANGE", "a chave a trocar não é a atual na chain");
  if (state.members.some((m) => m.key === change.newKey)) deny("BAD_CHANGE", "a chave nova já é membro");
  if (BigInt(change.index) !== state.transactionIndex + 1n) deny("STALE_INDEX", "outra transação entrou antes; prepare de novo");
  const tx = decodeTransaction(transactionB64);
  const { payer } = securityChangeParties(change.role, roles, new PublicKey(change.newKey));
  const expected = compileAtomic(securityRequestInstructionsFor(change, roles), payer, tx.message.recentBlockhash);
  const bytes = tx.message.serialize();
  if (!sameBytes(expected.serialize(), bytes)) deny("CHANGE_MISMATCH", "a transação da troca é diferente da que o webapp monta");
  return { transaction: tx, state, roles, message: bytes };
}

/**
 * Depois de o serviço assinar: mesmos bytes conferidos, e as assinaturas
 * esperadas presentes e válidas. Só então a Phantom assina.
 */
export function verifyAuthorized(review: Review, transactionB64: string, required: PublicKey[] = [review.roles.operator, review.roles.webapp]): VersionedTransaction {
  const tx = decodeTransaction(transactionB64);
  const bytes = tx.message.serialize();
  if (!sameBytes(bytes, review.message)) deny("INTENT_MISMATCH", "o serviço devolveu outra transação");
  const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
  for (const who of required) {
    const i = signers.findIndex((k) => k.equals(who));
    if (i < 0 || !verifyEd25519(bytes, tx.signatures[i]!, who)) deny("SERVER_NOT_SIGNED", `falta a assinatura de ${who.toBase58().slice(0, 4)}…`);
  }
  return tx;
}

export type Inspection = { ok: true; review: Review } | { ok: false; code: string; message: string; actual: ParsedInstruction[] | null };

/** reviewPrepared sem lançar; no bloqueio, diz o que a transação recebida faria de verdade. */
export async function inspectPrepared(chain: Chain, request: ApprovalRequest, mine: { client: PublicKey; webapp: PublicKey }, now: number): Promise<Inspection> {
  try {
    return { ok: true, review: await reviewPrepared(chain, request, mine, now) };
  } catch (e) {
    let actual: ParsedInstruction[] | null = null;
    try {
      actual = innerVaultInstructions(decodeTransaction(request.transaction).message)?.map(parseInstruction) ?? null;
    } catch {
      /* transação ilegível */
    }
    return { ok: false, code: (e as { code?: string }).code ?? "ERROR", message: (e as Error).message, actual };
  }
}

/**
 * Cadastro: a Phantom paga a criação, então o webapp confere a transação antes
 * — só o memo (assinado pela Phantom e pela chave do webapp) e a criação de uma
 * multisig 2 de 3 com esta Phantom e esta chave do webapp votando, um terceiro
 * votante (serviço), o operador (cria e executa), sem config authority, sem
 * time lock e com o rent voltando para a Phantom.
 */
export function verifyEnrollmentTransaction(transactionB64: string, wallet: PublicKey, webapp: PublicKey): { multisig: string; vault: string; transaction: VersionedTransaction } {
  const tx = decodeTransaction(transactionB64);
  const m = tx.message;
  const keys = m.staticAccountKeys;
  if (m.addressTableLookups.length) deny("ENROLL_TX_UNEXPECTED", "lookup table na criação da conta");
  if (!keys[0]?.equals(wallet)) deny("ENROLL_TX_UNEXPECTED", "quem paga a criação não é esta carteira");
  const ixs = m.compiledInstructions;
  const memo = ixs[0];
  const create = ixs[1];
  if (ixs.length !== 2 || !memo || !create) deny("ENROLL_TX_UNEXPECTED", "a criação da conta tem instruções a mais ou a menos");
  const memoSigners = memo.accountKeyIndexes.map((i) => keys[i]!.toBase58()).sort();
  if (!keys[memo.programIdIndex]!.equals(MEMO_PROGRAM_ID) || memoSigners.join() !== [wallet.toBase58(), webapp.toBase58()].sort().join()) deny("ENROLL_TX_UNEXPECTED", "primeira instrução não é o memo da carteira e do webapp");
  if (!keys[create.programIdIndex]!.equals(squads.PROGRAM_ID)) deny("ENROLL_TX_UNEXPECTED", "segunda instrução não é da Squads");
  const data = Buffer.from(create.data);
  if (!data.subarray(0, 8).equals(Buffer.from(squads.generated.multisigCreateV2InstructionDiscriminator))) deny("ENROLL_TX_UNEXPECTED", "não é multisig_create_v2");
  const [{ args }] = squads.generated.multisigCreateV2Struct.deserialize(data);
  const accounts = create.accountKeyIndexes.map((i) => keys[i]!);
  const multisig = accounts[2]!;
  if (!accounts[4]?.equals(wallet)) deny("ENROLL_TX_UNEXPECTED", "quem cria não é esta carteira");
  if (args.configAuthority !== null) deny("ENROLL_TX_UNEXPECTED", "multisig com config authority");
  if (args.threshold !== 2 || args.timeLock !== 0) deny("ENROLL_TX_UNEXPECTED", "não é 2 de 3 sem time lock");
  if (!args.rentCollector?.equals(wallet)) deny("ENROLL_TX_UNEXPECTED", "o rent não volta para esta carteira");
  const masks = args.members.map((x) => ({ key: x.key.toBase58(), mask: x.permissions.mask }));
  const mask = (k: PublicKey) => masks.find((x) => x.key === k.toBase58())?.mask;
  const voters = masks.filter((x) => x.mask & 2);
  if (masks.length !== 4 || voters.length !== 3 || voters.some((v) => v.mask !== 2) || mask(wallet) !== 2 || mask(webapp) !== 2) deny("ENROLL_TX_UNEXPECTED", "membros diferentes do modelo 2 de 3");
  if (masks.filter((x) => x.mask === 5).length !== 1 || masks.filter((x) => x.mask & 4).length !== 1) deny("ENROLL_TX_UNEXPECTED", "operador ausente ou executor não é único");
  return { multisig: multisig.toBase58(), vault: vaultPda(multisig, 0).toBase58(), transaction: tx };
}

/** Antes de depositar: a conta na chain tem esta Phantom votando, e o Vault é o dela. */
export async function verifyAccountOnChain(chain: Chain, multisig: string, wallet: PublicKey): Promise<string> {
  const state = await readMultisig(chain, new PublicKey(multisig));
  if (!state.members.some((m) => m.vote && m.key === wallet.toBase58()) || state.threshold !== 2) deny("NOT_A_VOTER", "esta carteira não é votante desta conta");
  return vaultPda(new PublicKey(multisig), 0).toBase58();
}

/** Para testes e para as carteiras de teste: assina como a carteira faria (mantém as outras assinaturas). */
export async function signAsWallet(tx: VersionedTransaction, signer: { publicKey(): Promise<PublicKey>; sign(m: Uint8Array): Promise<Uint8Array> }): Promise<string> {
  const pk = await signer.publicKey();
  tx.addSignature(pk, await signer.sign(tx.message.serialize()));
  return Buffer.from(tx.serialize()).toString("base64");
}
