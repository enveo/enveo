import type { ExploreFilter } from "@enveo/shared";
import { currentMonth, shiftMonth } from "../../lib/dates";
import { type Message, msg } from "../../lib/i18n";
import type { SpendingView } from "./spendingPath";

export { decodePath, defaultSpendingView, encodePath, type SpendingView } from "./spendingPath";

export function monthStart(month: string): string {
  return `${month}-01`;
}

export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

export type PeriodPreset = "month" | "3m" | "6m" | "12m" | "year";

export const PRESETS: ReadonlyArray<{ id: PeriodPreset; label: Message }> = [
  { id: "month", label: msg("This month") },
  { id: "3m", label: msg("3 mo") },
  { id: "6m", label: msg("6 mo") },
  { id: "12m", label: msg("12 mo") },
  { id: "year", label: msg("This year") },
];

export function presetRange(p: PeriodPreset, thisMonth: string): { from: string; to: string } {
  const back = { month: 0, "3m": 2, "6m": 5, "12m": 11, year: +thisMonth.slice(5) - 1 }[p];
  return { from: monthStart(shiftMonth(thisMonth, -back)), to: monthEnd(thisMonth) };
}

export function presetOf(v: Pick<SpendingView, "from" | "to" | "custom">, thisMonth: string): PeriodPreset | null {
  if (v.custom) return null;
  return (
    PRESETS.find((p) => {
      const r = presetRange(p.id, thisMonth);
      return r.from === v.from && r.to === v.to;
    })?.id ?? null
  );
}

/** The calendar month the range covers exactly, if it does. */
export function singleMonthOf(v: Pick<SpendingView, "from" | "to" | "custom">): string | null {
  const m = v.from.slice(0, 7);
  return !v.custom && v.from === monthStart(m) && v.to === monthEnd(m) ? m : null;
}

export function lastMonths(thisMonth: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => shiftMonth(thisMonth, i - n + 1));
}

export const spansMonths = (v: Pick<SpendingView, "from" | "to">): boolean => v.from.slice(0, 7) !== v.to.slice(0, 7);

/** The view with its period filled in: an empty one is the default twelve months. */
export const withPeriod = (v: SpendingView): SpendingView => (v.from ? v : { ...v, ...presetRange("12m", currentMonth()) });

export const filterOf = (v: SpendingView): ExploreFilter => ({ from: v.from, to: v.to, accounts: v.accounts, path: v.path });
