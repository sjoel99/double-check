/**
 * No Chrome do Android, abrir o app da carteira (Mobile Wallet Adapter) ou a
 * biometria só é permitido logo depois de um toque do usuário. Se entre o
 * toque e a chamada houve espera (servidor, chain), a permissão expira e nada
 * abre. Aqui: se o toque não vale mais, o app mostra um botão e espera o toque.
 */
import { trace } from "./trace";

let gate: ((label: string) => Promise<void>) | null = null;

export function setActivationGate(g: typeof gate) {
  gate = g;
}

export const isMobile = () => /Android|iPhone|iPad/i.test(navigator.userAgent);

export async function ensureActivation(label: string) {
  const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  trace("toque:checar", `${label} ativo=${ua?.isActive}`);
  if (ua?.isActive) return;
  if (gate) await gate(label);
  trace("toque:ok", label);
}
