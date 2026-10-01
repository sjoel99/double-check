import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { type ApprovalStatement, deny, PossessionStatementSchema, type TransactionIntent, verifyIntentHash } from "@duplachave/shared";
import { randomHex, type Signed, type Signer, signStatement, verifyStatement } from "@duplachave/crypto";
import type { Chain } from "@duplachave/solana";
import {
  approvalMemo,
  approveIx,
  cancelIx,
  compareIntent,
  readMultisig,
  readProposal,
  readTransaction,
  vaultPda,
  viewConfigTransaction,
  viewVaultTransaction,
  type ConfigView,
  type VaultView,
} from "@duplachave/squads";

/** O que o backend entrega ao app. Nada disso é confiável até `reviewOnChain`. */
export type ApprovalRequest = {
  intent: TransactionIntent;
  riskFlags: string[];
  feePayer: string;
  recentBlockhash: string;
  deviceName?: string | null;
  /** Rotação: a prova de posse assinada pela chave nova. O app confere a assinatura. */
  possession?: Signed<unknown> | null;
};

export type ClientDecisionPayload = {
  statement: Signed<ApprovalStatement>;
  /** Transação proposal_approve assinada só pelo cliente (base64). Ausente em REJECT. */
  approveTransaction?: string;
};

export const MAX_INTENT_TTL = 60 * 60;
const STATEMENT_TTL = 5 * 60;

export type Review = { view: VaultView | ConfigView; transactionHash: string };

export type ReviewOptions = {
  /** "Approved" para cancelar uma aprovada que não executou. Padrão: "Active". */
  expect?: "Active" | "Approved";
};

/**
 * Conferência do lado do app, contra uma RPC escolhida pelo app (não pelo backend):
 * a intenção exibida tem que ser exatamente o que está na chain no índice dela.
 */
export async function reviewOnChain(chain: Chain, intent: TransactionIntent, me: PublicKey, now: number, opts: ReviewOptions = {}): Promise<Review> {
  const expect = opts.expect ?? "Active";
  if (!verifyIntentHash(intent)) deny("INTENT_HASH_INVALID", "hash da intenção não confere com os campos");
  if (intent.cluster !== chain.cluster) deny("WRONG_CLUSTER", `intenção para ${intent.cluster}, app em ${chain.cluster}`);
  if (expect === "Active" && now > intent.expiresAt) deny("INTENT_EXPIRED", "intenção expirada");
  if (intent.expiresAt - intent.createdAt > MAX_INTENT_TTL) deny("INTENT_TTL_TOO_LONG", "validade acima do máximo");

  const ms = new PublicKey(intent.multisig);
  const index = BigInt(intent.transactionIndex);
  const state = await readMultisig(chain, ms);
  const meMember = state.members.find((m) => m.key === me.toBase58());
  if (!meMember?.vote) deny("NOT_A_VOTER", "esta chave não é votante desta multisig");

  const tx = await readTransaction(chain, ms, index);
  if (!tx) deny("TX_NOT_FOUND", "transação não existe na chain");
  const proposal = await readProposal(chain, ms, index);
  if (proposal?.status !== expect) deny("PROPOSAL_NOT_ACTIVE", `proposta em ${proposal?.status ?? "inexistente"}`);
  if (expect === "Active" && index <= state.staleTransactionIndex) deny("PROPOSAL_STALE", "proposta anterior à última mudança de configuração");

  let view: VaultView | ConfigView;
  if (tx.kind === "VAULT") {
    view = viewVaultTransaction(tx, vaultPda(ms, 0));
  } else {
    const other = state.members.find((m) => m.vote && m.key !== me.toBase58());
    if (!other) deny("BAD_STATE", "sem segundo votante");
    view = viewConfigTransaction(tx, state, {
      client: me.toBase58(),
      server: other.key,
      executor: "",
      proposer: "",
    });
  }
  const diffs = compareIntent(intent, view);
  if (diffs.length) deny("INTENT_MISMATCH", `a transação na chain é diferente da exibida: ${diffs.join("; ")}`);
  return { view, transactionHash: tx.hash };
}

/**
 * Rotação: confere a prova de posse (assinada pela chave nova) que o backend
 * diz ter verificado. O app não aceita "posse provada" só porque o servidor disse.
 */
export function verifyRotationProof(request: ApprovalRequest): void {
  const intent = request.intent;
  if (intent.type !== "ROTATE_MEMBER") return;
  const signed = request.possession as Signed<object> | null | undefined;
  if (!signed) deny("ROTATION_PROOF_MISSING", "rotação sem prova de posse da chave nova");
  const st = PossessionStatementSchema.safeParse(signed.statement);
  if (!st.success) deny("ROTATION_PROOF_INVALID", st.error.message);
  const p = st.data;
  const op = intent.role === "CLIENT" ? "ROTATE_CLIENT_KEY" : "ROTATE_SERVER_KEY";
  if (p.newPublicKey !== intent.newKey || p.rotationId !== intent.rotationId || p.multisig !== intent.multisig || p.cluster !== intent.cluster || p.operation !== op)
    deny("ROTATION_PROOF_INVALID", "prova de posse não corresponde a esta rotação");
  if (!verifyStatement(signed, new PublicKey(p.newPublicKey))) deny("ROTATION_PROOF_INVALID", "assinatura da prova não é da chave nova");
}

/** Monta e assina a decisão do cliente. Chamar só depois da autenticação local (biometria/PIN). */
export async function signClientDecision(args: {
  chain: Chain;
  request: ApprovalRequest;
  signer: Signer;
  decision: "APPROVE" | "REJECT" | "CANCEL";
  now: number;
  /** Troca da chave do cliente só vale se foi pedida neste aparelho. */
  initiatedHere?: (rotationId: string) => boolean;
}): Promise<ClientDecisionPayload> {
  const { chain, request, signer, decision, now } = args;
  const me = await signer.publicKey();
  const { intent } = request;
  const review = await reviewOnChain(chain, intent, me, now, { expect: decision === "CANCEL" ? "Approved" : "Active" });
  if (decision === "APPROVE") {
    verifyRotationProof(request);
    if (intent.type === "ROTATE_MEMBER" && intent.role === "CLIENT" && args.initiatedHere && !args.initiatedHere(intent.rotationId))
      deny("ROTATION_NOT_REQUESTED_HERE", "esta troca de chave não foi pedida neste aparelho");
  }

  const statement: ApprovalStatement = {
    domain: "duplachave/approval/v1",
    decision,
    cluster: intent.cluster,
    multisig: intent.multisig,
    transactionIndex: intent.transactionIndex,
    transactionKind: review.view.kind,
    intentId: intent.id,
    intentHash: intent.intentHash,
    transactionHash: review.transactionHash,
    signer: me.toBase58(),
    nonce: randomHex(16),
    createdAt: now,
    expiresAt: decision === "CANCEL" ? now + STATEMENT_TTL : Math.min(now + STATEMENT_TTL, intent.expiresAt),
  };
  const signed = await signStatement(signer, statement);
  if (decision === "REJECT") return { statement: signed };

  // A transação de voto é montada aqui, não recebida pronta: o app nunca
  // assina bytes que não montou.
  const build = decision === "CANCEL" ? cancelIx : approveIx;
  const ix = build(new PublicKey(intent.multisig), BigInt(intent.transactionIndex), me, approvalMemo(intent.intentHash, review.transactionHash));
  const message = new TransactionMessage({
    payerKey: new PublicKey(request.feePayer),
    recentBlockhash: request.recentBlockhash,
    instructions: [ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.addSignature(me, await signer.sign(message.serialize()));
  return { statement: signed, approveTransaction: Buffer.from(tx.serialize()).toString("base64") };
}

/** Prova de posse: a chave nova assina o desafio do backend. */
export async function signPossession(args: {
  signer: Signer;
  operation: "ENROLL_CLIENT_KEY" | "ROTATE_CLIENT_KEY" | "ROTATE_SERVER_KEY";
  cluster: TransactionIntent["cluster"];
  multisig: string;
  rotationId: string;
  challenge: string;
  now: number;
  ttl?: number;
}) {
  return signStatement(args.signer, {
    domain: "duplachave/possession/v1" as const,
    operation: args.operation,
    cluster: args.cluster,
    multisig: args.multisig,
    rotationId: args.rotationId,
    newPublicKey: (await args.signer.publicKey()).toBase58(),
    challenge: args.challenge,
    nonce: randomHex(16),
    createdAt: args.now,
    expiresAt: args.now + (args.ttl ?? 300),
  });
}

export type Inspection =
  | { ok: true; view: VaultView | ConfigView; transactionHash: string }
  | { ok: false; code: string; message: string; view: VaultView | ConfigView | null; diffs: string[] };

/** Igual a reviewOnChain, mas devolve o motivo (e o que a chain tem) em vez de lançar — para a tela de bloqueio. */
export async function inspectOnChain(chain: Chain, request: ApprovalRequest, me: PublicKey, now: number, opts: { initiatedHere?: (rotationId: string) => boolean } = {}): Promise<Inspection> {
  const intent = request.intent;
  try {
    const r = await reviewOnChain(chain, intent, me, now);
    verifyRotationProof(request);
    if (intent.type === "ROTATE_MEMBER" && intent.role === "CLIENT" && opts.initiatedHere && !opts.initiatedHere(intent.rotationId))
      deny("ROTATION_NOT_REQUESTED_HERE", "esta troca de chave não foi pedida neste aparelho");
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
