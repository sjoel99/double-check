import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { deny, type TransactionIntent, verifyIntentHash } from "@duplachave/shared";
import { possessionMessage, type PossessionFields, type Signer, verifyWalletProof, type WalletProof } from "@duplachave/crypto";
import type { Chain } from "@duplachave/solana";
import {
  approvalMemo,
  approveIx,
  cancelIx,
  compareIntent,
  executeVaultIx,
  readMultisig,
  readProposal,
  readTransaction,
  vaultPda,
  viewConfigTransaction,
  viewVaultTransaction,
  type ConfigView,
  type VaultView,
} from "@duplachave/squads";

const utf8ToBytes = (s: string) => new TextEncoder().encode(s);

/**
 * O que a carteira assina:
 * - APPROVE_AND_EXECUTE (operação): aprovar + executar numa transação. O servidor
 *   já aprovou; se a execução falhar, o voto também não fica (transação atômica).
 * - APPROVE (mudança de segurança): só aprovar; o executor do serviço executa e
 *   confere o resultado na chain.
 * - CANCEL: cancelar uma aprovada que não executou (o servidor cancela junto).
 */
export type SignMode = "APPROVE_AND_EXECUTE" | "APPROVE" | "CANCEL";

/** O que o backend entrega ao app. Nada disso é confiável até `reviewOnChain`. */
export type ApprovalRequest = {
  intent: TransactionIntent;
  riskFlags: string[];
  feePayer: string;
  recentBlockhash: string;
  mode: SignMode;
  /** Rotação: a prova de posse assinada pela chave nova. O app confere a assinatura. */
  possession?: WalletProof | null;
};

export const MAX_INTENT_TTL = 60 * 60;

export type Review = { view: VaultView | ConfigView; transactionHash: string; serverApproved: boolean };

/**
 * Conferência do lado do app, contra uma RPC fixada no build do app (nunca
 * indicada pelo backend): a intenção exibida tem que ser exatamente o que está
 * na chain no índice dela.
 */
export async function reviewOnChain(chain: Chain, intent: TransactionIntent, me: PublicKey, now: number, opts: { expect?: "Active" | "Approved" } = {}): Promise<Review> {
  const expect = opts.expect ?? "Active";
  if (!verifyIntentHash(intent)) deny("INTENT_HASH_INVALID", "hash da intenção não confere com os campos");
  if (intent.cluster !== chain.cluster) deny("WRONG_CLUSTER", `intenção para ${intent.cluster}, app em ${chain.cluster}`);
  if (expect === "Active" && now > intent.expiresAt) deny("INTENT_EXPIRED", "intenção expirada");
  if (intent.expiresAt - intent.createdAt > MAX_INTENT_TTL) deny("INTENT_TTL_TOO_LONG", "validade acima do máximo");

  const ms = new PublicKey(intent.multisig);
  const index = BigInt(intent.transactionIndex);
  const state = await readMultisig(chain, ms);
  const meMember = state.members.find((m) => m.key === me.toBase58());
  if (!meMember?.vote) deny("NOT_A_VOTER", "esta carteira não é votante desta conta");
  const other = state.members.find((m) => m.vote && m.key !== me.toBase58());
  if (!other) deny("BAD_STATE", "sem segundo votante");

  const tx = await readTransaction(chain, ms, index);
  if (!tx) deny("TX_NOT_FOUND", "transação não existe na chain");
  const proposal = await readProposal(chain, ms, index);
  if (proposal?.status !== expect) deny("PROPOSAL_NOT_ACTIVE", `proposta em ${proposal?.status ?? "inexistente"}`);
  if (expect === "Active" && index <= state.staleTransactionIndex) deny("PROPOSAL_STALE", "proposta anterior à última mudança de configuração");

  const view =
    tx.kind === "VAULT"
      ? viewVaultTransaction(tx, vaultPda(ms, 0))
      : viewConfigTransaction(tx, state, { client: me.toBase58(), server: other.key, executor: "", proposer: "" });
  const diffs = compareIntent(intent, view);
  if (diffs.length) deny("INTENT_MISMATCH", `a transação na chain é diferente da exibida: ${diffs.join("; ")}`);
  return { view, transactionHash: tx.hash, serverApproved: proposal.approved.includes(other.key) };
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

/**
 * Monta a transação que a carteira vai assinar. O app nunca assina bytes que
 * não montou: aqui saem só as instruções esperadas para esta intenção, com o
 * pagador de taxas do serviço.
 */
export async function buildWalletTransaction(args: {
  chain: Chain;
  request: ApprovalRequest;
  wallet: PublicKey;
  now: number;
  /** Troca da carteira do cliente só vale se foi pedida nesta sessão do app. */
  initiatedHere?: (rotationId: string) => boolean;
}): Promise<{ transaction: VersionedTransaction; review: Review }> {
  const { chain, request, wallet, now } = args;
  const { intent, mode } = request;
  const review = await reviewOnChain(chain, intent, wallet, now, { expect: mode === "CANCEL" ? "Approved" : "Active" });
  if (mode !== "CANCEL") {
    verifyRotationProof(request);
    if (intent.type === "ROTATE_MEMBER" && intent.role === "CLIENT" && args.initiatedHere && !args.initiatedHere(intent.rotationId))
      deny("ROTATION_NOT_REQUESTED_HERE", "esta troca de carteira não foi pedida neste app");
  }
  if (mode === "APPROVE_AND_EXECUTE" && intent.kind !== "OPERATION") deny("BAD_MODE", "só operações executam junto com a aprovação");

  const ms = new PublicKey(intent.multisig);
  const index = BigInt(intent.transactionIndex);
  const memo = approvalMemo(intent.intentHash, review.transactionHash);
  const instructions =
    mode === "CANCEL"
      ? [cancelIx(ms, index, wallet, memo)]
      : mode === "APPROVE"
        ? [approveIx(ms, index, wallet, memo)]
        : [approveIx(ms, index, wallet, memo), (await executeVaultIx(chain, ms, index, wallet)).instruction];
  const message = new TransactionMessage({
    payerKey: new PublicKey(request.feePayer),
    recentBlockhash: request.recentBlockhash,
    instructions,
  }).compileToV0Message();
  return { transaction: new VersionedTransaction(message), review };
}

/** Para testes e para o signer local: assina a transação como a carteira faria. */
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

export type Inspection =
  | ({ ok: true } & Review)
  | { ok: false; code: string; message: string; view: VaultView | ConfigView | null; diffs: string[] };

/** Igual a reviewOnChain, mas devolve o motivo (e o que a chain tem) em vez de lançar — para a tela de bloqueio. */
export async function inspectOnChain(chain: Chain, request: ApprovalRequest, me: PublicKey, now: number, opts: { initiatedHere?: (rotationId: string) => boolean } = {}): Promise<Inspection> {
  const intent = request.intent;
  try {
    const r = await reviewOnChain(chain, intent, me, now, { expect: request.mode === "CANCEL" ? "Approved" : "Active" });
    if (request.mode !== "CANCEL") {
      verifyRotationProof(request);
      if (intent.type === "ROTATE_MEMBER" && intent.role === "CLIENT" && opts.initiatedHere && !opts.initiatedHere(intent.rotationId))
        deny("ROTATION_NOT_REQUESTED_HERE", "esta troca de carteira não foi pedida neste app");
    }
    return { ok: true, ...r };
  } catch (e) {
    const code = (e as { code?: string }).code ?? "ERROR";
    let view: VaultView | ConfigView | null = null;
    let diffs: string[] = [];
    try {
      const ms = new PublicKey(intent.multisig);
      const tx = await readTransaction(chain, ms, BigInt(intent.transactionIndex));
      if (tx?.kind === "VAULT") view = viewVaultTransaction(tx, vaultPda(ms, 0));
      if (view) diffs = compareIntent(intent, view);
    } catch {
      /* sem visão da chain */
    }
    return { ok: false, code, message: (e as Error).message, view, diffs };
  }
}
