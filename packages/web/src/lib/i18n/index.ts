/**
 * Mini-i18n, message-as-key (gettext style): the ENGLISH SENTENCE IS THE KEY.
 * `t("Transactions")` renders "Transactions" in English and looks the sentence up in the
 * active locale otherwise. There is no English dictionary — a missing translation therefore
 * degrades to correct English, which is what makes partial community translations usable.
 *
 * PITFALL (the price of this pattern): editing an English string CHANGES ITS KEY, silently
 * orphaning every translation of it. `bun run i18n:extract` + i18n.test.ts report orphans;
 * read them before shipping a copy change.
 */
import { useSettings } from "../contexts";
import type { Message } from "./messages.generated";
import { detectLang, type Lang, LOCALES, uiLang } from "./registry";

export type { Lang, Message };
export { detectLang, LOCALES, uiLang };
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>>;
export type Dict = Partial<Record<Message, string | PluralForms>>;

/**
 * Marks a message the extractor would otherwise never see: one that is not written INSIDE a
 * `t()`/`tp()` call but stored first (const maps of codes → text, tab titles, a ternary passed
 * to `t()`). Identity at runtime; it exists so `bun run i18n:extract` finds the sentence and
 * the `Message` union keeps typing it.
 */
export const msg = <M extends Message>(m: M): M => m;

const loaded = new Map<Lang, Dict>();

/**
 * Loads a locale chunk once. English needs none (it is the source).
 *
 * NEVER REJECTS. A chunk fetch can fail (network blip on a first load, before the service worker
 * has precached anything; an SW-less context; a 404 on the hashed asset), and callers AWAIT this
 * before doing the thing that matters: main.tsx renders the app only once it settles, Appearance.tsx
 * switches the language only once it settles. A rejection there is a permanent blank page / a
 * language switch that never happens. Instead the dictionary stays absent, and the runtime renders
 * the English source — the same degradation as a missing translation. The failure is NOT cached, so
 * a later attempt (retry, language re-pick) can still succeed.
 */
export async function loadLocale(lang: Lang): Promise<void> {
  if (lang === "en" || loaded.has(lang)) return;
  const entry = LOCALES.find((l) => l.code === lang);
  if (!entry) return;
  try {
    loaded.set(lang, await entry.load());
  } catch {
    // chunk unavailable → English source (no entry cached: the next attempt retries)
  }
}

function fill(s: string, params?: Record<string, string | number>): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

export function translate(lang: Lang, message: Message, params?: Record<string, string | number>): string {
  const entry = lang === "en" ? undefined : loaded.get(lang)?.[message];
  const s = typeof entry === "string" ? entry : message; // missing (or plural-shaped) → English source
  return fill(s, params);
}

/**
 * Plurals via Intl.PluralRules. The ENGLISH source carries both forms in the message itself,
 * joined by " | " (`tp("{n} item | {n} items", n)`) — that keeps English correct with no English
 * dictionary and still gives every locale ONE stable key. A locale maps that key to an object of
 * the CLDR categories its language needs (i18n.test.ts checks both shapes).
 */
export function translatePlural(lang: Lang, message: Message, n: number, params?: Record<string, string | number>): string {
  const entry = lang === "en" ? undefined : loaded.get(lang)?.[message];
  if (entry && typeof entry === "object") {
    const cat = new Intl.PluralRules(lang).select(n);
    const form = entry[cat] ?? entry.other;
    if (form) return fill(form, { n, ...params });
  }
  const [one, other] = message.split(" | ");
  return fill(n === 1 ? one! : (other ?? one!), { n, ...params });
}

export function useT() {
  const { settings } = useSettings();
  const lang = settings.lang;
  return {
    lang,
    t: (message: Message, params?: Record<string, string | number>) => translate(lang, message, params),
    tp: (message: Message, n: number, params?: Record<string, string | number>) => translatePlural(lang, message, n, params),
  };
}
