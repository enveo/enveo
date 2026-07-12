/**
 * Pure summaries for the Reports overview cards (spec 2026-07-11-raporty-b).
 *
 * - `budgetsSummary` — envelope counters with THE SAME thresholds and filter as
 *   BudgetsReport (screens/Reports.tsx): >100% overspent, ≥80% near
 *   the limit, the rest OK; an envelope counts when it has an allocation
 *   (allocated+carryIn>0) or spending in the month.
 * - `upcomingWindow` — the ONLY source of "upcoming" (the overview card
 *   and SubscriptionsTab): planned transactions from shared `upcomingPayments`
 *   within the [today, today+days] window + the total + the nearest item.
 */
import { upcomingPayments, type ClientLedger, type UpcomingPayment } from "@enveo/shared";

export interface BudgetsSummary {
  over: number; // overspent (>100%)
  near: number; // near the limit (≥80% and ≤100%)
  ok: number; // the rest
}

type BudgetEnvelope = {
  archived: boolean;
  allocated: number;
  carryIn: number;
  spent: number;
};

/** Counters for the "Envelope budgets" cards — threshold/filter parity with BudgetsReport. */
export function budgetsSummary(envelopes: BudgetEnvelope[]): BudgetsSummary {
  const out: BudgetsSummary = { over: 0, near: 0, ok: 0 };
  for (const e of envelopes) {
    if (e.archived) continue;
    if (!(e.allocated + e.carryIn > 0 || e.spent > 0)) continue;
    const budget = Math.max(1, e.allocated + e.carryIn);
    const pct = (Math.max(0, e.spent) / budget) * 100;
    if (pct > 100) out.over++;
    else if (pct >= 80) out.near++;
    else out.ok++;
  }
  return out;
}

export interface UpcomingWindow {
  /** Full list (for SubscriptionsTab) — sorted ascending by date. */
  payments: UpcomingPayment[];
  /** Sum of the amounts in the window (minor units). */
  total: number;
  /** The nearest payment or null when the window is empty. */
  nearest: { name: string; date: string } | null;
}

/** Planned payments within the [todayISO, todayISO+days] window + total and nearest. */
export function upcomingWindow(ledger: ClientLedger, todayISO: string, days = 30): UpcomingWindow {
  const payments = upcomingPayments(ledger, todayISO, days);
  const first = payments[0];
  return {
    payments,
    total: payments.reduce((s, p) => s + p.txn.amount, 0),
    nearest: first ? { name: first.label, date: first.txn.date } : null,
  };
}
