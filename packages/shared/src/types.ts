/**
 * Shared Enveo domain contract.
 *
 * Conventions:
 * - All amounts are in MINOR UNITS (integer, e.g. grosze/cents). Never float.
 * - Transaction `amount` is always a positive magnitude. Direction follows
 *   from `type` + `isRefund`.
 * - `month` has the "YYYY-MM" format. `date` has the "YYYY-MM-DD" format.
 */

export type Money = number;  

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
  monthlyTarget: Money | null;  
  isSavings: boolean;  
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
  toAccountId: string | null;  
  amount: Money;  
  date: string;  
  confirmed: boolean;
  isRefund: boolean;  
  envelopeId: string | null;
  placeId: string | null;
  categoryId: string | null;
  name: string | null;  
  note: string | null;  
  tag: string | null; // normalized merchant tag (import idempotency key)
  planned: boolean;
  recurrenceId: string | null;
  items: TxnItem[]; // [] when not a split
  createdAt: string;
}

 
export interface Recurrence {
  id: string;
  rule: RecurrenceRule;
  startDate: string;  
  endDate: string | null;  
  pausedUntil: string | null;  
}

 
export interface Allocation {
  id: string;
  envelopeId: string;
  month: string;  
  amount: Money;
}

 
export interface Budget {
  id: string;
  name: string;
  currency: string;  
}

 
export interface Ledger {
  accounts: Account[];
  envelopes: Envelope[];
  groups: EnvelopeGroup[];
  transactions: Transaction[];
  allocations: Allocation[];
}

 
export interface ClientLedger extends Ledger {
  budgets: Budget[];
  categories: Category[];
  places: Place[];
  recurrences: Recurrence[];
}

 

export interface AccountState {
  account: Account;
  balance: Money;  
  cleared: Money;  
  uncleared: Money;  
}

export interface EnvelopeState {
  envelope: Envelope;
  carryIn: Money;  
  allocated: Money;  
  spent: Money;  
  available: Money;  
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
