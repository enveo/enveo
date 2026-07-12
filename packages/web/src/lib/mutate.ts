/**
 * Local writes facade `local.*` — the only path for UI domain mutations.
 *
 * enqueue(kind, payload):
 * 1. zod validation (opSchemas) — loud fail at WRITE time, not in the queue,
 * 2. store.applyLocal(op) — mirror + version++ synchronously (UI immediately),
 * 3. outbox.add(op) — memory now; IDB + mirror persist on the serial
 *    chain (outbox order preserved; a crash is healed by the boot replay),
 * 4. sync.poke() — debounced push.
 *
 * All functions return SYNCHRONOUSLY (an id / an optimistic entity) —
 * durability and network run in the background.
 */
import {
  opSchemas,
  type Account,
  type AccountPayload,
  type AllocPayload,
  type Category,
  type Envelope,
  type EnvelopeGroup,
  type EnvelopePayload,
  type GroupPayload,
  type OpKind,
  type OpPayload,
  type Place,
  type RecurrencePayload,
  type SyncOp,
  type Transaction,
  type TxnPayload,
} from "@enveo/shared";
import * as outbox from "./outbox";
import { store } from "./store";
import { poke } from "./sync";

function enqueue<K extends OpKind>(kind: K, payload: OpPayload<K>): void {
  // safeParse: validation is a safety net (a call-site bug). Loud fail
  // in the console, but we do NOT throw — an error from an onClick handler isn't caught
  // by an error boundary and would jam the UI (e.g. the "Duplicate" sheet). We apply nothing on
  // rejection (no partial state). The real fix for an orphaned split =
  // sanitization in duplicateTxn; this is the last line of defense.
  const schema = opSchemas[kind] as unknown as { safeParse: (v: unknown) => { success: boolean; data?: OpPayload<K>; error?: unknown } };
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    console.error(`local.${kind}: payload rejected (call-site bug) — skipping`, parsed.error, payload);
    return;
  }
  const op: SyncOp = { opId: crypto.randomUUID(), kind, payload: parsed.data! };
  store.applyLocal(op);
  outbox.add(op);
  poke();
}

const newId = (): string => crypto.randomUUID();

/** The mirror must exist (mutations are possible only after the replica boots). */
function ledger() {
  const l = store.getLedger();
  if (!l) throw new Error("local.*: replica not booted yet");
  return l;
}

const findByName = <T extends { name: string }>(rows: T[], name: string): T | undefined =>
  rows.find((r) => r.name.toLowerCase() === name.toLowerCase());

/* ── Transactions ──────────────────────────────────────────────────────── */

function createTxn(payload: TxnPayload): string {
  const id = newId();
  // the client assigns createdAt — a stable list order within a day
  enqueue("txn.create", { ...payload, id, createdAt: new Date().toISOString() });
  return id;
}

function updateTxn(id: string, payload: TxnPayload): void {
  enqueue("txn.update", { ...payload, id });
}

function deleteTxn(id: string): void {
  enqueue("txn.delete", { id });
}

/**
 * A transaction copy built ON THE CLIENT — semantics 1:1 with the old
 * POST /transactions/:id/duplicate: today's date, `tag: null` (the copy doesn't
 * inherit the import key), `recurrenceId: null`, items without ids.
 *
 * D7: a split "orphaned" by envelope.delete (items no longer sum to the parent
 * amount after the envelope removal) must NOT pass opSchemas["txn.create"]
 * (Σ items = amount). We then duplicate it as a REGULAR transaction (no items,
 * envelopeId/categoryId = null, amount unchanged), so the validation doesn't throw
 * and the "Duplicate" sheet doesn't jam. A balanced split is copied verbatim.
 */
function duplicateTxn(t: Transaction): string {
  const base = {
    type: t.type,
    accountId: t.accountId,
    toAccountId: t.toAccountId,
    amount: t.amount,
    date: new Date().toISOString().slice(0, 10),
    confirmed: t.confirmed,
    isRefund: t.isRefund,
    placeId: t.placeId,
    name: t.name,
    note: t.note,
    tag: null,
    planned: t.planned,
    recurrenceId: null,
  } as const;
  const itemsSum = t.items.reduce((s, i) => s + i.amount, 0);
  if (t.items.length > 0 && itemsSum === t.amount) {
    // balanced split — verbatim copy (the parent has envelopeId/categoryId null anyway)
    return createTxn({
      ...base,
      envelopeId: null,
      categoryId: null,
      items: t.items.map((i) => ({ envelopeId: i.envelopeId, categoryId: i.categoryId, amount: i.amount })),
    });
  }
  if (t.items.length > 0) {
    // orphaned split (Σ items ≠ amount) — a regular transaction without items
    return createTxn({ ...base, envelopeId: null, categoryId: null });
  }
  // regular transaction — keep the envelope/category
  return createTxn({ ...base, envelopeId: t.envelopeId, categoryId: t.categoryId });
}

/* ── Allocations ────────────────────────────────────────────────────────── */

function setAllocation(payload: AllocPayload): void {
  enqueue("alloc.set", payload);
}

/* ── Accounts / groups / envelopes ─────────────────────────────────────── */

function createAccount(fields: AccountPayload): Account {
  const id = newId();
  enqueue("account.create", { ...fields, id });
  return ledger().accounts.find((a) => a.id === id)!;
}

function updateAccount(id: string, partial: Partial<AccountPayload>): void {
  enqueue("account.update", { ...partial, id });
}

function deleteAccount(id: string): void {
  enqueue("account.delete", { id });
}

function createGroup(name: string): EnvelopeGroup {
  const id = newId();
  enqueue("group.create", { id, name });
  return ledger().groups.find((g) => g.id === id)!;
}

function updateGroup(id: string, partial: Partial<GroupPayload>): void {
  enqueue("group.update", { ...partial, id });
}

function deleteGroup(id: string): void {
  enqueue("group.delete", { id });
}

function createEnvelope(fields: EnvelopePayload): Envelope {
  const id = newId();
  enqueue("envelope.create", { ...fields, id });
  return ledger().envelopes.find((e) => e.id === id)!;
}

function updateEnvelope(id: string, partial: Partial<EnvelopePayload>): void {
  enqueue("envelope.update", { ...partial, id });
}

function deleteEnvelope(id: string): void {
  enqueue("envelope.delete", { id });
}

/* ── Dictionaries (name dedupe is done by the CLIENT — a mirror lookup) ──────── */

function createCategory(name: string): Category {
  const existing = findByName(ledger().categories, name);
  if (existing) return existing;
  const id = newId();
  enqueue("category.create", { id, name });
  return ledger().categories.find((c) => c.id === id)!;
}

function createPlace(name: string): Place {
  const existing = findByName(ledger().places, name);
  if (existing) return existing;
  const id = newId();
  enqueue("place.create", { id, name });
  return ledger().places.find((p) => p.id === id)!;
}

/* ── Budget (metadata, e.g. currency) ───────────────────────────────────── */

function updateBudget(id: string, currency: string): void {
  enqueue("budget.update", { id, currency });
}

/* ── Recurrence ─────────────────────────────────────────────────────── */

function createRecurrence(payload: RecurrencePayload): string {
  const id = newId();
  enqueue("recurrence.create", { ...payload, id });
  return id;
}

function updateRecurrence(id: string, patch: Partial<RecurrencePayload>): void {
  enqueue("recurrence.update", { ...patch, id });
}

/** The server nulls transactions.recurrence_id (FK SET NULL) — applyOp mirrors that. */
function deleteRecurrence(id: string): void {
  enqueue("recurrence.delete", { id });
}

export const local = {
  createTxn,
  updateTxn,
  deleteTxn,
  duplicateTxn,
  setAllocation,
  createAccount,
  updateAccount,
  deleteAccount,
  createGroup,
  updateGroup,
  deleteGroup,
  createEnvelope,
  updateEnvelope,
  deleteEnvelope,
  createCategory,
  createPlace,
  createRecurrence,
  updateRecurrence,
  deleteRecurrence,
  updateBudget,
};

// Dev-only: lets e2e verification run local mutations from the console (no UI clicking).
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__mutate = local;
}
