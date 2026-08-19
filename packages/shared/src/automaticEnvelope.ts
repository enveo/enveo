import type { Account, Money, Transaction } from "./types";

export type AllocationFlow = Pick<Transaction, "allocationFromEnvelopeId" | "allocationToEnvelopeId">;
type AllocationRoute = Pick<Transaction, "type" | "accountId"> & { toAccountId?: string | null };

/**
 * NORMALISES TO null ON PURPOSE. `automaticEnvelopeId` arrived in 3.8, so a client replica written
 * by an older build holds account rows WITHOUT the key at all, and only rows touched since then
 * carry an explicit null. Returning that raw `undefined` reads as "linked" to every `!== null`
 * check downstream: the transfer card offered its envelope switch and the preview reported
 * "no envelope change" (from === to, both undefined) for accounts that have no link whatsoever.
 */
function linkedEnvelope(accounts: readonly Account[], accountId: string | null | undefined): string | null {
  const account = accounts.find((candidate) => candidate.id === accountId);
  return account?.onBudget ? (account.automaticEnvelopeId ?? null) : null;
}

export function captureAllocationFlow(accounts: readonly Account[], route: AllocationRoute): AllocationFlow {
  if (route.type === "expense") return { allocationFromEnvelopeId: null, allocationToEnvelopeId: null };

  const accountEnvelopeId = linkedEnvelope(accounts, route.accountId);
  if (route.type === "income") return { allocationFromEnvelopeId: null, allocationToEnvelopeId: accountEnvelopeId };

  return {
    allocationFromEnvelopeId: accountEnvelopeId,
    allocationToEnvelopeId: linkedEnvelope(accounts, route.toAccountId),
  };
}

export function resolveAllocationFlow(
  accounts: readonly Account[],
  next: AllocationRoute,
  previous?: Pick<Transaction, "type" | "accountId" | "toAccountId" | "allocationFromEnvelopeId" | "allocationToEnvelopeId"> | null,
): AllocationFlow {
  if (
    previous &&
    next.type === previous.type &&
    next.accountId === previous.accountId &&
    (next.type !== "transfer" || (next.toAccountId ?? null) === previous.toAccountId)
  ) {
    // Same normalisation as linkedEnvelope: a transaction stored before 3.8 has no allocation keys.
    return {
      allocationFromEnvelopeId: previous.allocationFromEnvelopeId ?? null,
      allocationToEnvelopeId: previous.allocationToEnvelopeId ?? null,
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
