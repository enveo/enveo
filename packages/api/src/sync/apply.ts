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
import {
  type AccountPayload,
  type AllocPayload,
  type BudgetPreferencesPatch,
  type ClientLedgerInput,
  type EnvelopePayload,
  type GroupPayload,
  reconcileBudgetPreferences,
  type TxnPayload,
} from "@enveo/shared";
import { and, eq } from "drizzle-orm";
import type { DbExecutor } from "../db/client";
import * as s from "../db/schema";

/** Legacy alias — the canonical type now lives in db/client.ts (DbExecutor/DbTransaction). */
export type Executor = DbExecutor;

export const NOT_FOUND = "not_found" as const;
export type NotFound = typeof NOT_FOUND;

/* ── Budget-scope guards (multi-tenant write protection) ────────────── */

/** Multi-tenant write guard: every FK taken from a request body must belong to
 *  the caller's budget. Missing check = cross-budget write (IDOR). A push op
 *  hitting this gets `status: "rejected"` (deterministic domain refusal). */
export class ScopeViolation extends Error {
  constructor() {
    super("foreign_ref");
  }
}

type FkBody = {
  accountId?: string | null;
  toAccountId?: string | null;
  envelopeId?: string | null;
  categoryId?: string | null;
  placeId?: string | null;
  /** envelopes' parent group (NOT NULL, ON DELETE CASCADE) */
  groupId?: string | null;
};

type FkTable = "accounts" | "envelopes" | "categories" | "places" | "envelope_groups";

/** Pure part: which (table, id) pairs of a body need an ownership check. */
export function collectFkChecks(b: FkBody): { table: FkTable; id: string }[] {
  const out: { table: FkTable; id: string }[] = [];
  if (b.accountId) out.push({ table: "accounts", id: b.accountId });
  if (b.toAccountId) out.push({ table: "accounts", id: b.toAccountId });
  if (b.envelopeId) out.push({ table: "envelopes", id: b.envelopeId });
  if (b.categoryId) out.push({ table: "categories", id: b.categoryId });
  if (b.placeId) out.push({ table: "places", id: b.placeId });
  if (b.groupId) out.push({ table: "envelope_groups", id: b.groupId });
  return out;
}

/** Throws `ScopeViolation` when any non-null id does not belong to `budgetId`. */
export async function assertBudgetFks(x: Executor, budgetId: string, b: FkBody): Promise<void> {
  const tables = {
    accounts: s.accounts,
    envelopes: s.envelopes,
    categories: s.categories,
    places: s.places,
    envelope_groups: s.envelopeGroups,
  } as const;
  for (const chk of collectFkChecks(b)) {
    const t = tables[chk.table];
    const rows = await x
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.id, chk.id), eq(t.budgetId, budgetId)))
      .limit(1);
    if (rows.length === 0) throw new ScopeViolation();
  }
}

/**
 * Scope guard for full-ledger restore (`/sync/replace`, e2ee disable): entity
 * ids of a ClientLedger are preserved on insert and the budget's previous rows
 * are wiped first, so every FK inside the payload must reference an id carried
 * by the payload ITSELF. A UUID pointing at another tenant's row would
 * otherwise persist a cross-budget reference (and double as an id-existence
 * oracle). Pure — returns a description of the first foreign ref, or null.
 *
 * Allocations are deliberately NOT checked here: insertLedger filters them to
 * own envelopes (silent drop — old backups may carry stale allocation rows).
 */
export function findForeignLedgerRef(ledger: ClientLedgerInput): string | null {
  const ids = (rows: { id: string }[]) => new Set(rows.map((r) => r.id));
  const accounts = ids(ledger.accounts);
  const groups = ids(ledger.groups);
  const envelopes = ids(ledger.envelopes);
  const categories = ids(ledger.categories);
  const places = ids(ledger.places);
  for (const e of ledger.envelopes) {
    if (!groups.has(e.groupId)) return `envelopes[${e.id}].groupId`;
  }
  for (const t of ledger.transactions) {
    if (!accounts.has(t.accountId)) return `transactions[${t.id}].accountId`;
    if (t.toAccountId && !accounts.has(t.toAccountId)) return `transactions[${t.id}].toAccountId`;
    if (t.envelopeId && !envelopes.has(t.envelopeId)) return `transactions[${t.id}].envelopeId`;
    if (t.placeId && !places.has(t.placeId)) return `transactions[${t.id}].placeId`;
    if (t.categoryId && !categories.has(t.categoryId)) return `transactions[${t.id}].categoryId`;
    for (const it of t.items) {
      if (!envelopes.has(it.envelopeId)) return `transactions[${t.id}].items.envelopeId`;
      if (it.categoryId && !categories.has(it.categoryId)) return `transactions[${t.id}].items.categoryId`;
    }
  }
  return null;
}

/* ── Budget (single-row entity — display currency only) ─────────────── */

export async function applyBudgetUpdate(x: Executor, budgetId: string, currency: string) {
  const [row] = await x.update(s.budgets).set({ currency }).where(eq(s.budgets.id, budgetId)).returning();
  return row ?? NOT_FOUND;
}

/** Row-locked field merge: concurrent disjoint patches preserve both named fields. */
export async function applyBudgetPreferencesUpdate(x: Executor, budgetId: string, patch: BudgetPreferencesPatch): Promise<typeof NOT_FOUND | undefined> {
  const [row] = await x.select({ preferences: s.budgets.preferences }).from(s.budgets).where(eq(s.budgets.id, budgetId)).for("update");
  if (!row) return NOT_FOUND;
  const preferences = reconcileBudgetPreferences({ ...reconcileBudgetPreferences(row.preferences), ...patch });
  await x.update(s.budgets).set({ preferences }).where(eq(s.budgets.id, budgetId));
}

/* ── Transactions ───────────────────────────────────────────────────── */

export async function applyTxnCreate(x: Executor, budgetId: string, body: TxnPayload & { id?: string }) {
  await assertBudgetFks(x, budgetId, body);
  const items = body.items ?? [];
  for (const i of items) {
    await assertBudgetFks(x, budgetId, { envelopeId: i.envelopeId, categoryId: i.categoryId });
  }
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
      isRefund: body.isRefund ?? false,
      envelopeId: body.type === "transfer" ? null : envelopeId,
      placeId: body.placeId ?? null,
      categoryId: items.length > 0 ? null : (body.categoryId ?? null),
      name: body.name ?? null,
      note: body.note ?? null,
      tag: body.tag ?? null,
      sourceRef: body.sourceRef ?? null,
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
export async function applyTxnUpdate(x: Executor, budgetId: string, body: TxnPayload & { id: string }) {
  await assertBudgetFks(x, budgetId, body);
  const items = body.items ?? [];
  for (const i of items) {
    await assertBudgetFks(x, budgetId, { envelopeId: i.envelopeId, categoryId: i.categoryId });
  }
  const [row] = await x
    .update(s.transactions)
    .set({
      type: body.type,
      accountId: body.accountId,
      toAccountId: body.type === "transfer" ? (body.toAccountId ?? null) : null,
      amount: body.amount,
      date: body.date,
      isRefund: body.isRefund ?? false,
      envelopeId: body.type === "transfer" ? null : items.length > 0 ? null : (body.envelopeId ?? null),
      placeId: body.placeId ?? null,
      categoryId: items.length > 0 ? null : (body.categoryId ?? null),
      name: body.name ?? null,
      note: body.note ?? null,
      // tag is preserved when the update does not send it (UI edits don't know import tags)
      ...(body.tag !== undefined ? { tag: body.tag } : {}),
      ...(body.sourceRef !== undefined ? { sourceRef: body.sourceRef } : {}),
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
  await x.delete(s.transactions).where(and(eq(s.transactions.id, id), eq(s.transactions.budgetId, budgetId)));
}

/* ── Allocations (natural key envelopeId+month, upsert) ─────────────── */

export async function applyAllocSet(x: Executor, budgetId: string, body: AllocPayload) {
  // IDOR guard: the (envelopeId, month) upsert would otherwise hijack another
  // budget's allocation row via the global unique conflict.
  await assertBudgetFks(x, budgetId, { envelopeId: body.envelopeId });
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

export async function applyAccountCreate(x: Executor, budgetId: string, body: AccountPayload & { id?: string }) {
  const { id, ...fields } = body;
  const [row] = await x
    .insert(s.accounts)
    .values({ ...(id ? { id } : {}), budgetId, ...fields })
    .returning();
  return row!;
}

export async function applyAccountUpdate(x: Executor, budgetId: string, body: Partial<AccountPayload> & { id: string }) {
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

export async function applyGroupCreate(x: Executor, budgetId: string, body: GroupPayload & { id?: string }) {
  const { id, ...fields } = body;
  const [row] = await x
    .insert(s.envelopeGroups)
    .values({ ...(id ? { id } : {}), budgetId, ...fields })
    .returning();
  return row!;
}

export async function applyGroupUpdate(x: Executor, budgetId: string, body: Partial<GroupPayload> & { id: string }) {
  const { id, ...fields } = body;
  const [row] = await x
    .update(s.envelopeGroups)
    .set(fields)
    .where(and(eq(s.envelopeGroups.id, id), eq(s.envelopeGroups.budgetId, budgetId)))
    .returning();
  return row ?? NOT_FOUND;
}

export async function applyGroupDelete(x: Executor, budgetId: string, id: string): Promise<void> {
  await x.delete(s.envelopeGroups).where(and(eq(s.envelopeGroups.id, id), eq(s.envelopeGroups.budgetId, budgetId)));
}

/* ── Envelopes ──────────────────────────────────────────────────────── */

export async function applyEnvelopeCreate(x: Executor, budgetId: string, body: EnvelopePayload & { id?: string }) {
  // groupId is a body FK (NOT NULL, ON DELETE CASCADE): a foreign group would
  // attach the envelope to ANOTHER budget's group — the victim's group delete
  // would then cascade into this budget. Same guard as every other body FK.
  await assertBudgetFks(x, budgetId, { groupId: body.groupId });
  const { id, ...fields } = body;
  const [row] = await x
    .insert(s.envelopes)
    .values({ ...(id ? { id } : {}), budgetId, ...fields })
    .returning();
  return row!;
}

export async function applyEnvelopeUpdate(x: Executor, budgetId: string, body: Partial<EnvelopePayload> & { id: string }) {
  await assertBudgetFks(x, budgetId, { groupId: body.groupId }); // no-op when the patch omits groupId
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
  await x.delete(s.envelopes).where(eq(s.envelopes.budgetId, budgetId));
  await x.delete(s.envelopeGroups).where(eq(s.envelopeGroups.budgetId, budgetId));
  await x.delete(s.categories).where(eq(s.categories.budgetId, budgetId));
  await x.delete(s.places).where(eq(s.places.budgetId, budgetId));
  await x.delete(s.accounts).where(eq(s.accounts.budgetId, budgetId));
}

/* ── Categories / places ──────────────────────────────────────────────── */

/**
 * Plain insert. Name-based dedupe is NOT here — REST does the lookup in the
 * handler (preserving today's behavior), the sync client dedupes in the local mirror.
 */
export async function applyCategoryCreate(x: Executor, budgetId: string, body: { id?: string; name: string }) {
  const [row] = await x
    .insert(s.categories)
    .values({ ...(body.id ? { id: body.id } : {}), budgetId, name: body.name })
    .returning();
  return row!;
}

export async function applyPlaceCreate(x: Executor, budgetId: string, body: { id?: string; name: string }) {
  const [row] = await x
    .insert(s.places)
    .values({ ...(body.id ? { id: body.id } : {}), budgetId, name: body.name })
    .returning();
  return row!;
}
