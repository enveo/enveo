






import { computeBudgetState, monthOf } from "./budget";
import type {
  Account,
  Category,
  ClientLedger,
  Envelope,
  EnvelopeGroup,
  Place,
  Transaction,
} from "./types";

 

export interface AccountView extends Account {
  balance: number;
  cleared: number;
  uncleared: number;
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

 
export function computeStateResponse(ledger: ClientLedger, month: string): StateResponse {
  const state = computeBudgetState(ledger, month);

   
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
      cleared: a.cleared,
      uncleared: a.uncleared,
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
