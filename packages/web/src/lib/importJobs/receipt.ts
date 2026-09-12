import { type ClientLedger, computeBudgetState, type ImportReceipt } from "@enveo/shared";
import type { EditedImportItem } from "../api";
import type { ImportReviewRow } from "../importReview";
import type { LocalImportPlan } from "../localImport";

// Same ledger math as the account screen; include all dates for the booked account balance.
const balances = (ledger: ClientLedger) =>
  new Map(
    computeBudgetState(
      ledger,
      ledger.transactions.reduce((month, tx) => (tx.date.slice(0, 7) > month ? tx.date.slice(0, 7) : month), "1970-01"),
    ).accounts.map((a) => [a.account.id, a.balance]),
  );

export function prepareImportReceipt(
  previous: ImportReceipt | null,
  ledger: ClientLedger,
  accountId: string,
  rows: ImportReviewRow[],
  plan: LocalImportPlan,
  applied: readonly string[],
  edited: Record<number, EditedImportItem> = {},
): ImportReceipt {
  if (previous?.completedAt) return previous;
  const planned = new Map(plan.transactions.map((tx) => [tx.rowId, tx]));
  const oldRows = new Map(previous?.rows.map((row) => [row.rowId, row]));
  const name = (items: { id: string; name: string }[], id: string | null | undefined) => items.find((item) => item.id === id)?.name ?? null;
  const accountIds = new Set([accountId, ...(previous?.balances.map((a) => a.accountId) ?? [])]);
  for (const tx of plan.transactions) {
    accountIds.add(tx.payload.accountId);
    if (tx.payload.toAccountId) accountIds.add(tx.payload.toAccountId);
  }
  const current = balances(ledger);
  return {
    completedAt: null,
    currency: previous?.currency ?? ledger.budgets[0]?.currency ?? "EUR",
    balances: [...accountIds].map(
      (id) =>
        previous?.balances.find((a) => a.accountId === id) ?? {
          accountId: id,
          name: name(ledger.accounts, id) ?? "",
          before: applied.length ? null : (current.get(id) ?? null),
          after: null,
        },
    ),
    rows: rows.map((row, index) => {
      const old = oldRows.get(row.rowId);
      if (applied.includes(row.rowId) && old) return old;
      const tx = planned.get(row.rowId);
      const edit = edited[index];
      const item = tx?.payload ?? edit ?? row.item ?? row.draftItem;
      return {
        rowId: row.rowId,
        currency: tx || edit ? (ledger.budgets[0]?.currency ?? null) : row.currency,
        detailsUnavailable: (applied.includes(row.rowId) && !old) || undefined,
        selected: !!tx || row.include || applied.includes(row.rowId),
        added: applied.includes(row.rowId),
        name: item ? (item.name ?? "") : row.rawTextLines.join(" ").slice(0, 2000),
        date: item?.date ?? row.date,
        amount: item?.amount ?? row.amount,
        type: item?.type ?? null,
        isRefund: item?.isRefund ?? false,
        accountId: tx?.payload.accountId ?? edit?.accountId ?? accountId,
        accountName: name(ledger.accounts, tx?.payload.accountId ?? edit?.accountId ?? accountId),
        toAccountName: name(ledger.accounts, item?.toAccountId),
        envelopeName: name(ledger.envelopes, item?.envelopeId),
        categoryName: tx?.categoryName ?? name(ledger.categories, item?.categoryId),
        placeName: tx?.placeName ?? (tx ? name(ledger.places, tx.payload.placeId) : (edit?.placeName ?? row.item?.placeName ?? null)),
        note: tx?.payload.note ?? edit?.note ?? null,
        tag: tx?.payload.tag ?? row.item?.tag ?? row.draftItem?.tag ?? "",
      };
    }),
  };
}

export function finishImportReceipt(draft: ImportReceipt, applied: readonly string[], ledger: ClientLedger, completedAt: string): ImportReceipt {
  if (draft.completedAt) return draft;
  const current = balances(ledger);
  return {
    ...draft,
    completedAt,
    rows: draft.rows.map((row) => ({ ...row, added: applied.includes(row.rowId) })),
    balances: draft.balances.map((a) => ({ ...a, after: current.get(a.accountId) ?? null })),
  };
}
