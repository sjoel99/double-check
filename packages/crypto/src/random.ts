import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";

export function randomHex(bytes: number): string {
  return bytesToHex(randomBytes(bytes));
}
