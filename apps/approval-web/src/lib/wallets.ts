import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { ensureActivation } from "./activation";
import { trace } from "./trace";

/** Nome exibido: o Mobile Wallet Adapter abre o app de carteira do celular (Phantom, Solflare…). */
export const walletLabel = (name: string) => (name === "Mobile Wallet Adapter" ? "Carteira do celular" : name);

/**
 * Carteiras pelo Wallet Standard (Phantom, Backpack, Solflare e outras se
 * anunciam assim). Sem pacote de adapter: cada dependência a menos é uma a
 * menos na cadeia de suprimentos de um app que move fundos.
 */
type WalletAccount = { address: string; publicKey: Uint8Array };
export type StandardWallet = {
  name: string;
  icon: string;
  chains: readonly string[];
  accounts: readonly WalletAccount[];
  features: Record<string, any>;
};

const REQUIRED = ["standard:connect", "solana:signTransaction", "solana:signMessage"];

export function isUsable(w: StandardWallet) {
  return REQUIRED.every((f) => f in w.features) && w.chains.some((c) => c.startsWith("solana:"));
}

/** Descobre as carteiras instaladas; chama onChange a cada registro. */
export function discoverWallets(onChange: (wallets: StandardWallet[]) => void): () => void {
  const list = new Set<StandardWallet>();
  const api = {
    register: (...ws: StandardWallet[]) => {
      ws.forEach((w) => list.add(w));
      onChange([...list].filter(isUsable));
      return () => {
        ws.forEach((w) => list.delete(w));
        onChange([...list].filter(isUsable));
      };
    },
  };
  const onRegister = (e: Event) => (e as CustomEvent).detail?.(api);
  window.addEventListener("wallet-standard:register-wallet", onRegister);
  try {
    window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
  } catch {
    /* sem carteiras */
  }
  return () => window.removeEventListener("wallet-standard:register-wallet", onRegister);
}

export function registerWallet(w: StandardWallet) {
  const cb = (api: { register: (w: StandardWallet) => void }) => api.register(w);
  window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: cb }));
}

const chainFor = (cluster: string) => (cluster === "devnet" ? "solana:devnet" : cluster === "mainnet-beta" ? "solana:mainnet" : undefined);

/** Carteira conectada: só o que o app precisa (chave pública, assinar texto, assinar transação). */
export class ConnectedWallet {
  private constructor(
    readonly wallet: StandardWallet,
    private account: WalletAccount,
    private readonly cluster: string,
  ) {}

  static async connect(wallet: StandardWallet, cluster: string): Promise<ConnectedWallet> {
    trace("carteira:connect:inicio", wallet.name);
    let out;
    try {
      out = await wallet.features["standard:connect"].connect();
    } catch (e) {
      trace("carteira:connect:erro", e);
      throw e;
    }
    trace("carteira:connect:ok", `${(out?.accounts ?? wallet.accounts).length} conta(s)`);
    const account = (out?.accounts ?? wallet.accounts)[0];
    if (!account) throw new Error(`${wallet.name} não devolveu nenhuma conta`);
    return new ConnectedWallet(wallet, account, cluster);
  }

  get name() {
    return walletLabel(this.wallet.name);
  }

  /** Abre outro app (Mobile Wallet Adapter): precisa de um toque recente. */
  private async gate(what: string) {
    if (this.wallet.name === "Mobile Wallet Adapter") await ensureActivation(what);
  }
  get icon() {
    return this.wallet.icon;
  }
  get publicKey(): string {
    return new PublicKey(this.account.publicKey).toBase58();
  }

  /** Atualiza a conta (o usuário trocou de conta dentro da Phantom, por exemplo). */
  refresh() {
    const a = this.wallet.accounts[0];
    if (a) this.account = a;
    return this.publicKey;
  }

  onChange(cb: () => void): () => void {
    const ev = this.wallet.features["standard:events"];
    if (!ev) return () => {};
    return ev.on("change", () => {
      this.refresh();
      cb();
    });
  }

  async signMessage(text: string): Promise<string> {
    await this.gate("Abrir a carteira para assinar o texto");
    trace("carteira:signMessage:inicio", `${this.wallet.name} ativacao=${(navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive}`);
    try {
      const [out] = await this.wallet.features["solana:signMessage"].signMessage({ account: this.account, message: new TextEncoder().encode(text) });
      trace("carteira:signMessage:ok", `${out?.signature?.length ?? "?"} bytes`);
      return bs58.encode(out.signature);
    } catch (e) {
      trace("carteira:signMessage:erro", e);
      throw e;
    }
  }

  /**
   * Assina sem enviar (mantém as assinaturas que o serviço já pôs). A carteira
   * é a pagadora; quem envia é o backend, depois de conferir os bytes.
   */
  async signTransaction(tx: VersionedTransaction): Promise<string> {
    await this.gate("Abrir a carteira para assinar a transação");
    const chain = chainFor(this.cluster);
    trace("carteira:signTransaction:inicio", this.wallet.name);
    try {
      const [out] = await this.wallet.features["solana:signTransaction"].signTransaction({ account: this.account, transaction: tx.serialize(), ...(chain ? { chain } : {}) });
      trace("carteira:signTransaction:ok");
      return Buffer.from(out.signedTransaction).toString("base64");
    } catch (e) {
      trace("carteira:signTransaction:erro", e);
      throw e;
    }
  }

  async disconnect() {
    await this.wallet.features["standard:disconnect"]?.disconnect?.().catch(() => {});
  }
}
