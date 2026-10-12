import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { kvGet, kvSet } from "./storage";
import { tr } from "./i18n";

/**
 * Carteira de teste (só localnet): faz o papel de uma carteira de verdade para testar sem
 * extensão e sem SOL de verdade. A chave é Ed25519 do WebCrypto, não
 * exportável, no IndexedDB. Antes de assinar, pede confirmação numa janela
 * parecida com a de uma carteira.
 */
export type DevConfirm = (req: { walletName: string; kind: "message" | "transaction" | "biometric"; text: string }) => Promise<boolean>;

const ICON =
  "data:image/svg+xml," +
  encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='9' fill='#1B1F26'/><path d='M9 12h14v10a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2z' fill='none' stroke='#9BA3AF' stroke-width='2'/><path d='M12 12V9a4 4 0 0 1 8 0v3' fill='none' stroke='#9BA3AF' stroke-width='2'/></svg>`);

async function key(name: string): Promise<{ privateKey: CryptoKey; publicKey: Uint8Array }> {
  const stored = await kvGet<{ privateKey: CryptoKey; publicKey: Uint8Array }>(`devwallet:${name}`);
  if (stored) return stored;
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
  const k = { privateKey: pair.privateKey, publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)) };
  await kvSet(`devwallet:${name}`, k);
  return k;
}

export function makeDevWallet(name: string, confirm: () => DevConfirm) {
  let account: { address: string; publicKey: Uint8Array; chains: string[]; features: string[] } | null = null;
  const sign = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, (await key(name)).privateKey, bytes as BufferSource));
  const wallet = {
    version: "1.0.0",
    name,
    icon: ICON,
    chains: ["solana:localnet"],
    get accounts() {
      return account ? [account] : [];
    },
    features: {
      "standard:connect": {
        version: "1.0.0",
        connect: async () => {
          const k = await key(name);
          account = { address: new PublicKey(k.publicKey).toBase58(), publicKey: k.publicKey, chains: ["solana:localnet"], features: [] };
          return { accounts: [account] };
        },
      },
      "standard:disconnect": { version: "1.0.0", disconnect: async () => void (account = null) },
      "standard:events": { version: "1.0.0", on: () => () => {} },
      "solana:signMessage": {
        version: "1.0.0",
        signMessage: async ({ message }: { message: Uint8Array }) => {
          const ok = await confirm()({ walletName: name, kind: "message", text: new TextDecoder().decode(message) });
          if (!ok) throw new Error("assinatura recusada na carteira");
          return [{ signedMessage: message, signature: await sign(message) }];
        },
      },
      "solana:signTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: [0],
        signTransaction: async ({ transaction }: { transaction: Uint8Array }) => {
          const tx = VersionedTransaction.deserialize(transaction);
          const me = new PublicKey((await key(name)).publicKey);
          const n = tx.message.staticAccountKeys.length;
          const payer = tx.message.staticAccountKeys[0]!.equals(me) ? tr("Taxa paga por esta carteira", "Fee paid by this wallet") : tr("Taxa paga por outra conta", "Fee paid by another account");
          const ok = await confirm()({
            walletName: name,
            kind: "transaction",
            text: tr(
              `Assinar transação (${tx.message.compiledInstructions.length} instrução(ões), ${n} contas). ${payer} (${tx.message.header.numRequiredSignatures} assinatura(s) × 0,000005 SOL).`,
              `Sign transaction (${tx.message.compiledInstructions.length} instruction(s), ${n} accounts). ${payer} (${tx.message.header.numRequiredSignatures} signature(s) × 0.000005 SOL).`,
            ),
          });
          if (!ok) throw new Error("assinatura recusada na carteira");
          tx.addSignature(me, await sign(tx.message.serialize()));
          return [{ signedTransaction: tx.serialize() }];
        },
      },
    },
  };
  return wallet;
}
