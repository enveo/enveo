/**
 * Pure summaries for the Reports overview cards (spec 2026-07-11-raporty-b; A3 triage rule
 * 2026-07-28; zero-budget boundary fix 2026-07-29).
 *
 * - `budgetUsage` — the single threshold and percentage rule shared by every report consumer.
 *   A percentage exists only for a positive raw budget; zero/negative budgets remain `null`
 *   instead of acquiring a fabricated one-minor-unit denominator. Overspending is defined by
 *   `left < 0`, independently of percentage. Near means a real percentage >= 80 with money
 *   still left; exact exhaustion stays calm.
 * - `budgetsSummary` — envelope counters via `budgetUsage`; an envelope counts when it has
 *   an allocation (allocated+carryIn>0) or spending in the month.
 * - `budgetsOverAmount` — the € total the hub's Budgets mini-card shows under the pills;
 *   Σ(-left) over rows `budgetUsage` puts in "over".
 */

export interface BudgetsSummary {
  over: number; // overspent (left < 0)
  near: number; // near the limit (pct >= 80% AND left > 0)
  ok: number; // the rest, including "used up" (pct === 100, left === 0)
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

/** Canonical report usage. A non-positive budget has no meaningful percentage. */
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

/** Sort within a status section; rows without a denominator are the first warning group. */
export function compareBudgetUsageRows(left: BudgetUsageRow, right: BudgetUsageRow, compareNames: (left: string, right: string) => number): number {
  if (left.pct === null && right.pct !== null) return -1;
  if (left.pct !== null && right.pct === null) return 1;
  if (left.pct !== null && right.pct !== null) {
    return right.pct - left.pct || compareNames(left.name, right.name);
  }
  return -right.left - -left.left || compareNames(left.name, right.name);
}

/** Counters for the "Envelope budgets" cards — threshold/filter parity with BudgetsReport. */
export function budgetsSummary(envelopes: BudgetEnvelope[]): BudgetsSummary {
  const out: BudgetsSummary = { over: 0, near: 0, ok: 0 };
  for (const e of envelopes) {
    if (e.archived) continue;
    if (!(e.allocated + e.carryIn > 0 || e.spent > 0)) continue;
    out[budgetUsage(e).status]++;
  }
  return out;
}

/** Σ(-left) over "over" envelopes — the € amount shown under the hub's Budgets mini-card pills.
 *  Same filter + usage model as budgetsSummary, so the amount and pill count stay consistent. */
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
