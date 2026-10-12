import type { TransactionIntent } from "@duplachave/shared";
import { KNOWN_PROGRAM_NAMES } from "@duplachave/solana";

export type DisplayRow = { label: string; value: string; tone?: "normal" | "warning" | "danger" };
export type Display = { kind: "OPERATION" | "SECURITY"; title: string; subtitle: string; rows: DisplayRow[]; warnings: string[] };

const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;

export function formatUnits(amount: string, decimals: number): string {
  const neg = amount.startsWith("-");
  const digits = (neg ? amount.slice(1) : amount).padStart(decimals + 1, "0");
  const int = digits.slice(0, digits.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const frac = decimals ? digits.slice(digits.length - decimals).replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${int}${frac ? `,${frac}` : ""}`;
}

const RISK_TEXT: Record<string, string> = {
  EXTERNAL_DESTINATION: "Destino fora da sua lista de endereços",
  POSSIBLE_FULL_BALANCE: "Envia quase todo o saldo do Vault",
  SECURITY_CHANGE: "Muda quem pode aprovar transações",
  CLIENT_KEY_ROTATION: "A chave antiga perde acesso após a conclusão",
  SERVER_KEY_ROTATION: "Se você não reconhece esta solicitação, REJEITE",
};

/**
 * Texto da tela de aprovação. Os rótulos ("Seu próprio Vault") são calculados
 * aqui, a partir da intenção já conferida com a chain — nunca vêm do backend.
 */
export function renderIntent(
  intent: TransactionIntent,
  opts: { riskFlags?: string[]; tokenSymbol?: (mint: string) => string | undefined; deviceName?: string | null; locale?: string } = {},
): Display {
  const flags = opts.riskFlags ?? [];
  const warnings = flags.map((f) => RISK_TEXT[f] ?? f);
  const when = new Date(intent.createdAt * 1000).toLocaleString(opts.locale ?? "pt-BR", { dateStyle: "short", timeStyle: "short" });
  if (intent.kind === "OPERATION") {
    const dest = intent.destination === intent.vault ? "Seu próprio Vault" : short(intent.destination);
    const programs = intent.programs.map((p) => KNOWN_PROGRAM_NAMES[p] ?? short(p));
    const amount =
      intent.type === "TRANSFER_SOL"
        ? `${formatUnits(intent.amountLamports, 9)} SOL`
        : `${formatUnits(intent.amount, intent.decimals)} ${opts.tokenSymbol?.(intent.mint) ?? short(intent.mint)}`;
    return {
      kind: "OPERATION",
      title: "Confirmar transação",
      subtitle: "Transferência",
      rows: [
        { label: "Enviar", value: amount },
        { label: "Destino", value: dest, tone: flags.includes("EXTERNAL_DESTINATION") ? "warning" : "normal" },
        { label: "Endereço completo", value: intent.destination },
        { label: "Protocolos", value: programs.join(", ") },
        { label: "Solicitado", value: when },
      ],
      warnings,
    };
  }
  const isClient = intent.role === "CLIENT";
  return {
    kind: "SECURITY",
    title: "Alteração de segurança",
    subtitle: isClient ? "Substituir chave de aprovação?" : "O serviço está solicitando uma atualização da chave de segurança.",
    rows: [
      { label: "Chave atual", value: short(intent.oldKey) },
      { label: "Nova chave", value: short(intent.newKey), tone: "warning" },
      ...(opts.deviceName ? [{ label: "Dispositivo", value: opts.deviceName }] : []),
      { label: "Solicitado", value: when },
    ],
    warnings: [isClient ? "A chave antiga perderá acesso após a conclusão." : "Se você não reconhece esta solicitação, REJEITE.", ...warnings.filter((w) => !w.includes("REJEITE") && !w.includes("chave antiga"))],
  };
}

/**
 * Rótulo do QR do Solana Pay. A Phantom mostra o rótulo (do GET), não a
 * mensagem do POST — então o resumo do que vai ser assinado vai aqui.
 */
export function qrLabel(intent: TransactionIntent): string {
  if (intent.type === "TRANSFER_SOL") return `Double Check · Enviar ${formatUnits(intent.amountLamports, 9)} SOL para ${intent.destination === intent.vault ? "o seu Vault" : short(intent.destination)}`;
  if (intent.type === "ROTATE_MEMBER")
    return intent.role === "CLIENT" ? `Double Check · Trocar a carteira da conta por ${short(intent.newKey)}` : "Double Check · Nova chave do serviço (recuse se não pediu)";
  return "Double Check · Confirmar transação";
}
