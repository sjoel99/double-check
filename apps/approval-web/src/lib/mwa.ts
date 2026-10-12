import { transact } from "@solana-mobile/mobile-wallet-adapter-protocol";
import { VersionedTransaction } from "@solana/web3.js";
import { trace } from "./trace";
import { tr } from "./i18n";

/**
 * Carteira do celular (Android) pelo Mobile Wallet Adapter, falando direto com
 * o protocolo. Cada operação é UMA sessão: autoriza e assina na mesma abertura
 * da Phantom, sem token de reautorização.
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

/** Pede ao Chrome a permissão de rede local (o app conversa com a carteira por ws://localhost). */
async function ensureLocalNetwork() {
  for (const name of ["local-network-access", "loopback-network"]) {
    try {
      const st = await navigator.permissions.query({ name: name as PermissionName });
      trace("mwa:permissao", `${name}=${st.state}`);
      if (st.state === "prompt") await fetch("http://localhost", { mode: "no-cors" }).catch(() => {});
      return;
    } catch {
      /* nome não suportado neste Chrome */
    }
  }
}

export function makeMwaWallet(opts: { chain: string; identity: { name: string; uri: string; icon: string } }) {
  let account: MwaAccount | null = null;
  const toAccount = (addressB64: string): MwaAccount => ({ address: addressB64, publicKey: fromB64(addressB64), chains: [opts.chain], features: [] });

  /** Uma sessão: autoriza (a Phantom mostra quem pede) e roda `fn` na mesma conexão. */
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
