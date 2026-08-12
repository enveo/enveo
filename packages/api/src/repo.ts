import type { Account, Allocation, Budget, Category, ClientLedger, Envelope, EnvelopeGroup, Ledger, Place, Transaction, TxnItem } from "@enveo/shared";
import { eq } from "drizzle-orm";
import { db } from "./db/client";
import type { Executor } from "./sync/apply";
import * as s from "./db/schema";

/* ── Mapping DB row → shared type (without budgetId/externalId) ──
   One place for snapshot / pull / state — parity guaranteed. */

export const mapBudget = (b: typeof s.budgets.$inferSelect): Budget => ({
  id: b.id,
  name: b.name,
  currency: b.currency,
});

export const mapAccount = (a: typeof s.accounts.$inferSelect): Account => ({
  id: a.id,
  name: a.name,
  color: a.color,
  icon: a.icon,
  type: a.type as Account["type"],
  onBudget: a.onBudget,
  initialBalance: a.initialBalance,
  archived: a.archived,
  sort: a.sort,
});

export const mapGroup = (g: typeof s.envelopeGroups.$inferSelect): EnvelopeGroup => ({
  id: g.id,
  name: g.name,
  sort: g.sort,
});

export const mapEnvelope = (e: typeof s.envelopes.$inferSelect): Envelope => ({
  id: e.id,
  groupId: e.groupId,
  name: e.name,
  color: e.color,
  icon: e.icon,
  note: e.note,
  monthlyTarget: e.monthlyTarget,
  isSavings: e.isSavings,
  sort: e.sort,
  archived: e.archived,
});

export const mapCategory = (c: typeof s.categories.$inferSelect): Category => ({
  id: c.id,
  name: c.name,
});

export const mapPlace = (p: typeof s.places.$inferSelect): Place => ({ id: p.id, name: p.name });

export const mapAllocation = (a: typeof s.allocations.$inferSelect): Allocation => ({
  id: a.id,
  envelopeId: a.envelopeId,
  month: a.month,
  amount: a.amount,
});

export const mapTxnItem = (i: { id: string; envelopeId: string; categoryId: string | null; amount: number }): TxnItem => ({
  id: i.id,
  envelopeId: i.envelopeId,
  categoryId: i.categoryId,
  amount: i.amount,
});

export const mapTransaction = (t: typeof s.transactions.$inferSelect, items: TxnItem[]): Transaction => ({
  id: t.id,
  type: t.type,
  accountId: t.accountId,
  toAccountId: t.toAccountId,
  amount: t.amount,
  date: t.date,
  isRefund: t.isRefund,
  envelopeId: t.envelopeId,
  placeId: t.placeId,
  categoryId: t.categoryId,
  name: t.name,
  note: t.note,
  tag: t.tag,
  items,
  createdAt: t.createdAt,
});

/** Loads the full budget ledger and maps it to the shared domain types. */
export async function loadLedger(budgetId: string, x: Executor = db): Promise<Ledger> {
  const [accRows, grpRows, envRows, allocRows, txnRows, itemRows] = await Promise.all([
    x.select().from(s.accounts).where(eq(s.accounts.budgetId, budgetId)),
    x.select().from(s.envelopeGroups).where(eq(s.envelopeGroups.budgetId, budgetId)),
    x.select().from(s.envelopes).where(eq(s.envelopes.budgetId, budgetId)),
    x.select().from(s.allocations).where(eq(s.allocations.budgetId, budgetId)),
    x.select().from(s.transactions).where(eq(s.transactions.budgetId, budgetId)),
    x
      .select({
        id: s.txnItems.id,
        transactionId: s.txnItems.transactionId,
        envelopeId: s.txnItems.envelopeId,
        categoryId: s.txnItems.categoryId,
        amount: s.txnItems.amount,
      })
      .from(s.txnItems)
      .innerJoin(s.transactions, eq(s.txnItems.transactionId, s.transactions.id))
      .where(eq(s.transactions.budgetId, budgetId)),
  ]);

  const itemsByTxn = new Map<string, TxnItem[]>();
  for (const it of itemRows) {
    const arr = itemsByTxn.get(it.transactionId) ?? [];
    arr.push(mapTxnItem(it));
    itemsByTxn.set(it.transactionId, arr);
  }

  return {
    accounts: accRows.map(mapAccount),
    groups: grpRows.map(mapGroup),
    envelopes: envRows.map(mapEnvelope),
    allocations: allocRows.map(mapAllocation),
    transactions: txnRows.map((t) => mapTransaction(t, itemsByTxn.get(t.id) ?? [])),
  };
}

/** Ledger + dictionaries (categories, places) — the full client replica. */
export async function loadClientLedger(x: Executor, budgetId: string): Promise<ClientLedger> {
  const [ledger, catRows, plcRows, budgetRows] = await Promise.all([
    loadLedger(budgetId, x),
    x.select().from(s.categories).where(eq(s.categories.budgetId, budgetId)),
    x.select().from(s.places).where(eq(s.places.budgetId, budgetId)),
    x.select().from(s.budgets).where(eq(s.budgets.id, budgetId)),
  ]);
  return {
    ...ledger,
    categories: catRows.map(mapCategory),
    places: plcRows.map(mapPlace),
    budgets: budgetRows.map(mapBudget),
  };
}
