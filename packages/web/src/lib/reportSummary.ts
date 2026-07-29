/**
 * Pure summaries for the Reports overview cards (spec 2026-07-11-raporty-b; A3 triage rule
 * 2026-07-28; zero-budget boundary fix 2026-07-29).
 *
 * - `classifyBudget` — the THRESHOLD rule shared by `budgetsSummary` (hub card) and
 *   `BudgetsReport` (subscreen, screens/Reports.tsx): over = left < 0 (equivalent to
 *   spent > budget on the RAW, unfloored budget); near = not over AND pct >= 80 AND there is
 *   still room to overrun (left > 0); everything else — including pct === 100 with left === 0,
 *   i.e. spent EXACTLY down to the budget — reads as calm, not a warning (the "amber-wall"
 *   fix: a used-up envelope isn't approaching a limit, it already stopped at it).
 *
 *   `over` is defined on `left`, NOT on `pct`: callers compute `pct` against a FLOORED budget
 *   (`Math.max(1, allocated+carryIn)`, to avoid divide-by-zero) while `left` stays on the RAW
 *   budget. When the raw budget is <= 0, any positive spend can land `pct` at exactly 100 (not
 *   > 100) while `left` is already negative — `pct > 100` would misclassify that as "ok", a
 *   real overspend reading as calm.
 * - `budgetsSummary` — envelope counters via `classifyBudget`; an envelope counts when it has
 *   an allocation (allocated+carryIn>0) or spending in the month.
 * - `budgetsOverAmount` — the € total the hub's Budgets mini-card shows under the pills;
 *   Σ(-left) over rows `classifyBudget` puts in "over", NOT an inline `pct > 100` check (that
 *   inline check re-introduces the zero-budget boundary bug fixed in adb4c43 for the pill
 *   counters: raw budget <= 0 + any spend → pct lands at exactly 100 on the FLOORED budget while
 *   `left` is already negative — `pct > 100` reads that as "ok" and silently drops it from the
 *   € total even though the pill above already counts it as "over").
 */

export interface BudgetsSummary {
  over: number; // overspent (left < 0)
  near: number; // near the limit (pct >= 80% AND left > 0)
  ok: number; // the rest, including "used up" (pct === 100, left === 0)
}

export type BudgetStatus = "over" | "near" | "ok";

type BudgetEnvelope = {
  archived: boolean;
  allocated: number;
  carryIn: number;
  spent: number;
};

/** Threshold rule shared by budgetsSummary and BudgetsReport — see the module doc above. */
export function classifyBudget(pct: number, left: number): BudgetStatus {
  if (left < 0) return "over";
  if (pct >= 80 && left > 0) return "near";
  return "ok";
}

/** Counters for the "Envelope budgets" cards — threshold/filter parity with BudgetsReport. */
export function budgetsSummary(envelopes: BudgetEnvelope[]): BudgetsSummary {
  const out: BudgetsSummary = { over: 0, near: 0, ok: 0 };
  for (const e of envelopes) {
    if (e.archived) continue;
    if (!(e.allocated + e.carryIn > 0 || e.spent > 0)) continue;
    const budget = Math.max(1, e.allocated + e.carryIn);
    const pct = (Math.max(0, e.spent) / budget) * 100;
    const left = e.allocated + e.carryIn - e.spent; // = envelope.available (carryIn+allocated-spent)
    out[classifyBudget(pct, left)]++;
  }
  return out;
}

/** Σ(-left) over "over" envelopes — the € amount shown under the hub's Budgets mini-card pills.
 *  Same filter + classifier as budgetsSummary, so the amount and the pill count are always
 *  consistent (see module doc above for why this must NOT be an inline `pct > 100` check). */
export function budgetsOverAmount(envelopes: BudgetEnvelope[]): number {
  let total = 0;
  for (const e of envelopes) {
    if (e.archived) continue;
    if (!(e.allocated + e.carryIn > 0 || e.spent > 0)) continue;
    const budget = Math.max(1, e.allocated + e.carryIn);
    const pct = (Math.max(0, e.spent) / budget) * 100;
    const left = e.allocated + e.carryIn - e.spent;
    if (classifyBudget(pct, left) === "over") total += -left;
  }
  return total;
}
