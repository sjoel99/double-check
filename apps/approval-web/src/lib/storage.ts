/**
 * Armazenamento local do app (IndexedDB). Só guarda sessão e, em localnet, as
 * chaves das carteiras de teste como CryptoKey não exportável. Nada vai para
 * localStorage.
 */
const DB = "duplachave";
const STORE = "kv";

let dbPromise: Promise<IDBDatabase> | null = null;

function idb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      for (const name of [...req.result.objectStoreNames]) req.result.deleteObjectStore(name);
      req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => {
        req.result.close();
        dbPromise = null;
      };
      resolve(req.result);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const r = fn(db.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export const kvGet = async <T>(key: string): Promise<T | null> => ((await tx("readonly", (s) => s.get(key))) as T | undefined) ?? null;
export const kvSet = async (key: string, value: unknown) => void (await tx("readwrite", (s) => s.put(value, key)));
export const kvDel = async (key: string) => void (await tx("readwrite", (s) => s.delete(key)));

export type Session = {
  token: string;
  accountId: string;
  walletName: string;
  publicKey: string;
  /** Trocas de carteira pedidas por esta sessão (o app só aprova estas). */
  myRotations: string[];
  /** Como esta sessão assina: carteira do celular (QR) ou extensão do navegador. */
  via?: "phone" | "extension";
};

export const loadSession = () => kvGet<Session>("session");
export const saveSession = (s: Session | null) => (s ? kvSet("session", s) : kvDel("session"));

export async function ed25519Supported(): Promise<boolean> {
  try {
    await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    return true;
  } catch {
    return false;
  }
}
