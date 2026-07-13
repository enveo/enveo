/**
 * Locale registry: ONE line per language. Adding a language = one file in ./locales + one line here.
 *
 * Deliberately free of runtime imports (only a TYPE import from ./index): lib/contexts.tsx reads
 * detectLang() from here and ./index reads useSettings() from contexts — putting the detection in
 * ./index would close that cycle.
 */
import type { Dict } from "./index";

/** Every language the UI can render. `en` is the SOURCE — it has no dictionary. */
export type Lang = "en" | "pl" | "de" | "es" | "fr" | "it" | "nl" | "pt-BR" | "cs" | "sv";

/** `endonym` is the language's name in itself (shown in Settings); `community` marks translations
 *  we did not author natively (labelled in the UI). Locale chunks are lazy (`import()`). */
export const LOCALES: { code: Lang; endonym: string; community: boolean; load: () => Promise<Dict> }[] = [
  { code: "en", endonym: "English", community: false, load: async () => ({}) },
  { code: "pl", endonym: "Polski", community: false, load: () => import("./locales/pl").then((m) => m.pl) },
];

/** UI language outside React (hook-free modules: backups, API error codes) — same store as contexts.tsx. */
export function uiLang(): Lang {
  try {
    const raw = localStorage.getItem("enveo.settings");
    const l = raw ? (JSON.parse(raw) as { lang?: string }).lang : undefined;
    if (l && LOCALES.some((x) => x.code === l)) return l as Lang;
  } catch {
    // corrupted settings → detect from the browser
  }
  return detectLang();
}

/** Best match for the browser's languages; anything unknown falls back to the English source. */
export function detectLang(): Lang {
  const nav = typeof navigator !== "undefined" ? (navigator.languages ?? [navigator.language]) : [];
  for (const tag of nav) {
    const base = (tag || "").toLowerCase().split("-")[0];
    const hit = LOCALES.find((l) => l.code.toLowerCase().split("-")[0] === base);
    if (hit) return hit.code;
  }
  return "en";
}
