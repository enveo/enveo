import type { Account, Money, Transaction } from "./types";

export type AllocationFlow = Pick<Transaction, "allocationFromEnvelopeId" | "allocationToEnvelopeId">;

function linkedEnvelope(accounts: readonly Account[], accountId: string | null): string | null {
  const account = accounts.find((candidate) => candidate.id === accountId);
  return account?.onBudget ? account.automaticEnvelopeId : null;
}

export function captureAllocationFlow(accounts: readonly Account[], route: Pick<Transaction, "type" | "accountId" | "toAccountId">): AllocationFlow {
  if (route.type === "expense") return { allocationFromEnvelopeId: null, allocationToEnvelopeId: null };

  if (route.type === "income") {
    return {
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: linkedEnvelope(accounts, route.accountId),
    };
  }

  return {
    allocationFromEnvelopeId: linkedEnvelope(accounts, route.accountId),
    allocationToEnvelopeId: linkedEnvelope(accounts, route.toAccountId),
  };
}

export function resolveAllocationFlow(
  accounts: readonly Account[],
  next: Pick<Transaction, "type" | "accountId" | "toAccountId">,
  previous?: Pick<Transaction, "type" | "accountId" | "toAccountId" | "allocationFromEnvelopeId" | "allocationToEnvelopeId"> | null,
): AllocationFlow {
  if (
    previous &&
    next.type === previous.type &&
    next.accountId === previous.accountId &&
    (next.type !== "transfer" || next.toAccountId === previous.toAccountId)
  ) {
    return {
      allocationFromEnvelopeId: previous.allocationFromEnvelopeId,
      allocationToEnvelopeId: previous.allocationToEnvelopeId,
    };
  }

  return captureAllocationFlow(accounts, next);
}

export function transactionAllocationDeltas(
  transaction: Pick<Transaction, "amount" | "allocationFromEnvelopeId" | "allocationToEnvelopeId">,
): Array<readonly [envelopeId: string, amount: Money]> {
  const from = transaction.allocationFromEnvelopeId;
  const to = transaction.allocationToEnvelopeId;
  if (from === to) return [];
  if (!from) return to ? [[to, transaction.amount]] : [];
  return to
    ? [
        [from, -transaction.amount],
        [to, transaction.amount],
      ]
    : [[from, -transaction.amount]];
}

export function automaticAllocatedForEnvelopeMonth(transactions: readonly Transaction[], envelopeId: string, month: string): Money {
  let total = 0;
  for (const transaction of transactions) {
    if (transaction.date.slice(0, 7) !== month) continue;
    for (const [id, amount] of transactionAllocationDeltas(transaction)) {
      if (id === envelopeId) total += amount;
    }
  }
  return total;
}

export function manualAllocationForDisplayedTotal(transactions: readonly Transaction[], envelopeId: string, month: string, displayedTotal: Money): Money {
  return displayedTotal - automaticAllocatedForEnvelopeMonth(transactions, envelopeId, month);
}
