/**
 * Shared Enveo domain contract.
 *
 * Conventions:
 * - All amounts are in MINOR UNITS (integer, e.g. grosze/cents). Never float.
 * - Transaction `amount` is always a positive magnitude. Direction follows
 *   from `type` + `isRefund`.
 * - `month` has the "YYYY-MM" format. `date` has the "YYYY-MM-DD" format.
 */

export type Money = number; // minor units, integer

export type TxnType = "expense" | "income" | "transfer";

export type AccountType = "checking" | "cash" | "savings" | "investment" | "other";

export interface Account {
  id: string;
  name: string;
  color: string;
  icon: string;
  type: AccountType;
  onBudget: boolean;
  initialBalance: Money;
  archived: boolean;
  sort: number;
  automaticEnvelopeId: string | null;
}

export interface EnvelopeGroup {
  id: string;
  name: string;
  sort: number;
}

export interface Envelope {
  id: string;
  groupId: string;
  name: string;
  color: string;
  icon: string;
  note: string | null;
  monthlyTarget: Money | null; // optional monthly target (contribution), minor units
  isSavings: boolean; // net-worth envelope (savings/investments) — counted in Net worth, excluded from spending
  sort: number;
  archived: boolean;
}

export interface Category {
  id: string;
  name: string;
  /** Hidden from entry suggestions and pickers; existing transactions keep it. */
  archived: boolean;
}

export interface Place {
  id: string;
  name: string;
  /** Hidden from entry suggestions and pickers; existing transactions keep it. */
  archived: boolean;
}

/** Split transaction item. Σ items = Transaction.amount. */
export interface TxnItem {
  id: string;
  envelopeId: string;
  categoryId: string | null;
  amount: Money;
}

export interface Transaction {
  id: string;
  type: TxnType;
  accountId: string;
  toAccountId: string | null; // transfer only
  amount: Money; // always a positive magnitude
  date: string; // YYYY-MM-DD
  isRefund: boolean; // expense with "+" (refund)
  envelopeId: string | null;
  placeId: string | null;
  categoryId: string | null;
  name: string | null; // short transaction name (list title)
  note: string | null; // longer note (separate from the name)
  tag: string | null; // normalized merchant tag (import idempotency key)
  sourceRef: string | null; // raw import description; replicated so E2EE can learn from corrections locally
  allocationFromEnvelopeId: string | null;
  allocationToEnvelopeId: string | null;
  items: TxnItem[]; // [] when not a split
  createdAt: string;
}

/** Budgeting act: how much was "added" to an envelope in a given month. */
export interface Allocation {
  id: string;
  envelopeId: string;
  month: string; // YYYY-MM
  amount: Money;
}

import type { BudgetPreferences } from "./preferences";

/** Budget — metadata and durable budget-scoped preferences. Single-row replicated entity. */
export interface Budget {
  id: string;
  name: string;
  currency: string; // ISO 4217, e.g. "PLN"
  preferences: BudgetPreferences;
}

/** Full ledger — input to the pure state-computing functions. */
export interface Ledger {
  accounts: Account[];
  envelopes: Envelope[];
  groups: EnvelopeGroup[];
  transactions: Transaction[];
  allocations: Allocation[];
}

/** Full client replica: ledger + dictionaries needed by screens and sync. */
export interface ClientLedger extends Ledger {
  budgets: Budget[];
  categories: Category[];
  places: Place[];
}

/* ── Computed views (domain layer output) ────────────────────────────── */

export interface AccountState {
  account: Account;
  balance: Money; // all transactions ≤ end of month
}

export interface EnvelopeState {
  envelope: Envelope;
  carryIn: Money; // available from previous months (cumulative)
  allocated: Money; // "added" this month
  spent: Money; // spent this month (positive = expense)
  available: Money; // carryIn + allocated - spent (Variant A: may be < 0)
}

export interface BudgetState {
  month: string;
  accounts: AccountState[];
  envelopes: EnvelopeState[];
  groups: EnvelopeGroup[];
  toBeBudgeted: Money;
  /**
   * Month-INDEPENDENT "ready to assign" (YNAB-style headline): Σ on-budget
   * initialBalance, minus EVERY allocation ever made (any month), plus
   * unenveloped income / on-off-budget transfer flows from ALL
   * transactions (any date) — see budget.ts for the full derivation and why
   * it differs from `toBeBudgeted`.
   */
  readyToAssign: Money;
  monthIncome: Money;
  monthExpense: Money;
}
