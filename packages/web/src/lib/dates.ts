import { LOCALE_OF } from "./format";
import { translate, translatePlural, type Lang, type Message } from "./i18n";

export const todayISO = (): string => new Date().toISOString().slice(0, 10);
export const currentMonth = (): string => new Date().toISOString().slice(0, 7);

/** Month label per locale, e.g. "Lipiec 2026" / "July 2026". */
export function monthLabel(month: string, lang: Lang): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const s = new Intl.DateTimeFormat(LOCALE_OF[lang], { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Month names per locale (for date pickers). */
export function monthNames(lang: Lang): string[] {
  const f = new Intl.DateTimeFormat(LOCALE_OF[lang], { month: "long", timeZone: "UTC" });
  return Array.from({ length: 12 }, (_, i) => f.format(new Date(Date.UTC(2020, i, 1))));
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const idx = (y * 12 + (m - 1) + delta);
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

export function shiftDay(iso: string, delta: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

/** Short date per locale, e.g. "14 lip" / "Jul 14" (withYear → with the year). */
export function shortDate(iso: string, lang: Lang, withYear = false): string {
  return new Intl.DateTimeFormat(LOCALE_OF[lang], {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00Z`));
}

/** Full date per locale, e.g. "poniedziałek, 7 lipca 2026" / "Monday, July 7, 2026". */
export function formatDateLong(iso: string, lang: Lang): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(LOCALE_OF[lang], { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** Relative time of the last synchronization ("just now", "5 min ago", a date). */
export function relSync(iso: string | null, lang: Lang): string {
  if (!iso) return translate(lang, "not yet");
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return translate(lang, "unknown");
  const diff = Date.now() - t;
  if (diff < 45_000) return translate(lang, "just now");
  const min = Math.floor(diff / 60_000);
  if (min < 60) return translatePlural(lang, "{n} minute ago | {n} minutes ago", min);
  const hr = Math.floor(min / 60);
  if (hr < 24) return translatePlural(lang, "{n} hour ago | {n} hours ago", hr);
  const days = Math.floor(hr / 24);
  if (days < 7) return translatePlural(lang, "{n} day ago | {n} days ago", days);
  return new Date(iso).toLocaleDateString(LOCALE_OF[lang], { dateStyle: "short" });
}

/** Date group heading on the transaction list: "today" / "yesterday" / a date. */
export function dayHeading(iso: string, lang: Lang, t: (key: Message) => string): string {
  const today = todayISO();
  if (iso === today) return t("today");
  if (iso === shiftDay(today, -1)) return t("yesterday");
  return formatDateLong(iso, lang);
}
