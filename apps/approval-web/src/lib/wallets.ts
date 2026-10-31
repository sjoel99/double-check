import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { ensureActivation } from "./activation";
import { trace } from "./trace";
import { tr } from "./i18n";

/**
 * Nome da carteira guardado na sessão e mandado ao serviço: o Mobile Wallet
 * Adapter abre o app de carteira do celular (Phantom, Solflare…). Fica em
 * português nas duas línguas (o serviço também usa "Carteira do celular");
 * para mostrar, use walletDisplay.
 */
export const walletLabel = (name: string) => (name === "Mobile Wallet Adapter" ? "Carteira do celular" : name);

/** Nome da carteira para mostrar, no idioma do app. */
export const walletDisplay = (name: string) =>
  name === "Mobile Wallet Adapter" || name === "Carteira do celular"
    ? tr("Carteira do celular", "Phone wallet")
    : name.startsWith("Carteira de teste ")
      ? tr(name, `Test wallet ${name.slice("Carteira de teste ".length)}`)
      : name;

/**
 * A carteira da sessão no meio de uma frase ("na Backpack", "Sua carteira").
 * Quem entrou pela biometria não tem carteira conectada: vira "carteira".
 */
export const walletWord = (name: string | null | undefined) =>
  !name || name === "sem carteira" ? tr("carteira", "wallet") : name === "Carteira do celular" ? tr("carteira do celular", "phone wallet") : walletDisplay(name);

/**
 * Carteiras pelo Wallet Standard (Phantom, Backpack, Solflare e outras se
 * anunciam assim). Sem pacote de adapter: cada dependência a menos é uma a
 * menos na cadeia de suprimentos de um app que move fundos.
 */
type WalletAccount = { address: string; publicKey: Uint8Array };
/** Só as features do Wallet Standard que o app chama; as outras ficam `unknown`. */
type WalletFeatures = {
  "standard:connect": { connect(): Promise<{ accounts: readonly WalletAccount[] }> };
  "standard:events"?: { on(event: "change", cb: (props: unknown) => void): () => void };
  "standard:disconnect"?: { disconnect(): Promise<void> };
  "solana:signMessage": { signMessage(...inputs: { account: WalletAccount; message: Uint8Array }[]): Promise<readonly { signature: Uint8Array }[]> };
  /** Só a carteira do celular (MWA): conectar e assinar numa abertura só. */
  "duplachave:connectAndSignMessage"?: {
    connectAndSignMessage(input: { message: (publicKey: Uint8Array) => Promise<Uint8Array | null> }): Promise<{ account: WalletAccount; signature: Uint8Array | null }>;
  };
  "solana:signTransaction": { signTransaction(...inputs: { account: WalletAccount; transaction: Uint8Array; chain?: string }[]): Promise<readonly { signedTransaction: Uint8Array }[]> };
} & Record<string, unknown>;
export type StandardWallet = {
  name: string;
  icon: string;
  chains: readonly string[];
  accounts: readonly WalletAccount[];
  features: WalletFeatures;
};

const REQUIRED = ["standard:connect", "solana:signTransaction", "solana:signMessage"];

function isUsable(w: StandardWallet) {
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
    if (!account) throw new Error(tr(`${walletDisplay(wallet.name)} não devolveu nenhuma conta`, `${walletDisplay(wallet.name)} returned no account`));
    return new ConnectedWallet(wallet, account, cluster);
  }

  /**
   * Conecta e, se `message` devolver um texto para a chave pública conectada, assina-o.
   * Na carteira do celular isso é UMA abertura (autorizar → texto → assinar); nas
   * extensões, conectar e assinar são as duas janelas normais da própria carteira.
   * `message` devolve null para só conectar (carteira ainda sem conta).
   */
  static async connectAndSign(wallet: StandardWallet, cluster: string, message: (publicKey: string) => Promise<string | null>): Promise<{ wallet: ConnectedWallet; signature: string | null }> {
    const combo = wallet.features["duplachave:connectAndSignMessage"];
    if (combo) {
      trace("carteira:connectAndSign:inicio", wallet.name);
      const out = await combo.connectAndSignMessage({
        message: async (pk) => {
          const text = await message(new PublicKey(pk).toBase58());
          return text === null ? null : new TextEncoder().encode(text);
        },
      });
      trace("carteira:connectAndSign:ok", out.signature ? "assinado" : "só conectado");
      return { wallet: new ConnectedWallet(wallet, out.account, cluster), signature: out.signature ? bs58.encode(out.signature) : null };
    }
    const c = await ConnectedWallet.connect(wallet, cluster);
    const text = await message(c.publicKey);
    return { wallet: c, signature: text === null ? null : await c.signMessage(text) };
  }

  /**
   * Carteira já conhecida (a da conta), sem abrir a carteira para conectar: no
   * celular, a conexão e a assinatura acontecem na mesma abertura da carteira.
   */
  static forAddress(wallet: StandardWallet, publicKey: string, cluster: string): ConnectedWallet {
    return new ConnectedWallet(wallet, { address: publicKey, publicKey: new PublicKey(publicKey).toBytes() }, cluster);
  }

  get name() {
    return walletLabel(this.wallet.name);
  }

  /** Abre outro app (Mobile Wallet Adapter): precisa de um toque recente. */
  private async gate(what: string) {
    if (this.wallet.name === "Mobile Wallet Adapter") await ensureActivation(what);
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
    await this.gate(tr("Abrir a carteira para assinar o texto", "Open the wallet to sign the message"));
    trace("carteira:signMessage:inicio", `${this.wallet.name} ativacao=${(navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive}`);
    try {
      const [out] = await this.wallet.features["solana:signMessage"].signMessage({ account: this.account, message: new TextEncoder().encode(text) });
      trace("carteira:signMessage:ok", `${out?.signature?.length ?? "?"} bytes`);
      return bs58.encode(out!.signature);
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
    await this.gate(tr("Abrir a carteira para assinar a transação", "Open the wallet to sign the transaction"));
    const chain = chainFor(this.cluster);
    trace("carteira:signTransaction:inicio", this.wallet.name);
    try {
      const [out] = await this.wallet.features["solana:signTransaction"].signTransaction({ account: this.account, transaction: tx.serialize(), ...(chain ? { chain } : {}) });
      trace("carteira:signTransaction:ok");
      return Buffer.from(out!.signedTransaction).toString("base64");
    } catch (e) {
      trace("carteira:signTransaction:erro", e);
      throw e;
    }
  }

  async disconnect() {
    await this.wallet.features["standard:disconnect"]?.disconnect?.().catch(() => {});
  }
}
