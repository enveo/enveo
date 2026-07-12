/** Mini-i18n: a typed dictionary, {param} interpolation, per-locale plurals. No libraries. */
import { useSettings } from "./contexts";
import { en } from "./i18n.en";
import { pl, type TKey } from "./i18n.pl";

export type Lang = "pl" | "en";
export type { TKey };
const DICTS: Record<Lang, Record<string, string>> = { pl, en };

export function translate(lang: Lang, key: TKey, params?: Record<string, string | number>): string {
  let s = DICTS[lang][key] ?? DICTS.pl[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

const PLURAL_FORM: Record<Lang, (n: number) => string> = {
  pl: (n) => { const t = n % 10, h = n % 100; if (n === 1) return "one"; if (t >= 2 && t <= 4 && (h < 12 || h > 14)) return "few"; return "many"; },
  en: (n) => (n === 1 ? "one" : "other"),
};
/** Plurals: keys `<base>.one/.few/.many` (PL) and `<base>.one/.other` (EN); {n} available in the value. */
export function translatePlural(lang: Lang, base: string, n: number, params?: Record<string, string | number>): string {
  return translate(lang, `${base}.${PLURAL_FORM[lang](n)}` as TKey, { n, ...params });
}

export function useT() {
  const { settings } = useSettings();
  const lang = settings.lang;
  return {
    lang,
    t: (key: TKey, params?: Record<string, string | number>) => translate(lang, key, params),
    tp: (base: string, n: number, params?: Record<string, string | number>) => translatePlural(lang, base, n, params),
  };
}
