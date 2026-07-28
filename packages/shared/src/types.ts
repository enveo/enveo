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

export type RecurrenceRule =
  | "none"
  | "weekly"
  | "monthly"
  | "monthEnd"
  | "quarterly"
  | "yearly";

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
}

export interface Place {
  id: string;
  name: string;
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
  confirmed: boolean;
  isRefund: boolean; // expense with "+" (refund)
  envelopeId: string | null;
  placeId: string | null;
  categoryId: string | null;
  name: string | null; // short transaction name (list title)
  note: string | null; // longer note (separate from the name)
  tag: string | null; // normalized merchant tag (import idempotency key)
  planned: boolean;
  recurrenceId: string | null;
  items: TxnItem[]; // [] when not a split
  createdAt: string;
}

/** Recurrence rule (planned-transaction template). */
export interface Recurrence {
  id: string;
  rule: RecurrenceRule;
  startDate: string; // YYYY-MM-DD
  endDate: string | null; // YYYY-MM-DD
  pausedUntil: string | null; // YYYY-MM-DD — materialization skips occurrences < this date
}

/** Budgeting act: how much was "added" to an envelope in a given month. */
export interface Allocation {
  id: string;
  envelopeId: string;
  month: string; // YYYY-MM
  amount: Money;
}

/** Budget — metadata (display currency). Single-row replicated entity. */
export interface Budget {
  id: string;
  name: string;
  currency: string; // ISO 4217, e.g. "PLN"
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
  recurrences: Recurrence[];
}

/* ── Computed views (domain layer output) ────────────────────────────── */

export interface AccountState {
  account: Account;
  balance: Money; // all transactions ≤ end of month
  cleared: Money; // confirmed only
  uncleared: Money; // balance - cleared
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
   * unenveloped income / on-off-budget transfer flows from ALL non-planned
   * transactions (any date) — see budget.ts for the full derivation and why
   * it differs from `toBeBudgeted`.
   */
  readyToAssign: Money;
  monthIncome: Money;
  monthExpense: Money;
}
