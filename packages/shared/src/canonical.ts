import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * JSON canônico: chaves em ordem lexicográfica, sem espaços, sem `undefined`.
 * Números só inteiros seguros; valores monetários e índices on-chain vão como
 * string decimal, para não depender de como cada linguagem serializa float.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new Error(`número não canônico: ${value} (use string decimal)`);
      }
      return String(value);
    case "bigint":
      throw new Error("bigint não é canônico: converta para string decimal");
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
    }
    default:
      throw new Error(`tipo não canônico: ${typeof value}`);
  }
}

export function sha256Hex(data: Uint8Array | string): string {
  return bytesToHex(sha256(typeof data === "string" ? utf8ToBytes(data) : data));
}

export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalize(value));
}
