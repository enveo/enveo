/**
 * Reports — pure analytical functions computed from the replica (no I/O).
 * Reuse computeBudgetState (balances) and the spentOf rules (spending).
 */
import { computeBudgetState, monthOf, prevMonth } from "./budget";
import type { ClientLedger, Money, Transaction } from "./types";

export interface NetWorthPoint {
  month: string;
  total: Money;
}

/** Sum of ALL account balances (on- and off-budget) at the end of each of `months` months up to `month`. */
export function computeNetWorthSeries(ledger: ClientLedger, month: string, months = 12): NetWorthPoint[] {
  const window: string[] = [month];
  for (let i = 0; i < months - 1; i++) window.unshift(prevMonth(window[0]!));
  return window.map((m) => ({
    month: m,
    total: computeBudgetState(ledger, m).accounts.reduce((s, a) => s + a.balance, 0),
  }));
}

export interface CashflowPoint {
  month: string;
  income: Money;
  expense: Money;
  net: Money;
}

/**
 * Income vs expense per month (all accounts; transfer skipped; refunds negative).
 * Spending assigned to net-worth envelopes (isSavings) is EXCLUDED — cashflow = earnings
 * vs real consumption, consistent with "Spending by dimension" (saving ≠ consumption).
 */
export function computeCashflowSeries(ledger: ClientLedger, month: string, months = 12): CashflowPoint[] {
  const window: string[] = [month];
  for (let i = 0; i < months - 1; i++) window.unshift(prevMonth(window[0]!));
  const savings = new Set(ledger.envelopes.filter((e) => e.isSavings).map((e) => e.id));
  const byMonth = new Map<string, { income: number; expense: number }>();
  for (const m of window) byMonth.set(m, { income: 0, expense: 0 });
  for (const t of ledger.transactions) {
    if (t.type === "transfer") continue;
    const b = byMonth.get(monthOf(t.date));
    if (!b) continue;
    if (t.type === "income") {
      b.income += t.amount;
      continue;
    }
    // expense — skip portions assigned to net-worth envelopes
    const sign = t.isRefund ? -1 : 1;
    if (t.items.length > 0) {
      b.expense += sign * t.items.filter((i) => !savings.has(i.envelopeId)).reduce((s, i) => s + i.amount, 0);
    } else if (!(t.envelopeId && savings.has(t.envelopeId))) {
      b.expense += sign * t.amount;
    }
  }
  return window.map((m) => {
    const b = byMonth.get(m)!;
    return { month: m, income: b.income, expense: b.expense, net: b.income - b.expense };
  });
}

export type SpendingDimension = "category" | "envelope" | "group" | "place";

export interface SpendingRow {
  key: string | null;
  name: string;
  amount: Money;
  pct: number;
}

// Polish product strings returned in rows (UI data — do not translate).
const NULL_LABEL: Record<SpendingDimension, string> = {
  category: "Bez kategorii",
  envelope: "Bez koperty",
  group: "Bez grupy",
  place: "Bez miejsca",
};

/** Expense transaction contribution to the per-dimension breakdown (parity with spentOf rules). */
function expenseByDimension(
  t: Transaction,
  dim: SpendingDimension,
  envGroup: Map<string, string>,
  savings: Set<string>,
): Array<[string | null, Money]> {
  if (t.type !== "expense") return [];
  const sign = t.isRefund ? -1 : 1;
  if (t.items.length > 0) {
    const items = t.items.filter((it) => !savings.has(it.envelopeId));
    if (dim === "place") {
      const amt = items.reduce((s, it) => s + it.amount, 0);
      return amt !== 0 ? [[t.placeId, sign * amt]] : [];
    }
    return items.map((it) => {
      const key = dim === "category" ? it.categoryId : dim === "group" ? (envGroup.get(it.envelopeId) ?? null) : it.envelopeId;
      return [key, sign * it.amount] as [string | null, Money];
    });
  }
  if (t.envelopeId && savings.has(t.envelopeId)) return []; // net-worth envelope — not consumption
  const key =
    dim === "place" ? t.placeId : dim === "category" ? t.categoryId : dim === "group" ? (t.envelopeId ? (envGroup.get(t.envelopeId) ?? null) : null) : t.envelopeId;
  return [[key, sign * t.amount]];
}

/** Spending breakdown [fromMonth, toMonth] by dimension; sorted descending, with % share. */
export function computeSpendingByDimension(
  ledger: ClientLedger,
  fromMonth: string,
  toMonth: string,
  dim: SpendingDimension,
): SpendingRow[] {
  const envGroup = new Map(ledger.envelopes.map((e) => [e.id, e.groupId]));
  const savings = new Set(ledger.envelopes.filter((e) => e.isSavings).map((e) => e.id));
  const nameOf = (key: string | null): string => {
    if (key === null) return NULL_LABEL[dim];
    if (dim === "category") return ledger.categories.find((c) => c.id === key)?.name ?? "Inne";
    if (dim === "place") return ledger.places.find((p) => p.id === key)?.name ?? "Inne";
    if (dim === "group") return ledger.groups.find((g) => g.id === key)?.name ?? "Inne";
    return ledger.envelopes.find((e) => e.id === key)?.name ?? "Inne";
  };
  const sums = new Map<string | null, number>();
  for (const t of ledger.transactions) {
    const m = monthOf(t.date);
    if (m < fromMonth || m > toMonth) continue;
    for (const [key, amt] of expenseByDimension(t, dim, envGroup, savings)) {
      sums.set(key, (sums.get(key) ?? 0) + amt);
    }
  }
  const total = [...sums.values()].reduce((s, v) => s + v, 0);
  return [...sums.entries()]
    .map(([key, amount]) => ({ key, name: nameOf(key), amount, pct: total > 0 ? amount / total : 0 }))
    .filter((r) => r.amount !== 0)
    .sort((a, b) => b.amount - a.amount);
}
