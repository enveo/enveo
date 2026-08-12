/**
 * Pure presentation-state helpers for the redesign (spec §3 — encoding rules).
 * No I/O, no React: the line under an envelope ALWAYS means "spent of assigned",
 * the goal ring is computed separately via shared goalProgress.
 */

export type SpendMeter = { fill: number; state: "ok" | "warn" | "over"; total: number };

/** Spending meter for an envelope row; null when the row has no month pot to measure. */
export function spendMeter(e: { spent: number; available: number }): SpendMeter | null {
  if (e.available < 0) return { fill: 1, state: "over", total: Math.max(0, e.spent) };
  const spent = Math.max(0, e.spent);
  const total = spent + e.available;
  if (total <= 0) return null;
  const fill = spent / total;
  return { fill, state: fill >= 0.8 ? "warn" : "ok", total };
}

/** Month progress for the hero ruler. `pct` is rounded to whole percent. */
export function monthRuler(todayISO: string): { day: number; days: number; pct: number } {
  const day = Number(todayISO.slice(8, 10));
  const y = Number(todayISO.slice(0, 4));
  const m = Number(todayISO.slice(5, 7));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { day, days, pct: Math.round((day / days) * 100) };
}

export type TbbState = "zero" | "positive" | "negative";
export function tbbState(toBeBudgeted: number): TbbState {
  return toBeBudgeted === 0 ? "zero" : toBeBudgeted > 0 ? "positive" : "negative";
}

export function sumAvailable(envs: Array<{ available: number; archived: boolean; isSavings: boolean }>, savings: boolean): number {
  return envs.filter((e) => !e.archived && e.isSavings === savings).reduce((s, e) => s + e.available, 0);
}

export function sumBalances(accounts: Array<{ balance: number; archived: boolean }>): number {
  return accounts.filter((a) => !a.archived).reduce((s, a) => s + a.balance, 0);
}
