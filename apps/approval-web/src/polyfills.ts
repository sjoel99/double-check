import { Buffer } from "buffer";

// web3.js, beet e o SDK da Squads esperam Buffer global.
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;

// Algumas dependências (debug, readable-stream) consultam `process`.
const g = globalThis as unknown as { process?: { env: Record<string, string>; browser: boolean; version: string; nextTick: (fn: () => void) => void } };
g.process ??= { env: {}, browser: true, version: "", nextTick: (fn) => queueMicrotask(fn) };
