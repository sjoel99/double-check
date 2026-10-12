/**
 * Idioma do webapp: português ou inglês, pela primeira língua do navegador.
 * `?lang=pt|en` na URL força e fica guardado neste navegador.
 * Os textos que a carteira assina e os e-mails continuam em português: o serviço confere o texto exato.
 */
export type Lang = "pt" | "en";

function detect(): Lang {
  try {
    const q = new URLSearchParams(location.search).get("lang");
    if (q === "pt" || q === "en") {
      localStorage.setItem("dk-lang", q);
      return q;
    }
    const saved = localStorage.getItem("dk-lang");
    if (saved === "pt" || saved === "en") return saved;
  } catch {
    /* sem localStorage: segue pelo navegador */
  }
  const first = (navigator.languages?.[0] ?? navigator.language ?? "").toLowerCase();
  return first.startsWith("pt") ? "pt" : "en";
}

export const lang: Lang = detect();
export const locale = lang === "pt" ? "pt-BR" : "en-US";
if (typeof document !== "undefined") document.documentElement.lang = locale;

/** O mesmo texto nas duas línguas: `tr("Enviar", "Send")`. */
export const tr = (pt: string, en: string): string => (lang === "pt" ? pt : en);

/** Data e hora curtas no idioma do app. */
export const fmtWhen = (unixSeconds: number, timeStyle: "short" | "medium" = "short") =>
  new Date(unixSeconds * 1000).toLocaleString(locale, { dateStyle: "short", timeStyle });
