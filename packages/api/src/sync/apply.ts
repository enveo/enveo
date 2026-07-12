/**
 * Domain write cores — shared between REST and POST /api/sync/push.
 *
 * Every function takes an executor (db or a transaction) as its first argument,
 * so push can apply an op in the same transaction as the `sync_ops` guard.
 *
 * Conventions:
 * - create accepts an optional `id` (REST omits → DB default; sync supplies it),
 *   `applyTxnCreate` also honors the client's `createdAt` (stable list order),
 * - update returns the row or "not_found" (REST → 404, push → rejected),
 * - delete is idempotent (missing row = ok),
 * - normalization as previously in routes: transfer ⇒ envelopeId null +
 *   toAccountId preserved; items>0 ⇒ parent's envelopeId/categoryId null;
 *   tag on update only when sent; items on update delete+reinsert.
 */
import type {
  AccountPayload,
  AllocPayload,
  EnvelopePayload,
  GroupPayload,
  RecurrencePayload,
  TxnPayload,
} from "@enveo/shared";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import * as s from "../db/schema";

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Executor = typeof db | DbTx;

export const NOT_FOUND = "not_found" as const;
export type NotFound = typeof NOT_FOUND;

/* ── Budget (single-row entity — display currency only) ─────────────── */

export async function applyBudgetUpdate(x: Executor, budgetId: string, currency: string) {
  const [row] = await x
    .update(s.budgets)
    .set({ currency })
    .where(eq(s.budgets.id, budgetId))
    .returning();
  return row ?? NOT_FOUND;
}

/* ── Transactions ───────────────────────────────────────────────────── */

export async function applyTxnCreate(
  x: Executor,
  budgetId: string,
  body: TxnPayload & { id?: string },
) {
  const items = body.items ?? [];
  const envelopeId = items.length > 0 ? null : (body.envelopeId ?? null);
  const [row] = await x
    .insert(s.transactions)
    .values({
      ...(body.id ? { id: body.id } : {}),
      budgetId,
      type: body.type,
      accountId: body.accountId,
      toAccountId: body.type === "transfer" ? (body.toAccountId ?? null) : null,
      amount: body.amount,
      date: body.date,
      confirmed: body.confirmed ?? true,
      isRefund: body.isRefund ?? false,
      envelopeId: body.type === "transfer" ? null : envelopeId,
      placeId: body.placeId ?? null,
      categoryId: items.length > 0 ? null : (body.categoryId ?? null),
      name: body.name ?? null,
      note: body.note ?? null,
      tag: body.tag ?? null,
      planned: body.planned ?? false,
      recurrenceId: body.recurrenceId ?? null,
      ...(body.createdAt ? { createdAt: body.createdAt } : {}),
    })
    .returning();
  if (items.length > 0) {
    await x.insert(s.txnItems).values(
      items.map((i) => ({
        transactionId: row!.id,
        envelopeId: i.envelopeId,
        categoryId: i.categoryId ?? null,
        amount: i.amount,
      })),
    );
  }
  return row!;
}

/** Full field replacement (LWW); items delete+reinsert. `createdAt` is not changed. */
export async function applyTxnUpdate(
  x: Executor,
  budgetId: string,
  body: TxnPayload & { id: string },
) {
  const items = body.items ?? [];
  const [row] = await x
    .update(s.transactions)
    .set({
      type: body.type,
      accountId: body.accountId,
      toAccountId: body.type === "transfer" ? (body.toAccountId ?? null) : null,
      amount: body.amount,
      date: body.date,
      confirmed: body.confirmed ?? true,
      isRefund: body.isRefund ?? false,
      envelopeId: body.type === "transfer" ? null : items.length > 0 ? null : (body.envelopeId ?? null),
      placeId: body.placeId ?? null,
      categoryId: items.length > 0 ? null : (body.categoryId ?? null),
      name: body.name ?? null,
      note: body.note ?? null,
      // tag is preserved when the update does not send it (UI edits don't know import tags)
      ...(body.tag !== undefined ? { tag: body.tag } : {}),
      planned: body.planned ?? false,
      recurrenceId: body.recurrenceId ?? null,
    })
    .where(and(eq(s.transactions.id, body.id), eq(s.transactions.budgetId, budgetId)))
    .returning();
  if (!row) return NOT_FOUND;
  await x.delete(s.txnItems).where(eq(s.txnItems.transactionId, body.id));
  if (items.length > 0) {
    await x.insert(s.txnItems).values(
      items.map((i) => ({
        transactionId: body.id,
        envelopeId: i.envelopeId,
        categoryId: i.categoryId ?? null,
        amount: i.amount,
      })),
    );
  }
  return row;
}

/** Idempotent — a missing row is also a success. */
export async function applyTxnDelete(x: Executor, budgetId: string, id: string): Promise<void> {
  await x
    .delete(s.transactions)
    .where(and(eq(s.transactions.id, id), eq(s.transactions.budgetId, budgetId)));
}

/* ── Allocations (natural key envelopeId+month, upsert) ─────────────── */

export async function applyAllocSet(x: Executor, budgetId: string, body: AllocPayload) {
  const [row] = await x
    .insert(s.allocations)
    .values({ budgetId, ...body })
    .onConflictDoUpdate({
      target: [s.allocations.envelopeId, s.allocations.month],
      set: { amount: body.amount },
    })
    .returning();
  return row!;
}

/* ── Accounts ───────────────────────────────────────────────────────── */

export async function applyAccountCreate(
  x: Executor,
  budgetId: string,
  body: AccountPayload & { id?: string },
) {
  const { id, ...fields } = body;
  const [row] = await x
    .insert(s.accounts)
    .values({ ...(id ? { id } : {}), budgetId, ...fields })
    .returning();
  return row!;
}

export async function applyAccountUpdate(
  x: Executor,
  budgetId: string,
  body: Partial<AccountPayload> & { id: string },
) {
  const { id, ...fields } = body;
  const [row] = await x
    .update(s.accounts)
    .set(fields)
    .where(and(eq(s.accounts.id, id), eq(s.accounts.budgetId, budgetId)))
    .returning();
  return row ?? NOT_FOUND;
}

export async function applyAccountDelete(x: Executor, budgetId: string, id: string): Promise<void> {
  await x.delete(s.accounts).where(and(eq(s.accounts.id, id), eq(s.accounts.budgetId, budgetId)));
}

/* ── Envelope groups ────────────────────────────────────────────────── */

export async function applyGroupCreate(
  x: Executor,
  budgetId: string,
  body: GroupPayload & { id?: string },
) {
  const { id, ...fields } = body;
  const [row] = await x
    .insert(s.envelopeGroups)
    .values({ ...(id ? { id } : {}), budgetId, ...fields })
    .returning();
  return row!;
}

export async function applyGroupUpdate(
  x: Executor,
  budgetId: string,
  body: Partial<GroupPayload> & { id: string },
) {
  const { id, ...fields } = body;
  const [row] = await x
    .update(s.envelopeGroups)
    .set(fields)
    .where(and(eq(s.envelopeGroups.id, id), eq(s.envelopeGroups.budgetId, budgetId)))
    .returning();
  return row ?? NOT_FOUND;
}

export async function applyGroupDelete(x: Executor, budgetId: string, id: string): Promise<void> {
  await x
    .delete(s.envelopeGroups)
    .where(and(eq(s.envelopeGroups.id, id), eq(s.envelopeGroups.budgetId, budgetId)));
}

/* ── Envelopes ──────────────────────────────────────────────────────── */

export async function applyEnvelopeCreate(
  x: Executor,
  budgetId: string,
  body: EnvelopePayload & { id?: string },
) {
  const { id, ...fields } = body;
  const [row] = await x
    .insert(s.envelopes)
    .values({ ...(id ? { id } : {}), budgetId, ...fields })
    .returning();
  return row!;
}

export async function applyEnvelopeUpdate(
  x: Executor,
  budgetId: string,
  body: Partial<EnvelopePayload> & { id: string },
) {
  const { id, ...fields } = body;
  const [row] = await x
    .update(s.envelopes)
    .set(fields)
    .where(and(eq(s.envelopes.id, id), eq(s.envelopes.budgetId, budgetId)))
    .returning();
  return row ?? NOT_FOUND;
}

export async function applyEnvelopeDelete(x: Executor, budgetId: string, id: string): Promise<void> {
  await x.delete(s.envelopes).where(and(eq(s.envelopes.id, id), eq(s.envelopes.budgetId, budgetId)));
}

/* ── Budget data wipe ───────────────────────────────────────────────── */

/** Wipes ALL budget data (leaves the budgets row — stable id/currency). */
export async function wipeBudgetData(x: Executor, budgetId: string): Promise<void> {
  // FK-safe order (children before parents; txn_items via cascade).
  await x.delete(s.transactions).where(eq(s.transactions.budgetId, budgetId));
  await x.delete(s.allocations).where(eq(s.allocations.budgetId, budgetId));
  await x.delete(s.recurrences).where(eq(s.recurrences.budgetId, budgetId));
  await x.delete(s.envelopes).where(eq(s.envelopes.budgetId, budgetId));
  await x.delete(s.envelopeGroups).where(eq(s.envelopeGroups.budgetId, budgetId));
  await x.delete(s.categories).where(eq(s.categories.budgetId, budgetId));
  await x.delete(s.places).where(eq(s.places.budgetId, budgetId));
  await x.delete(s.accounts).where(eq(s.accounts.budgetId, budgetId));
}

/* ── Categories / places / recurrence ───────────────────────────────── */

/**
 * Plain insert. Name-based dedupe is NOT here — REST does the lookup in the
 * handler (preserving today's behavior), the sync client dedupes in the local mirror.
 */
export async function applyCategoryCreate(
  x: Executor,
  budgetId: string,
  body: { id?: string; name: string },
) {
  const [row] = await x
    .insert(s.categories)
    .values({ ...(body.id ? { id: body.id } : {}), budgetId, name: body.name })
    .returning();
  return row!;
}

export async function applyPlaceCreate(
  x: Executor,
  budgetId: string,
  body: { id?: string; name: string },
) {
  const [row] = await x
    .insert(s.places)
    .values({ ...(body.id ? { id: body.id } : {}), budgetId, name: body.name })
    .returning();
  return row!;
}

export async function applyRecurrenceCreate(
  x: Executor,
  budgetId: string,
  body: RecurrencePayload & { id?: string },
) {
  const [row] = await x
    .insert(s.recurrences)
    .values({
      ...(body.id ? { id: body.id } : {}),
      budgetId,
      rule: body.rule,
      startDate: body.startDate,
      endDate: body.endDate ?? null,
      pausedUntil: body.pausedUntil ?? null,
    })
    .returning();
  return row!;
}

/**
 * Partial update of a rule (pause/resume, end, cadence change). Unknown id
 * → no-op (parity with shared/applyOp — updating a nonexistent rule is not a
 * domain refusal; a delete may have arrived from another device earlier).
 */
export async function applyRecurrenceUpdate(
  x: Executor,
  budgetId: string,
  body: Partial<RecurrencePayload> & { id: string },
): Promise<void> {
  const { id, ...fields } = body;
  if (Object.keys(fields).length === 0) return; // empty patch — no-op (drizzle .set({}) throws)
  await x
    .update(s.recurrences)
    .set(fields)
    .where(and(eq(s.recurrences.id, id), eq(s.recurrences.budgetId, budgetId)));
}

/**
 * Idempotent rule delete. FK transactions.recurrence_id = ON DELETE SET
 * NULL (schema.ts) — transactions (including historical ones) STAY, they only
 * lose the reference; SET NULL is an UPDATE on transactions, so the `changes`
 * trigger (migration 0004) logs it for delta-sync. Parity with shared/applyOp.
 */
export async function applyRecurrenceDelete(x: Executor, budgetId: string, id: string): Promise<void> {
  await x
    .delete(s.recurrences)
    .where(and(eq(s.recurrences.id, id), eq(s.recurrences.budgetId, budgetId)));
}
