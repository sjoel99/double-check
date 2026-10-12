import { transact } from "@solana-mobile/mobile-wallet-adapter-protocol";
import { VersionedTransaction } from "@solana/web3.js";
import { trace } from "./trace";
import { tr } from "./i18n";
import { ensureActivation } from "./activation";

/**
 * Carteira do celular (Android) pelo Mobile Wallet Adapter, falando direto com
 * o protocolo. Cada operação é UMA sessão: autoriza e assina na mesma abertura
 * da carteira, sem token de reautorização.
 *
 * Por quê: com a biblioteca de Wallet Standard (@solana-mobile/wallet-standard-mobile),
 * a segunda abertura reautorizava com o token da conexão; quando a Phantom
 * recusava, a biblioteca engolia o erro e ficava esperando para sempre (a Phantom
 * abria "sem nada"). Aqui um erro vira erro.
 */
type MwaAccount = { address: string; publicKey: Uint8Array; chains: string[]; features: string[] };

const b64 = (u: Uint8Array) => {
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s);
};
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Acesso do Chrome ao próprio aparelho: o app conversa com a carteira por ws://localhost.
 * Desde o Chrome 145 isso é a permissão "loopback-network" ("Apps no dispositivo"),
 * separada de "local-network" (o antigo "local-network-access" virou apelido dela), e
 * desde o 147 ela também vale para WebSocket. Sem ela a carteira abre e nada conecta.
 */
async function ensureLocalNetwork() {
  const query = async (name: string): Promise<PermissionState | null> => {
    try {
      return (await navigator.permissions.query({ name: name as PermissionName })).state;
    } catch {
      return null; // nome não suportado neste Chrome
    }
  };
  const read = async () => (await query("loopback-network")) ?? (await query("local-network-access"));
  let state = await read();
  trace("mwa:permissao", `loopback=${await query("loopback-network")} local=${await query("local-network-access")}`);
  if (state === "prompt") {
    // Uma requisição ao localhost faz o Chrome perguntar; a resposta pode levar mais que o toque vale.
    await fetch("http://localhost", { mode: "no-cors" }).catch(() => {});
    state = await read();
    trace("mwa:permissao:depois", String(state));
    if (state !== "denied") await ensureActivation(tr("Abrir a carteira", "Open the wallet"));
  }
  if (state === "denied")
    throw new Error(
      tr(
        "O Chrome bloqueou a conversa com o app da carteira. Toque no ícone à esquerda do endereço → Permissões → \"Apps no dispositivo\" (ou \"Rede local\") → Permitir, e tente de novo.",
        "Chrome blocked the connection to the wallet app. Tap the icon left of the address → Permissions → \"Apps on device\" (or \"Local network\") → Allow, then try again.",
      ),
    );
}

export function makeMwaWallet(opts: { chain: string; identity: { name: string; uri: string; icon: string } }) {
  let account: MwaAccount | null = null;
  const toAccount = (addressB64: string): MwaAccount => ({ address: addressB64, publicKey: fromB64(addressB64), chains: [opts.chain], features: [] });

  /** Uma sessão: autoriza (a carteira mostra quem pede) e roda `fn` na mesma conexão. */
  const session = async <T>(what: string, fn: (wallet: any, acc: MwaAccount) => Promise<T>, expected?: Uint8Array): Promise<T> => {
    await ensureLocalNetwork();
    trace(`mwa:${what}:inicio`);
    try {
      const out = await transact(async (wallet) => {
        trace(`mwa:${what}:sessao`);
        const auth = await wallet.authorize({ identity: opts.identity, chain: opts.chain as `${string}:${string}` });
        trace(`mwa:${what}:autorizado`, `${auth.accounts.length} conta(s)`);
        const acc = toAccount(auth.accounts[0]!.address as string);
        const want = expected ?? account?.publicKey;
        if (want && b64(want) !== b64(acc.publicKey)) throw new Error(tr("A carteira está em outra conta. Troque para a conta certa e tente de novo.", "The wallet is on a different account. Switch to the right account and try again."));
        account = acc;
        return fn(wallet, acc);
      });
      trace(`mwa:${what}:ok`);
      return out;
    } catch (e) {
      trace(`mwa:${what}:erro`, e);
      if ((e as { code?: string })?.code === "ERROR_WALLET_NOT_FOUND")
        throw new Error(tr("Nenhum app de carteira Solana neste celular. Instale a Phantom ou a Solflare pela Play Store e tente de novo.", "No Solana wallet app on this phone. Install Phantom or Solflare from the Play Store and try again."));
      throw e;
    }
  };

  return {
    version: "1.0.0" as const,
    name: "Mobile Wallet Adapter",
    icon: "data:image/svg+xml," + encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='9' fill='#C8F169'/><rect x='10' y='6' width='12' height='20' rx='3' fill='none' stroke='#0B0D10' stroke-width='2'/><circle cx='16' cy='22' r='1.5' fill='#0B0D10'/></svg>`),
    chains: [opts.chain],
    get accounts() {
      return account ? [account] : [];
    },
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: async () => {
          await session("connect", async () => undefined);
          return { accounts: [account!] };
        },
      },
      "standard:disconnect": { version: "1.0.0", disconnect: async () => void (account = null) },
      "standard:events": { version: "1.0.0", on: () => () => {} },
      "solana:signMessage": {
        version: "1.0.0",
        signMessage: async ({ message, account: input }: { message: Uint8Array; account?: { publicKey: Uint8Array } }) =>
          session(
            "signMessage",
            async (wallet, acc) => {
              const r = await wallet.signMessages({ addresses: [acc.address], payloads: [b64(message)] });
              const signed = fromB64(r.signed_payloads[0]);
              return [{ signedMessage: message, signature: signed.slice(-64) }];
            },
            input?.publicKey,
          ),
      },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: [0],
        signTransaction: async ({ transaction, account: input }: { transaction: Uint8Array; account?: { publicKey: Uint8Array } }) =>
          session(
            "signTransaction",
            async (wallet) => {
              const r = await wallet.signTransactions({ payloads: [b64(transaction)] });
              const signed = fromB64(r.signed_payloads[0]);
              VersionedTransaction.deserialize(signed); // legível, senão erro aqui
              return [{ signedTransaction: signed }];
            },
            input?.publicKey,
          ),
      },
    },
  };
}
