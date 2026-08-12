/**
 * Shared screen aggregate — the SAME code computes the `GET /api/state`
 * response on the server and the client's local read (parity guaranteed).
 *
 * Logic carried over VERBATIM from packages/api/src/routes/state.ts
 * (month filter + sort comparator + account/envelope flattening).
 */
import { computeBudgetState, monthOf } from "./budget";
import type { Account, Category, ClientLedger, Envelope, EnvelopeGroup, Place, Transaction } from "./types";

/* ── API response shapes (source of truth; web re-exports) ───────────── */

export interface AccountView extends Account {
  balance: number;
}

export interface EnvelopeView extends Envelope {
  carryIn: number;
  allocated: number;
  spent: number;
  available: number;
}

export interface StateResponse {
  month: string;
  toBeBudgeted: number;
  /** Month-independent "ready to assign" headline — see BudgetState.readyToAssign. */
  readyToAssign: number;
  monthIncome: number;
  monthExpense: number;
  accounts: AccountView[];
  groups: EnvelopeGroup[];
  envelopes: EnvelopeView[];
  transactions: Transaction[];
  categories: Category[];
  places: Place[];
}

/** Aggregate for the whole mobile screen — a single read. */
export function computeStateResponse(ledger: ClientLedger, month: string): StateResponse {
  const state = computeBudgetState(ledger, month);

  // this month's transactions, newest first (for the list)
  const txns = ledger.transactions
    .filter((t) => monthOf(t.date) === month)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.createdAt < b.createdAt ? 1 : -1));

  return {
    month,
    toBeBudgeted: state.toBeBudgeted,
    readyToAssign: state.readyToAssign,
    monthIncome: state.monthIncome,
    monthExpense: state.monthExpense,
    accounts: state.accounts.map((a) => ({
      ...a.account,
      balance: a.balance,
    })),
    groups: state.groups,
    envelopes: state.envelopes.map((e) => ({
      ...e.envelope,
      carryIn: e.carryIn,
      allocated: e.allocated,
      spent: e.spent,
      available: e.available,
    })),
    transactions: txns,
    categories: ledger.categories,
    places: ledger.places,
  };
}
