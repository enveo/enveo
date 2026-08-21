














export interface BudgetsSummary {
  over: number;  
  near: number;  
  ok: number;  
}

export type BudgetStatus = "over" | "near" | "ok";

export type BudgetEnvelope = {
  archived: boolean;
  allocated: number;
  carryIn: number;
  spent: number;
};

export interface BudgetUsage {
  rawBudget: number;
  spent: number;
  left: number;
  pct: number | null;
  status: BudgetStatus;
}

export interface BudgetRowPresentation {
  percentage: number | null;
  visualBarPct: number;
  noBudget: boolean;
  overspend: number;
}

export interface BudgetUsageRow extends BudgetUsage {
  name: string;
}

 
export function budgetUsage(envelope: BudgetEnvelope): BudgetUsage {
  const rawBudget = envelope.allocated + envelope.carryIn;
  const spent = envelope.spent;
  const left = rawBudget - spent;
  const pct = rawBudget > 0 ? (Math.max(0, spent) / rawBudget) * 100 : null;
  const status = left < 0 ? "over" : pct !== null && pct >= 80 && left > 0 ? "near" : "ok";
  return { rawBudget, spent, left, pct, status };
}

/** Presentation-only values. `visualBarPct` must never feed report calculations. */
export function budgetRowPresentation(usage: BudgetUsage): BudgetRowPresentation {
  return {
    percentage: usage.pct,
    visualBarPct: usage.pct ?? (usage.left < 0 ? 100 : 0),
    noBudget: usage.rawBudget <= 0,
    overspend: usage.left < 0 ? -usage.left : 0,
  };
}

 
export function compareBudgetUsageRows(left: BudgetUsageRow, right: BudgetUsageRow, compareNames: (left: string, right: string) => number): number {
  if (left.pct === null && right.pct !== null) return -1;
  if (left.pct !== null && right.pct === null) return 1;
  if (left.pct !== null && right.pct !== null) {
    return right.pct - left.pct || compareNames(left.name, right.name);
  }
  return -right.left - -left.left || compareNames(left.name, right.name);
}

 
export function budgetsSummary(envelopes: BudgetEnvelope[]): BudgetsSummary {
  const out: BudgetsSummary = { over: 0, near: 0, ok: 0 };
  for (const e of envelopes) {
    if (e.archived) continue;
    if (!(e.allocated + e.carryIn > 0 || e.spent > 0)) continue;
    out[budgetUsage(e).status]++;
  }
  return out;
}



export function budgetsOverAmount(envelopes: BudgetEnvelope[]): number {
  let total = 0;
  for (const e of envelopes) {
    if (e.archived) continue;
    if (!(e.allocated + e.carryIn > 0 || e.spent > 0)) continue;
    const usage = budgetUsage(e);
    if (usage.status === "over") total += -usage.left;
  }
  return total;
}

/* ── Pace projection (spec 2026-08-21) ─────────────────────────────────────────────────
 * The Budgets report stops being a passive triage and becomes a checklist of fixes. That
 * needs one thing today's model cannot answer: "this envelope is fine RIGHT NOW, but will it
 * still be fine on the last day of the month?" — a straight-line projection of the current
 * spend rate to month end.
 *
 * `risk` is layered ON TOP of `budgetUsage`, never in place of it. `over` remains `left < 0`
 * and nothing else: an envelope with a zero budget and any spending has a floored denominator
 * (`pct` is null by construction) and must never be reported as "used up" or "on pace".
 */

/** How much of `month` has elapsed as of `today` (YYYY-MM-DD), in (0..1].
 *  A past month is 1, a future month is 0, the current month is day-inclusive so that the
 *  first day of the month already counts as elapsed time and never divides by zero. */
export function monthProgress(month: string, today: string): number {
  const currentMonth = today.slice(0, 7);
  if (month < currentMonth) return 1;
  if (month > currentMonth) return 0;
  const daysInMonth = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
  const day = +today.slice(8, 10);
  return Math.min(1, day / daysInMonth);
}

export type BudgetPaceBucket = "over" | "risk" | "near" | "usedUp" | "ok";

export interface BudgetPace {
   
  projected: number;
  bucket: BudgetPaceBucket;
}

 
export function budgetPace(envelope: BudgetEnvelope, progress: number): BudgetPace {
  const usage = budgetUsage(envelope);
  const spent = Math.max(0, usage.spent);
  // progress <= 0 (a future month) means there is no elapsed time to extrapolate from, so the
  // honest projection is what has actually been spent — which can never trigger `risk`.
  const projected = progress > 0 ? Math.round(spent / Math.min(1, progress)) : spent;

  if (usage.status === "over") return { projected, bucket: "over" };
  if (usage.status === "near") return { projected, bucket: "near" };
   
  if (usage.pct !== null && usage.pct >= 100) return { projected, bucket: "usedUp" };
  if (usage.rawBudget > 0 && spent > 0 && projected > usage.rawBudget) return { projected, bucket: "risk" };
  return { projected, bucket: "ok" };
}
