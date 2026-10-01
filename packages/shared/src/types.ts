import { z } from "zod";

export const CLUSTERS = ["localnet", "devnet", "mainnet-beta"] as const;
export type Cluster = (typeof CLUSTERS)[number];

/**
 * Papel de cada chave na multisig (2 de 3). Votam: CLIENT (Phantom), WEBAPP
 * (chave do webapp, destravada pela biometria) e SERVER (serviço). Só o
 * OPERATOR (serviço) cria e executa. EXECUTOR/PROPOSER: modelo anterior.
 */
export type MemberRole = "CLIENT" | "WEBAPP" | "SERVER" | "OPERATOR" | "EXECUTOR" | "PROPOSER";

const base58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "endereço base58 inválido");
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/, "inteiro decimal em string");
const hex32 = z.string().regex(/^[0-9a-f]{64}$/, "sha256 em hex");
const unixSeconds = z.number().int().nonnegative();

// ---------------------------------------------------------------------------
// Intenções. O hash cobre todos os campos, exceto o próprio intentHash.
// Rótulos legíveis ("Seu próprio Vault") NÃO entram: o app os calcula sozinho,
// para o backend não conseguir chamar um endereço de terceiro de "seu".
// ---------------------------------------------------------------------------

const intentCommon = {
  version: z.literal(1),
  id: z.string().uuid(),
  cluster: z.enum(CLUSTERS),
  multisig: base58,
  transactionIndex: decimal,
  createdAt: unixSeconds,
  expiresAt: unixSeconds,
};

export const TransferSolIntentSchema = z.object({
  ...intentCommon,
  kind: z.literal("OPERATION"),
  type: z.literal("TRANSFER_SOL"),
  vault: base58,
  vaultIndex: z.literal(0),
  amountLamports: decimal,
  destination: base58,
  programs: z.array(base58),
});

export const TransferTokenIntentSchema = z.object({
  ...intentCommon,
  kind: z.literal("OPERATION"),
  type: z.literal("TRANSFER_TOKEN"),
  vault: base58,
  vaultIndex: z.literal(0),
  mint: base58,
  decimals: z.number().int().min(0).max(18),
  amount: decimal,
  /** Dono do destino (a ATA é derivada dele). */
  destination: base58,
  programs: z.array(base58),
});

export const RotateMemberIntentSchema = z.object({
  ...intentCommon,
  kind: z.literal("CONFIG"),
  type: z.literal("ROTATE_MEMBER"),
  role: z.enum(["CLIENT", "WEBAPP", "SERVER"]),
  oldKey: base58,
  newKey: base58,
  rotationId: z.string().uuid(),
});

export const IntentSchema = z.discriminatedUnion("type", [
  TransferSolIntentSchema,
  TransferTokenIntentSchema,
  RotateMemberIntentSchema,
]);

export type TransferSolIntent = z.infer<typeof TransferSolIntentSchema>;
export type TransferTokenIntent = z.infer<typeof TransferTokenIntentSchema>;
export type RotateMemberIntent = z.infer<typeof RotateMemberIntentSchema>;
export type IntentBody = z.infer<typeof IntentSchema>;
export type TransactionIntent = IntentBody & { intentHash: string };

// ---------------------------------------------------------------------------
// Política
// ---------------------------------------------------------------------------

export type PolicyDecision = {
  allowed: boolean;
  reasons: string[];
  riskFlags: string[];
};
