/**
 * Pure summaries for the Reports overview cards (spec 2026-07-11-raporty-b; A3 triage rule
 * 2026-07-28).
 *
 * - `classifyBudget` — the THRESHOLD rule shared by `budgetsSummary` (hub card) and
 *   `BudgetsReport` (subscreen, screens/Reports.tsx): over = spent > budget; near = not over
 *   AND pct >= 80 AND there is still room to overrun (left > 0); everything else — including
 *   pct === 100 with left === 0, i.e. spent EXACTLY down to the budget — reads as calm, not a
 *   warning (the "amber-wall" fix: a used-up envelope isn't approaching a limit, it already
 *   stopped at it).
 * - `budgetsSummary` — envelope counters via `classifyBudget`; an envelope counts when it has
 *   an allocation (allocated+carryIn>0) or spending in the month.
 */

export interface BudgetsSummary {
  over: number; // overspent (spent > budget)
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
  if (pct > 100) return "over";
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
