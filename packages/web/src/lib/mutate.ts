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
  type Account,
  type AccountPayload,
  type AllocPayload,
  type BudgetPreferencesPatch,
  budgetPreferencesPatchSchema,
  type Category,
  type ClientLedger,
  captureAllocationFlow,
  type Envelope,
  type EnvelopeGroup,
  type EnvelopePayload,
  type GroupPayload,
  manualAllocationForDisplayedTotal,
  type OpKind,
  type OpPayload,
  opSchemas,
  type Place,
  resolveAllocationFlow,
  type SyncOp,
  type Transaction,
  type TxnPayload,
} from "@enveo/shared";
import * as outbox from "./outbox";
import { store } from "./store";
// `poke` is imported from its OWN module rather than through the `./sync` facade. The facade
// re-exports the whole engine (boot included), so going through it made mutate.ts → sync →
// sync/boot → mutate.ts a cycle, which sync/boot.ts then had to break with a dynamic
// `import("../mutate")` — an import that could never split a chunk (mutate.ts is statically
// imported by half the UI) and that Vite warned about on every build. One authoritative module
// path per dependency: cycle-free, no warning, same runtime behaviour.
import { poke } from "./sync/cycle";

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

const findByName = <T extends { name: string }>(rows: T[], name: string): T | undefined => rows.find((r) => r.name.toLowerCase() === name.toLowerCase());

/* ── Transactions ──────────────────────────────────────────────────────── */

function withPreparedAllocationFlow(payload: TxnPayload, flow: Pick<Transaction, "allocationFromEnvelopeId" | "allocationToEnvelopeId">): TxnPayload {
  // An automatic income credit replaces the legacy direct envelope credit.
  return { ...payload, ...flow, envelopeId: payload.type === "income" && flow.allocationToEnvelopeId ? null : payload.envelopeId };
}

/**
 * Per-transaction escape hatch for a TRANSFER between accounts with linked envelopes: the
 * envelope leg is skipped and the transaction stores no flow, so it moves account balances
 * only (the money was already assigned by hand). The stored NULLs are the same shape an
 * unlinked account produces, so applyOp, the server and the journal need nothing new —
 * and `resolveAllocationFlow` keeps them across an edit that does not reroute.
 */
export interface TxnFlowOptions {
  /**
   * TRI-STATE on purpose. `undefined` (every caller that has no such switch) keeps the historical
   * behaviour — capture on create, PRESERVE a stored flow on an update that does not reroute.
   * `true` stores no flow. `false` means the human just re-enabled the leg on a transaction saved
   * without one, so the current links must be captured — preserving would silently do nothing.
   */
  skipAutomaticAllocation?: boolean;
}

const NO_FLOW = { allocationFromEnvelopeId: null, allocationToEnvelopeId: null } as const;

/** Captures the account-linked allocation flow for a new local transaction. */
export function prepareTxnCreate(ledger: ClientLedger, payload: TxnPayload, options?: TxnFlowOptions): TxnPayload {
  const flow = options?.skipAutomaticAllocation ? NO_FLOW : captureAllocationFlow(ledger.accounts, payload);
  return withPreparedAllocationFlow(payload, flow);
}

/** Preserves a stored flow for an unchanged route or captures the current links after rerouting. */
export function prepareTxnUpdate(ledger: ClientLedger, id: string, payload: TxnPayload, options?: TxnFlowOptions): TxnPayload {
  const previous = ledger.transactions.find((transaction) => transaction.id === id);
  if (!previous) throw new Error(`local.updateTxn: transaction ${id} not found`);
  const flow =
    options?.skipAutomaticAllocation === true
      ? NO_FLOW
      : options?.skipAutomaticAllocation === false
        ? captureAllocationFlow(ledger.accounts, payload)
        : resolveAllocationFlow(ledger.accounts, payload, previous);
  return withPreparedAllocationFlow(payload, flow);
}

function createTxn(payload: TxnPayload, options?: TxnFlowOptions): string {
  const id = newId();
  // the client assigns createdAt — a stable list order within a day
  enqueue("txn.create", { ...prepareTxnCreate(ledger(), payload, options), id, createdAt: new Date().toISOString() });
  return id;
}

function updateTxn(id: string, payload: TxnPayload, options?: TxnFlowOptions): void {
  enqueue("txn.update", { ...prepareTxnUpdate(ledger(), id, payload, options), id });
}

function deleteTxn(id: string): void {
  enqueue("txn.delete", { id });
}

/**
 * A stored transaction mapped to a full, faithful TxnPayload — every persisted
 * field verbatim (split items included, item ids stripped — txnItemPayload has
 * no id). The ONE field list `duplicateTxn` builds on, so a new Transaction field
 * can't silently fall out of sync with it.
 */
export function txnToPayload(t: Transaction): TxnPayload {
  return {
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
    sourceRef: t.sourceRef,
    allocationFromEnvelopeId: t.allocationFromEnvelopeId,
    allocationToEnvelopeId: t.allocationToEnvelopeId,
    items: t.items.map((i) => ({ envelopeId: i.envelopeId, categoryId: i.categoryId, amount: i.amount })),
  };
}

/**
 * A transaction copy built ON THE CLIENT: today's date, `tag: null` (the copy
 * doesn't inherit the import key), items without ids. The retired REST duplicate
 * route refuses writes so central local preparation always stamps current links.
 *
 * D7: a split "orphaned" by envelope.delete (items no longer sum to the parent
 * amount after the envelope removal) must NOT pass opSchemas["txn.create"]
 * (Σ items = amount). We then duplicate it as a REGULAR transaction (no items,
 * envelopeId/categoryId = null, amount unchanged), so the validation doesn't throw
 * and the "Duplicate" sheet doesn't jam. A balanced split is copied verbatim.
 */
export function txnToDuplicatePayload(t: Transaction, today: string): TxnPayload {
  const base = {
    ...txnToPayload(t),
    date: today,
    tag: null,
    sourceRef: null,
    allocationFromEnvelopeId: null,
    allocationToEnvelopeId: null,
  };
  const itemsSum = t.items.reduce((s, i) => s + i.amount, 0);
  if (t.items.length > 0 && itemsSum === t.amount) {
    // balanced split — verbatim copy (the parent has envelopeId/categoryId null anyway;
    // base.items is already the id-stripped mapping from txnToPayload)
    return { ...base, envelopeId: null, categoryId: null };
  }
  if (t.items.length > 0) {
    // orphaned split (Σ items ≠ amount) — a regular transaction without items
    return { ...base, envelopeId: null, categoryId: null, items: undefined };
  }
  // regular transaction — keep the envelope/category (base.items is already [] here)
  return { ...base, envelopeId: t.envelopeId, categoryId: t.categoryId };
}

function duplicateTxn(t: Transaction): string {
  return createTxn(txnToDuplicatePayload(t, new Date().toISOString().slice(0, 10)));
}

/* ── Allocations ────────────────────────────────────────────────────────── */

/** Converts a user-visible Added total into the manual allocation stored in the ledger. */
export function prepareDisplayedAllocation(ledger: ClientLedger, payload: AllocPayload): AllocPayload {
  return { ...payload, amount: manualAllocationForDisplayedTotal(ledger.transactions, payload.envelopeId, payload.month, payload.amount) };
}

function setDisplayedAllocation(payload: AllocPayload): void {
  enqueue("alloc.set", prepareDisplayedAllocation(ledger(), payload));
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

/* ── Dictionary upkeep ──────────────────────────────────────────────────
 * `archived` hides an entry from ENTRY only (suggestions, pickers); every
 * transaction that carries it keeps showing it, here and in reports.
 * Deleting is offered only at zero usages — and `applyOp`/the server still
 * degrade it to an archive if a reference appeared in the meantime. */

function setCategoryArchived(id: string, archived: boolean): void {
  enqueue("category.update", { id, archived });
}

function setPlaceArchived(id: string, archived: boolean): void {
  enqueue("place.update", { id, archived });
}

function deleteCategory(id: string): void {
  enqueue("category.delete", { id });
}

function deletePlace(id: string): void {
  enqueue("place.delete", { id });
}

/* ── Budget (metadata, e.g. currency) ───────────────────────────────────── */

function updateBudget(id: string, currency: string): void {
  enqueue("budget.update", { id, currency });
}

function updateBudgetPreferences(id: string, patch: BudgetPreferencesPatch): void {
  enqueue("budget.preferences.update", { id, patch: budgetPreferencesPatchSchema.parse(patch) });
}

export const local = {
  createTxn,
  updateTxn,
  deleteTxn,
  duplicateTxn,
  setDisplayedAllocation,
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
  setCategoryArchived,
  setPlaceArchived,
  deleteCategory,
  deletePlace,
  updateBudget,
  updateBudgetPreferences,
};

// Dev-only: lets e2e verification run local mutations from the console (no UI clicking).
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__mutate = local;
}
