import { type MessageV0, PublicKey, SystemProgram, type TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { deny, type TransactionIntent, verifyIntentHash } from "@duplachave/shared";
import { MEMO_PROGRAM_ID, possessionMessage, type PossessionFields, type Signer, verifyEd25519, verifyWalletProof, type WalletProof } from "@duplachave/crypto";
import * as squads from "@sqds/multisig";
import { type Chain, parseInstruction, type ParsedInstruction } from "@duplachave/solana";
import { atomicConfigInstructions, atomicVaultInstructions, innerVaultInstructions, type MultisigState, readMultisig, rotationActions, vaultPda } from "@duplachave/squads";

const utf8ToBytes = (s: string) => new TextEncoder().encode(s);

/**
 * O que o backend entrega ao app para a carteira assinar: a intenção e a
 * transação atômica (criar + voto do serviço + voto da carteira + executar +
 * fechar), já assinada pelo serviço e pelo proponente. A carteira paga a taxa
 * e assina por último. Nada disso é confiável até `reviewPrepared`.
 */
export type ApprovalRequest = {
  intent: TransactionIntent;
  riskFlags: string[];
  /** Transação parcialmente assinada (base64). */
  transaction: string;
  /** Rotação: a prova de posse assinada pela chave nova. O app confere a assinatura. */
  possession?: WalletProof | null;
};

export const MAX_INTENT_TTL = 60 * 60;

/** Memo da transação da Squads: liga o que entra na chain à intenção (auditoria). */
export const intentMemo = (intent: TransactionIntent) => `dk1:${intent.intentHash.slice(0, 32)}`;

/** Quem é quem na transação atômica. */
export type AtomicRoles = { proposer: PublicKey; server: PublicKey; wallet: PublicKey };

/** Papéis lidos da chain (não do backend): o outro votante e o único proponente. */
export function rolesFromState(state: MultisigState, wallet: PublicKey): AtomicRoles {
  const me = state.members.find((m) => m.key === wallet.toBase58());
  if (!me?.vote) deny("NOT_A_VOTER", "esta carteira não é votante desta conta");
  const voters = state.members.filter((m) => m.vote);
  const other = voters.find((m) => m.key !== wallet.toBase58());
  const proposers = state.members.filter((m) => m.mask === 1);
  if (voters.length !== 2 || !other || state.threshold !== 2) deny("BAD_STATE", "a multisig não está no modelo 2 de 2");
  if (state.configAuthority !== PublicKey.default.toBase58()) deny("CONFIG_AUTHORITY_SET", "multisig controlada por uma chave");
  if (proposers.length !== 1) deny("BAD_STATE", "proponente ausente ou duplicado");
  return { proposer: new PublicKey(proposers[0]!.key), server: new PublicKey(other.key), wallet };
}

/**
 * Instruções da transação atômica de uma intenção. Servidor e app usam esta
 * mesma função: o app remonta a transação a partir do que mostra na tela.
 */
export function atomicInstructionsFor(intent: TransactionIntent, roles: AtomicRoles, state: MultisigState): TransactionInstruction[] {
  const multisig = new PublicKey(intent.multisig);
  const base = { multisig, index: BigInt(intent.transactionIndex), proposer: roles.proposer, server: roles.server, wallet: roles.wallet, memo: intentMemo(intent) };
  // O rent das contas da proposta só volta (fechando-as) se o rent_collector é a carteira.
  const rentBack = state.rentCollector === roles.wallet.toBase58();
  if (intent.type === "TRANSFER_SOL") {
    const vault = vaultPda(multisig, 0);
    if (intent.vault !== vault.toBase58()) deny("BAD_INTENT", "o Vault da intenção não é o desta conta");
    return atomicVaultInstructions({ ...base, close: rentBack, instructions: [SystemProgram.transfer({ fromPubkey: vault, toPubkey: new PublicKey(intent.destination), lamports: BigInt(intent.amountLamports) })] });
  }
  if (intent.type === "ROTATE_MEMBER") {
    const newKey = new PublicKey(intent.newKey);
    // Na troca da carteira, o rent_collector passa para a nova (SetRentCollector na mesma transação).
    const rentCollector = intent.role === "CLIENT" ? newKey : rentBack ? roles.wallet : null;
    return atomicConfigInstructions({ ...base, actions: rotationActions(new PublicKey(intent.oldKey), newKey, intent.role), rentCollector });
  }
  deny("UNSUPPORTED", `o tipo ${intent.type} ainda não tem transação atômica`);
}

export function compileAtomic(instructions: TransactionInstruction[], wallet: PublicKey, recentBlockhash: string): MessageV0 {
  return new TransactionMessage({ payerKey: wallet, recentBlockhash, instructions }).compileToV0Message();
}

/**
 * Rotação: confere a prova de posse (assinada pela chave nova) que o backend
 * diz ter verificado. O app não aceita "posse provada" só porque o servidor disse.
 */
export function verifyRotationProof(request: ApprovalRequest): void {
  const intent = request.intent;
  if (intent.type !== "ROTATE_MEMBER") return;
  const p = request.possession;
  if (!p) deny("ROTATION_PROOF_MISSING", "rotação sem prova de posse da chave nova");
  const op = intent.role === "CLIENT" ? "ROTATE_CLIENT_KEY" : "ROTATE_SERVER_KEY";
  if (p.publicKey !== intent.newKey || p.account !== intent.multisig || p.cluster !== intent.cluster || p.operation !== op)
    deny("ROTATION_PROOF_INVALID", "prova de posse não corresponde a esta rotação");
  if (!verifyWalletProof(p)) deny("ROTATION_PROOF_INVALID", "assinatura da prova não é da chave nova");
}

export type Review = { transaction: VersionedTransaction; state: MultisigState };

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

function decodeTransaction(b64: string): VersionedTransaction {
  try {
    return VersionedTransaction.deserialize(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  } catch {
    deny("TX_MALFORMED", "transação ilegível");
  }
}

/**
 * Conferência do lado do app, com a RPC fixada no build (nunca indicada pelo
 * backend): a multisig está no modelo 2-de-2, e a transação que a carteira vai
 * assinar é, byte a byte, a que o app monta sozinho a partir da intenção
 * exibida e do estado da chain. O serviço já assinou exatamente esses bytes.
 */
export async function reviewPrepared(
  chain: Chain,
  request: ApprovalRequest,
  wallet: PublicKey,
  now: number,
  opts: { initiatedHere?: (rotationId: string) => boolean } = {},
): Promise<Review> {
  const { intent } = request;
  if (!verifyIntentHash(intent)) deny("INTENT_HASH_INVALID", "hash da intenção não confere com os campos");
  if (intent.cluster !== chain.cluster) deny("WRONG_CLUSTER", `intenção para ${intent.cluster}, app em ${chain.cluster}`);
  if (now > intent.expiresAt) deny("INTENT_EXPIRED", "intenção expirada");
  if (intent.expiresAt - intent.createdAt > MAX_INTENT_TTL) deny("INTENT_TTL_TOO_LONG", "validade acima do máximo");

  const state = await readMultisig(chain, new PublicKey(intent.multisig));
  const roles = rolesFromState(state, wallet);
  if (BigInt(intent.transactionIndex) !== state.transactionIndex + 1n) deny("STALE_INDEX", "outra transação entrou antes; prepare de novo");
  verifyRotationProof(request);
  if (intent.type === "ROTATE_MEMBER" && intent.role === "CLIENT" && opts.initiatedHere && !opts.initiatedHere(intent.rotationId))
    deny("ROTATION_NOT_REQUESTED_HERE", "esta troca de carteira não foi pedida neste app");

  const tx = decodeTransaction(request.transaction);
  const expected = compileAtomic(atomicInstructionsFor(intent, roles, state), wallet, tx.message.recentBlockhash);
  const bytes = tx.message.serialize();
  if (!sameBytes(expected.serialize(), bytes)) deny("INTENT_MISMATCH", "a transação recebida é diferente da que o app monta a partir da tela");

  // Serviço e proponente assinaram de verdade; senão a carteira assinaria algo que nem entra.
  const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
  for (const who of [roles.server, roles.proposer]) {
    const i = signers.findIndex((k) => k.equals(who));
    if (i < 0 || !verifyEd25519(bytes, tx.signatures[i]!, who)) deny("SERVER_NOT_SIGNED", "falta a assinatura do serviço");
  }
  return { transaction: tx, state };
}

export type Inspection = { ok: true; review: Review } | { ok: false; code: string; message: string; actual: ParsedInstruction[] | null };

/** reviewPrepared sem lançar; no bloqueio, diz o que a transação recebida faria de verdade. */
export async function inspectPrepared(chain: Chain, request: ApprovalRequest, wallet: PublicKey, now: number, opts: { initiatedHere?: (rotationId: string) => boolean } = {}): Promise<Inspection> {
  try {
    return { ok: true, review: await reviewPrepared(chain, request, wallet, now, opts) };
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
 * Cadastro: a carteira paga a criação, então o app confere a transação antes
 * de ela assinar — só o memo e a criação de uma multisig 2-de-2 com esta
 * carteira (Vote + Execute), um outro votante (só Vote), executor e proponente
 * sem voto, sem config authority, sem time lock e com o rent voltando para ela.
 * Nada de transferência escondida da carteira.
 */
export function verifyEnrollmentTransaction(transactionB64: string, wallet: PublicKey): { multisig: string; vault: string; transaction: VersionedTransaction } {
  const tx = decodeTransaction(transactionB64);
  const m = tx.message;
  const keys = m.staticAccountKeys;
  if (m.addressTableLookups.length) deny("ENROLL_TX_UNEXPECTED", "lookup table na criação da conta");
  if (!keys[0]?.equals(wallet)) deny("ENROLL_TX_UNEXPECTED", "quem paga a criação não é esta carteira");
  const ixs = m.compiledInstructions;
  const memo = ixs[0];
  const create = ixs[1];
  if (ixs.length !== 2 || !memo || !create) deny("ENROLL_TX_UNEXPECTED", "a criação da conta tem instruções a mais ou a menos");
  if (!keys[memo.programIdIndex]!.equals(MEMO_PROGRAM_ID) || memo.accountKeyIndexes.some((i) => !keys[i]!.equals(wallet))) deny("ENROLL_TX_UNEXPECTED", "primeira instrução não é o memo da carteira");
  if (!keys[create.programIdIndex]!.equals(squads.PROGRAM_ID)) deny("ENROLL_TX_UNEXPECTED", "segunda instrução não é da Squads");
  const data = Buffer.from(create.data);
  if (!data.subarray(0, 8).equals(Buffer.from(squads.generated.multisigCreateV2InstructionDiscriminator))) deny("ENROLL_TX_UNEXPECTED", "não é multisig_create_v2");
  const [{ args }] = squads.generated.multisigCreateV2Struct.deserialize(data);
  const accounts = create.accountKeyIndexes.map((i) => keys[i]!);
  const multisig = accounts[2]!;
  if (!accounts[4]?.equals(wallet)) deny("ENROLL_TX_UNEXPECTED", "quem cria não é esta carteira");
  if (args.configAuthority !== null) deny("ENROLL_TX_UNEXPECTED", "multisig com config authority");
  if (args.threshold !== 2 || args.timeLock !== 0) deny("ENROLL_TX_UNEXPECTED", "não é 2 de 2 sem time lock");
  if (!args.rentCollector?.equals(wallet)) deny("ENROLL_TX_UNEXPECTED", "o rent não volta para esta carteira");
  const masks = args.members.map((x) => ({ key: x.key, mask: x.permissions.mask }));
  const voters = masks.filter((x) => x.mask & 2);
  const me = masks.filter((x) => x.key.equals(wallet));
  const other = voters.find((x) => !x.key.equals(wallet));
  if (masks.length !== 4 || voters.length !== 2 || me.length !== 1 || me[0]!.mask !== 6 || other?.mask !== 2) deny("ENROLL_TX_UNEXPECTED", "membros diferentes do modelo 2 de 2");
  if (masks.filter((x) => x.mask === 4).length !== 1 || masks.filter((x) => x.mask === 1).length !== 1) deny("ENROLL_TX_UNEXPECTED", "executor ou proponente fora do esperado");
  return { multisig: multisig.toBase58(), vault: vaultPda(multisig, 0).toBase58(), transaction: tx };
}

/** Antes de depositar: a conta na chain é 2-de-2 com esta carteira, e o Vault é o dela. */
export async function verifyAccountOnChain(chain: Chain, multisig: string, wallet: PublicKey): Promise<string> {
  rolesFromState(await readMultisig(chain, new PublicKey(multisig)), wallet);
  return vaultPda(new PublicKey(multisig), 0).toBase58();
}

/** Para testes e para a carteira de teste: assina como a carteira faria (mantém as outras assinaturas). */
export async function signAsWallet(tx: VersionedTransaction, signer: Signer): Promise<string> {
  const pk = await signer.publicKey();
  tx.addSignature(pk, await signer.sign(tx.message.serialize()));
  return Buffer.from(tx.serialize()).toString("base64");
}

/** Prova de posse assinada pela carteira (signMessage com o texto legível). */
export async function signWalletPossession(signer: Signer, fields: Omit<PossessionFields, "publicKey">): Promise<WalletProof> {
  const publicKey = (await signer.publicKey()).toBase58();
  const full = { ...fields, publicKey };
  const sig = await signer.sign(utf8ToBytes(possessionMessage(full)));
  return { ...full, signature: bs58.encode(sig) };
}
