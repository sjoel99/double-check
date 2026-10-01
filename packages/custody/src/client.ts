import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { type ApprovalStatement, deny, type TransactionIntent, verifyIntentHash } from "@duplachave/shared";
import { randomHex, type Signed, type Signer, signStatement } from "@duplachave/crypto";
import type { Chain } from "@duplachave/solana";
import {
  approvalMemo,
  approveIx,
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
};

export type ClientDecisionPayload = {
  statement: Signed<ApprovalStatement>;
  /** Transação proposal_approve assinada só pelo cliente (base64). Ausente em REJECT. */
  approveTransaction?: string;
};

export const MAX_INTENT_TTL = 60 * 60;
const STATEMENT_TTL = 5 * 60;

export type Review = { view: VaultView | ConfigView; transactionHash: string };

/**
 * Conferência do lado do app, contra uma RPC escolhida pelo app (não pelo backend):
 * a intenção exibida tem que ser exatamente o que está na chain no índice dela.
 */
export async function reviewOnChain(chain: Chain, intent: TransactionIntent, me: PublicKey, now: number): Promise<Review> {
  if (!verifyIntentHash(intent)) deny("INTENT_HASH_INVALID", "hash da intenção não confere com os campos");
  if (intent.cluster !== chain.cluster) deny("WRONG_CLUSTER", `intenção para ${intent.cluster}, app em ${chain.cluster}`);
  if (now > intent.expiresAt) deny("INTENT_EXPIRED", "intenção expirada");
  if (intent.expiresAt - intent.createdAt > MAX_INTENT_TTL) deny("INTENT_TTL_TOO_LONG", "validade acima do máximo");

  const ms = new PublicKey(intent.multisig);
  const index = BigInt(intent.transactionIndex);
  const state = await readMultisig(chain, ms);
  const meMember = state.members.find((m) => m.key === me.toBase58());
  if (!meMember?.vote) deny("NOT_A_VOTER", "esta chave não é votante desta multisig");

  const tx = await readTransaction(chain, ms, index);
  if (!tx) deny("TX_NOT_FOUND", "transação não existe na chain");
  const proposal = await readProposal(chain, ms, index);
  if (proposal?.status !== "Active") deny("PROPOSAL_NOT_ACTIVE", `proposta em ${proposal?.status ?? "inexistente"}`);
  if (index <= state.staleTransactionIndex) deny("PROPOSAL_STALE", "proposta anterior à última mudança de configuração");

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

/** Monta e assina a decisão do cliente. Chamar só depois da autenticação local (biometria/PIN). */
export async function signClientDecision(args: {
  chain: Chain;
  request: ApprovalRequest;
  signer: Signer;
  decision: "APPROVE" | "REJECT";
  now: number;
}): Promise<ClientDecisionPayload> {
  const { chain, request, signer, decision, now } = args;
  const me = await signer.publicKey();
  const { intent } = request;
  const review = await reviewOnChain(chain, intent, me, now);

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
    expiresAt: Math.min(now + STATEMENT_TTL, intent.expiresAt),
  };
  const signed = await signStatement(signer, statement);
  if (decision === "REJECT") return { statement: signed };

  // A transação de voto é montada aqui, não recebida pronta: o app nunca
  // assina bytes que não montou.
  const ix = approveIx(new PublicKey(intent.multisig), BigInt(intent.transactionIndex), me, approvalMemo(intent.intentHash, review.transactionHash));
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
