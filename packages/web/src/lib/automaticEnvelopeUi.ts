import { type Account, type Envelope, type Money, resolveAllocationFlow, type Transaction, type TxnPayload, transactionAllocationDeltas } from "@enveo/shared";

export type AutomaticEnvelopeRoute = Pick<Transaction, "type" | "accountId"> & { toAccountId?: string | null };
export type PreviousAutomaticEnvelopeRoute = Pick<Transaction, "type" | "accountId" | "toAccountId" | "allocationFromEnvelopeId" | "allocationToEnvelopeId">;

export interface AutomaticEnvelopePreview {
  rows: Array<{ envelopeId: string; name: string; amount: Money }>;
  readyToAssignDelta: Money;
  /** True only when both sides resolve to the same linked envelope. */
  neutral: boolean;
}

export interface ExpenseEnvelopeSelection {
  envelopeId: string | null;
  provenance: "automatic" | "explicit";
}

export interface ReconciliationEnvelopeSelection {
  accountId: string;
  automaticEnvelopeId: string | null;
  envelopeId: string | null;
  provenance: "automatic" | "explicit";
}

export type AutomaticEnvelopeEffectTone = "positive" | "negative" | "neutral";
export interface AutomaticEnvelopeEffectData {
  heading: string;
  rows: Array<{ name: string; amount: string; tone: AutomaticEnvelopeEffectTone }>;
  readyToAssign: { name: string; amount: string; tone: AutomaticEnvelopeEffectTone };
  neutral: boolean;
  noEnvelopeChange: string;
}

export function expenseEnvelopeSelection(automaticEnvelopeId: string | null | undefined, preset?: { envelopeId: string | null }): ExpenseEnvelopeSelection {
  return preset ? { envelopeId: preset.envelopeId, provenance: "explicit" } : { envelopeId: automaticEnvelopeId ?? null, provenance: "automatic" };
}

export function explicitExpenseEnvelopeSelection(envelopeId: string | null): ExpenseEnvelopeSelection {
  return { envelopeId, provenance: "explicit" };
}

/** Account changes may follow an automatic default, but never replace explicit/split choices. */
export function expenseEnvelopeAfterAccountChange(
  current: ExpenseEnvelopeSelection,
  automaticEnvelopeId: string | null | undefined,
  split: boolean,
): ExpenseEnvelopeSelection {
  return current.provenance === "automatic" && !split ? expenseEnvelopeSelection(automaticEnvelopeId) : current;
}

export function expenseEnvelopeAfterSplitCancel(current: ExpenseEnvelopeSelection, automaticEnvelopeId: string | null | undefined): ExpenseEnvelopeSelection {
  return current.provenance === "automatic" ? expenseEnvelopeSelection(automaticEnvelopeId) : current;
}

export function expenseEnvelopeSelectionForImport(
  type: Transaction["type"],
  envelopeId: string | null,
  automaticEnvelopeId: string | null | undefined,
): ExpenseEnvelopeSelection {
  return type === "expense" && envelopeId === null ? expenseEnvelopeSelection(automaticEnvelopeId) : explicitExpenseEnvelopeSelection(envelopeId);
}

export function currentReconciliationAccount<T extends { id: string }>(accountsNow: readonly T[], accountId: string | null): T | null {
  return accountId ? (accountsNow.find((account) => account.id === accountId) ?? null) : null;
}

export function reconciliationActualValueAfterAccountRefresh(
  current: string,
  previous: { id: string; balance: Money } | null,
  account: { id: string; balance: Money },
): string {
  return previous?.id === account.id && previous.balance === account.balance ? current : (account.balance / 100).toFixed(2).replace(".", ",");
}

export function reconciliationEnvelopeAfterAccountRefresh(
  current: ReconciliationEnvelopeSelection | null,
  accountId: string,
  automaticEnvelopeId: string | null,
): ReconciliationEnvelopeSelection {
  if (!current || current.accountId !== accountId) {
    return { accountId, automaticEnvelopeId, envelopeId: automaticEnvelopeId, provenance: "automatic" };
  }
  if (current.automaticEnvelopeId === automaticEnvelopeId) return current;
  return current.provenance === "automatic"
    ? { accountId, automaticEnvelopeId, envelopeId: automaticEnvelopeId, provenance: "automatic" }
    : { ...current, automaticEnvelopeId };
}

export function formatAutomaticEnvelopeEffect(
  preview: AutomaticEnvelopePreview,
  formatMoney: (amount: Money) => string,
  labels: { heading: string; readyToAssign: string; noEnvelopeChange: string; noChange: string },
): AutomaticEnvelopeEffectData {
  const row = (name: string, amount: Money) => ({
    name,
    amount: amount === 0 ? labels.noChange : `${amount > 0 ? "+" : "−"}${formatMoney(Math.abs(amount))}`,
    tone: (amount > 0 ? "positive" : amount < 0 ? "negative" : "neutral") as AutomaticEnvelopeEffectTone,
  });
  return {
    heading: labels.heading,
    rows: preview.rows.map((effect) => row(effect.name, effect.amount)),
    readyToAssign: row(labels.readyToAssign, preview.readyToAssignDelta),
    neutral: preview.neutral,
    noEnvelopeChange: labels.noEnvelopeChange,
  };
}

export function reconciliationTxnPayload(input: { accountId: string; difference: Money; envelopeId: string | null; date: string; note: string }): TxnPayload {
  const expense = input.difference < 0;
  return {
    type: expense ? "expense" : "income",
    accountId: input.accountId,
    toAccountId: null,
    amount: Math.abs(input.difference),
    date: input.date,
    isRefund: false,
    envelopeId: expense ? input.envelopeId : null,
    note: input.note,
    allocationFromEnvelopeId: null,
    allocationToEnvelopeId: null,
  };
}

export function automaticEnvelopePreview(
  state: { accounts: readonly Account[]; envelopes: readonly Envelope[] },
  route: AutomaticEnvelopeRoute,
  amount: Money,
  previous?: PreviousAutomaticEnvelopeRoute | null,
): AutomaticEnvelopePreview {
  const flow = resolveAllocationFlow(state.accounts, route, previous);
  const deltas = transactionAllocationDeltas({ amount, ...flow });
  const envelopes = new Map(state.envelopes.map((envelope) => [envelope.id, envelope]));
  const rows = deltas.flatMap(([envelopeId, delta]) => {
    const envelope = envelopes.get(envelopeId);
    return envelope ? [{ envelopeId, name: envelope.name, amount: delta }] : [];
  });
  const envelopeDelta = deltas.reduce((sum, [, delta]) => sum + delta, 0);
  return {
    rows,
    readyToAssignDelta: envelopeDelta === 0 ? 0 : -envelopeDelta,
    neutral: flow.allocationFromEnvelopeId !== null && flow.allocationFromEnvelopeId === flow.allocationToEnvelopeId,
  };
}
