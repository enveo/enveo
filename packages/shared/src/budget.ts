/**
 * Pure envelope-budgeting math (no I/O).
 *
 * The source of truth is the transaction ledger + allocations. Account
 * balances and envelope "available" are COMPUTED, not stored.
 *
 * Invariant (handover §2.3), enforced by property tests:
 *   Σ(envelope.available) + toBeBudgeted = Σ(on-budget account balances)   (≤ end of month)
 *
 * Carry-over: VARIANT A — negative `available` carries into the next month
 * as a negative carry-in (envelope "in the red").
 */

import type {
  Account,
  Allocation,
  BudgetState,
  EnvelopeState,
  Ledger,
  Money,
  Transaction,
} from "./types";

export const monthOf = (date: string): string => date.slice(0, 7);

/** Next month for "YYYY-MM". */
export function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** Previous month for "YYYY-MM". */
export function prevMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** Transaction contribution to individual account balances. */
function accountDeltas(t: Transaction): Array<[string, Money]> {
  switch (t.type) {
    case "expense":
      return [[t.accountId, t.isRefund ? t.amount : -t.amount]];
    case "income":
      return [[t.accountId, t.amount]];
    case "transfer":
      return t.toAccountId
        ? [
            [t.accountId, -t.amount],
            [t.toAccountId, t.amount],
          ]
        : [[t.accountId, -t.amount]];
  }
}

/**
 * Transaction contribution to envelope "spent" (positive = lowers available).
 * Counted ONLY for transactions from an on-budget account.
 *  - expense:          spent += amount (refund: -=),  split: per item
 *  - income→envelope:  spent -= amount (raises available)
 *  - transfer:         none
 */
function envelopeSpentDeltas(
  t: Transaction,
  isOnBudget: (accountId: string) => boolean,
): Array<[string, Money]> {
  if (t.type === "transfer") return [];
  if (!isOnBudget(t.accountId)) return [];

  if (t.type === "income") {
    return t.envelopeId ? [[t.envelopeId, -t.amount]] : [];
  }

  // expense
  const sign = t.isRefund ? -1 : 1;
  if (t.items.length > 0) {
    return t.items.map((it) => [it.envelopeId, sign * it.amount] as [string, Money]);
  }
  return t.envelopeId ? [[t.envelopeId, sign * t.amount]] : [];
}

/** Whether an account is on-budget (by id). */
function onBudgetSet(accounts: Account[]): (id: string) => boolean {
  const set = new Set(accounts.filter((a) => a.onBudget).map((a) => a.id));
  return (id: string) => set.has(id);
}

/**
 * Full budget state for the selected month.
 * Includes all transactions dated ≤ end of month.
 */
export function computeBudgetState(ledger: Ledger, month: string): BudgetState {
  const { accounts, envelopes, groups, allocations } = ledger;
  const isOnBudget = onBudgetSet(accounts);

  // transactions up to and including the end of the selected month
  const txns = ledger.transactions.filter((t) => monthOf(t.date) <= month);

  // ── account balances ────────────────────────────────────────────────
  const balance = new Map<string, Money>();
  const cleared = new Map<string, Money>();
  for (const a of accounts) {
    balance.set(a.id, a.initialBalance);
    cleared.set(a.id, a.initialBalance);
  }
  for (const t of txns) {
    for (const [accId, d] of accountDeltas(t)) {
      balance.set(accId, (balance.get(accId) ?? 0) + d);
      if (t.confirmed) cleared.set(accId, (cleared.get(accId) ?? 0) + d);
    }
  }

  const accountStates = accounts.map((account) => {
    const bal = balance.get(account.id) ?? 0;
    const clr = cleared.get(account.id) ?? 0;
    return { account, balance: bal, cleared: clr, uncleared: bal - clr };
  });

  // ── envelopes: cumulative and monthly ──────────────────────────────
  // allocated
  const allocCum = new Map<string, Money>(); // month' ≤ month
  const allocThis = new Map<string, Money>(); // month' == month
  for (const a of allocations) {
    if (a.month <= month) allocCum.set(a.envelopeId, (allocCum.get(a.envelopeId) ?? 0) + a.amount);
    if (a.month === month) allocThis.set(a.envelopeId, (allocThis.get(a.envelopeId) ?? 0) + a.amount);
  }
  // spent
  const spentCum = new Map<string, Money>();
  const spentThis = new Map<string, Money>();
  for (const t of txns) {
    const isThis = monthOf(t.date) === month;
    for (const [envId, d] of envelopeSpentDeltas(t, isOnBudget)) {
      spentCum.set(envId, (spentCum.get(envId) ?? 0) + d);
      if (isThis) spentThis.set(envId, (spentThis.get(envId) ?? 0) + d);
    }
  }

  const envelopeStates: EnvelopeState[] = envelopes.map((envelope) => {
    const ac = allocCum.get(envelope.id) ?? 0;
    const at = allocThis.get(envelope.id) ?? 0;
    const sc = spentCum.get(envelope.id) ?? 0;
    const st = spentThis.get(envelope.id) ?? 0;
    const available = ac - sc; // cumulative ≤ month (Variant A: no floor at 0)
    const carryIn = available - (at - st); // i.e. the state at the end of the previous month
    return { envelope, carryIn, allocated: at, spent: st, available };
  });

  // ── to be budgeted (independent formula, see invariant proof) ──────
  let toBeBudgeted: Money = 0;
  for (const a of accounts) if (a.onBudget) toBeBudgeted += a.initialBalance;
  for (const a of allocations) if (a.month <= month) toBeBudgeted -= a.amount;
  for (const t of txns) {
    if (t.type === "income" && isOnBudget(t.accountId) && !t.envelopeId) {
      toBeBudgeted += t.amount;
    }
    if (t.type === "transfer" && t.toAccountId) {
      const fromOn = isOnBudget(t.accountId);
      const toOn = isOnBudget(t.toAccountId);
      if (toOn && !fromOn) toBeBudgeted += t.amount; // flows into the budget
      if (fromOn && !toOn) toBeBudgeted -= t.amount; // flows out of the budget
    }
  }

  // ── ready to assign (month-INDEPENDENT headline, YNAB-style) ────────
  // Same formula as toBeBudgeted, but with no month bound anywhere: every
  // allocation ever made (any month) and every transaction (any date)
  // counts. This is why it can differ from toBeBudgeted — e.g. assigning
  // money in a FUTURE month lowers this figure today, while toBeBudgeted
  // for the currently selected (earlier) month stays unchanged (it only
  // looks at allocations/txns ≤ that month).
  let readyToAssign: Money = 0;
  for (const a of accounts) if (a.onBudget) readyToAssign += a.initialBalance;
  for (const a of allocations) readyToAssign -= a.amount;
  for (const t of ledger.transactions) {
    if (t.type === "income" && isOnBudget(t.accountId) && !t.envelopeId) {
      readyToAssign += t.amount;
    }
    if (t.type === "transfer" && t.toAccountId) {
      const fromOn = isOnBudget(t.accountId);
      const toOn = isOnBudget(t.toAccountId);
      if (toOn && !fromOn) readyToAssign += t.amount; // flows into the budget
      if (fromOn && !toOn) readyToAssign -= t.amount; // flows out of the budget
    }
  }

  // ── income/expense bars for the selected month ─────────────────────
  let monthIncome: Money = 0;
  let monthExpense: Money = 0;
  for (const t of txns) {
    if (monthOf(t.date) !== month || !isOnBudget(t.accountId)) continue;
    if (t.type === "income") monthIncome += t.amount;
    else if (t.type === "expense") monthExpense += t.isRefund ? -t.amount : t.amount;
  }

  return {
    month,
    accounts: accountStates,
    envelopes: envelopeStates,
    groups,
    toBeBudgeted,
    readyToAssign,
    monthIncome,
    monthExpense,
  };
}

/** Sum of on-budget account balances (≤ end of month). Helper for tests/invariant. */
export function totalOnBudget(state: BudgetState): Money {
  return state.accounts
    .filter((a) => a.account.onBudget)
    .reduce((s, a) => s + a.balance, 0);
}

/** Left side of the invariant: Σ available + toBeBudgeted. */
export function budgetedPlusToBeBudgeted(state: BudgetState): Money {
  return state.envelopes.reduce((s, e) => s + e.available, 0) + state.toBeBudgeted;
}
