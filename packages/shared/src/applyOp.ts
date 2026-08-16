/**
 * Pure sync-op reducers — local mirror of server writes.
 *
 * `applyOp(ledger, op)` returns a NEW ledger (fresh arrays for the affected
 * collections, the input is never mutated). Semantics must faithfully
 * mirror `packages/api/src/sync/apply.ts` + FK cascades from the schema:
 *
 * - txn.create/update: normalization like insertTxn (transfer ⇒ envelopeId null,
 *   toAccountId kept, categoryId stays — the server clears categoryId ONLY
 *   for splits; items>0 ⇒ parent envelopeId/categoryId null), defaults
 *   isRefund=false, nullable ⇒ null.
 *   Update = full field replacement (LWW), items delete+reinsert,
 *   `createdAt` is NEVER changed (server PATCH does not touch created_at).
 * - update/delete on a missing id ⇒ no-op (server: rejected / delete
 *   idempotent; divergence is reconciled by resync).
 * - create on an EXISTING id ⇒ no-op (server: PK violation → rejected +
 *   rollback, or the sync_ops guard → "duplicate" without re-application —
 *   state never gets a second row). This makes replaying pending outbox
 *   ops onto a fresh snapshot (fullResync) idempotent.
 * - account.delete: the cascade removes ENTIRE transactions with accountId OR
 *   toAccountId (both FKs are ON DELETE CASCADE on the row).
 * - envelope.delete: removes the envelope's allocations (CASCADE),
 *   `envelopeId: null` on transactions (SET NULL) and removes split items for
 *   that envelope (txn_items CASCADE; parent amount unchanged).
 * - group.delete: envelope.delete effects for all envelopes of the group
 *   (CASCADE), then group removal.
 * - alloc.set: upsert by natural key (envelopeId, month); envelope missing
 *   from the ledger ⇒ NO-OP — parity with the server FK (allocations.envelope_id
 *   NOT NULL REFERENCES envelopes; the server would reject the INSERT → rollback).
 *   Without this, replaying outbox ops (fullResync) over a snapshot in which
 *   the envelope fell to a group/envelope.delete cascade would leave an orphan
 *   allocation (mirror drift + a needless dead-letter). The guard keeps
 *   replay idempotent.
 * - an op kind not in the switch (retired, or from a NEWER app version) ⇒
 *   NO-OP — an IDB outbox can still hold ops queued by an older/newer
 *   client; the server is authoritative and dead-letters/ignores them too.
 *
 * Local ids are synthetic and deterministic (no crypto/Date):
 * computeBudgetState does not read allocation or item ids — canonical ids
 * arrive via pull/snapshot.
 */
import type { OpPayload, SyncOp } from "./ops";
import { reconcileBudgetPreferences } from "./preferences";
import type { Account, Allocation, Category, ClientLedger, Envelope, EnvelopeGroup, Place, Transaction, TxnItem } from "./types";

/**
 * Sentinel for when a `txn.create` op carries no `createdAt` (the client is
 * SUPPOSED to set it; REST without createdAt gets the DB default `now()`,
 * which a pure reducer cannot reproduce without a clock). Sorts to the end of
 * the day (oldest) — the canonical value will arrive via pull.
 */
export const MISSING_CREATED_AT = "1970-01-01T00:00:00.000Z";

const localItemId = (txnId: string, index: number) => `item-local:${txnId}:${index}`;
const localAllocId = (envelopeId: string, month: string) => `alloc-local:${envelopeId}:${month}`;

const buildItems = (txnId: string, items: OpPayload<"txn.create">["items"]): TxnItem[] =>
  (items ?? []).map((i, idx) => ({
    id: localItemId(txnId, idx),
    envelopeId: i.envelopeId,
    categoryId: i.categoryId ?? null,
    amount: i.amount,
  }));

/** Mirror of `applyTxnCreate` (normalization + DB defaults). */
function txnFromCreate(p: OpPayload<"txn.create">): Transaction {
  const items = p.items ?? [];
  const envelopeId = items.length > 0 ? null : (p.envelopeId ?? null);
  return {
    id: p.id,
    type: p.type,
    accountId: p.accountId,
    toAccountId: p.type === "transfer" ? (p.toAccountId ?? null) : null,
    amount: p.amount,
    date: p.date,
    isRefund: p.isRefund ?? false,
    envelopeId: p.type === "transfer" ? null : envelopeId,
    placeId: p.placeId ?? null,
    categoryId: items.length > 0 ? null : (p.categoryId ?? null),
    name: p.name ?? null,
    note: p.note ?? null,
    tag: p.tag ?? null,
    sourceRef: p.sourceRef ?? null,
    allocationFromEnvelopeId: p.allocationFromEnvelopeId ?? null,
    allocationToEnvelopeId: p.allocationToEnvelopeId ?? null,
    items: buildItems(p.id, p.items),
    createdAt: p.createdAt ?? MISSING_CREATED_AT,
  };
}

/** Mirror of `applyTxnUpdate`: full replacement of the SAME field set as PATCH. */
function txnFromUpdate(prev: Transaction, p: OpPayload<"txn.update">): Transaction {
  const items = p.items ?? [];
  return {
    id: prev.id,
    type: p.type,
    accountId: p.accountId,
    toAccountId: p.type === "transfer" ? (p.toAccountId ?? null) : null,
    amount: p.amount,
    date: p.date,
    isRefund: p.isRefund ?? false,
    envelopeId: p.type === "transfer" ? null : items.length > 0 ? null : (p.envelopeId ?? null),
    placeId: p.placeId ?? null,
    categoryId: items.length > 0 ? null : (p.categoryId ?? null),
    name: p.name ?? null,
    note: p.note ?? null,
    // keep tag when the update does not send it (UI edits don't know import tags)
    tag: p.tag !== undefined ? p.tag : prev.tag,
    // Preserve on legacy/UI updates that do not know this import-only field.
    sourceRef: p.sourceRef !== undefined ? p.sourceRef : prev.sourceRef,
    allocationFromEnvelopeId: p.allocationFromEnvelopeId === undefined ? prev.allocationFromEnvelopeId : p.allocationFromEnvelopeId,
    allocationToEnvelopeId: p.allocationToEnvelopeId === undefined ? prev.allocationToEnvelopeId : p.allocationToEnvelopeId,
    items: buildItems(prev.id, p.items),
    createdAt: prev.createdAt, // server PATCH does not touch created_at
  };
}

/** Partial merge like drizzle `.set(fields)` — `undefined` fields are ignored. */
function merge<T extends object>(prev: T, patch: object): T {
  const out = { ...prev } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (k === "id" || v === undefined) continue;
    out[k] = v;
  }
  return out as T;
}

/** DB defaults for `accounts` (schema.ts). */
function accountFromCreate(p: OpPayload<"account.create">): Account {
  return {
    id: p.id,
    name: p.name,
    color: p.color ?? "#54c6bd",
    icon: p.icon ?? "wallet",
    type: (p.type ?? "checking") as Account["type"],
    onBudget: p.onBudget ?? true,
    initialBalance: p.initialBalance ?? 0,
    archived: p.archived ?? false,
    sort: p.sort ?? 0,
    automaticEnvelopeId: p.automaticEnvelopeId ?? null,
  };
}

/** DB defaults for `envelope_groups`. */
const groupFromCreate = (p: OpPayload<"group.create">): EnvelopeGroup => ({
  id: p.id,
  name: p.name,
  sort: p.sort ?? 0,
});

/** DB defaults for `envelopes`. */
function envelopeFromCreate(p: OpPayload<"envelope.create">): Envelope {
  return {
    id: p.id,
    groupId: p.groupId,
    name: p.name,
    color: p.color ?? "#f1dca0",
    icon: p.icon ?? "tag",
    note: p.note ?? null,
    monthlyTarget: p.monthlyTarget ?? null,
    isSavings: p.isSavings ?? false,
    sort: p.sort ?? 0,
    archived: p.archived ?? false,
  };
}

/**
 * FK effects of envelope removal (envelope.delete / group.delete):
 * allocations CASCADE, envelope references SET NULL, txn_items CASCADE.
 */
function deleteEnvelopesEffects(ledger: ClientLedger, envIds: ReadonlySet<string>): ClientLedger {
  return {
    ...ledger,
    envelopes: ledger.envelopes.filter((e) => !envIds.has(e.id)),
    allocations: ledger.allocations.filter((a) => !envIds.has(a.envelopeId)),
    accounts: ledger.accounts.map((account) =>
      account.automaticEnvelopeId !== null && envIds.has(account.automaticEnvelopeId) ? { ...account, automaticEnvelopeId: null } : account,
    ),
    transactions: ledger.transactions.map((t) => {
      const clearEnv = t.envelopeId !== null && envIds.has(t.envelopeId);
      const clearAllocationFrom = t.allocationFromEnvelopeId !== null && envIds.has(t.allocationFromEnvelopeId);
      const clearAllocationTo = t.allocationToEnvelopeId !== null && envIds.has(t.allocationToEnvelopeId);
      const dropItems = t.items.some((i) => envIds.has(i.envelopeId));
      if (!clearEnv && !clearAllocationFrom && !clearAllocationTo && !dropItems) return t;
      return {
        ...t,
        envelopeId: clearEnv ? null : t.envelopeId,
        allocationFromEnvelopeId: clearAllocationFrom ? null : t.allocationFromEnvelopeId,
        allocationToEnvelopeId: clearAllocationTo ? null : t.allocationToEnvelopeId,
        items: dropItems ? t.items.filter((i) => !envIds.has(i.envelopeId)) : t.items,
      };
    }),
  };
}

/** Replace the element at index — fresh array. */
function replaceAt<T>(arr: readonly T[], idx: number, value: T): T[] {
  const next = arr.slice();
  next[idx] = value;
  return next;
}

/**
 * Pure reducer: apply an op to the client ledger.
 * Does not validate the payload (the client validates with zod at enqueue) —
 * an unrecognized kind (retired, or from a newer app version) is a no-op.
 */
export function applyOp(ledger: ClientLedger, op: SyncOp): ClientLedger {
  switch (op.kind) {
    case "txn.create": {
      const p = op.payload as OpPayload<"txn.create">;
      if (ledger.transactions.some((t) => t.id === p.id)) return ledger; // existing id — no-op
      return { ...ledger, transactions: [...ledger.transactions, txnFromCreate(p)] };
    }
    case "txn.update": {
      const p = op.payload as OpPayload<"txn.update">;
      const idx = ledger.transactions.findIndex((t) => t.id === p.id);
      if (idx < 0) return ledger; // server: rejected → dead-letter + resync
      return {
        ...ledger,
        transactions: replaceAt(ledger.transactions, idx, txnFromUpdate(ledger.transactions[idx]!, p)),
      };
    }
    case "txn.delete": {
      const p = op.payload as OpPayload<"txn.delete">;
      if (!ledger.transactions.some((t) => t.id === p.id)) return ledger; // idempotent
      return { ...ledger, transactions: ledger.transactions.filter((t) => t.id !== p.id) };
    }
    case "alloc.set": {
      const p = op.payload as OpPayload<"alloc.set">;
      // Parity with the server FK: missing envelope ⇒ the allocations INSERT would
      // hit the FK (envelope_id NOT NULL) and the op would be rejected. The mirror
      // does NOT create an orphan — critical for fullResync replay idempotency
      // after a group/envelope.delete cascade.
      if (!ledger.envelopes.some((e) => e.id === p.envelopeId)) return ledger;
      const idx = ledger.allocations.findIndex((a) => a.envelopeId === p.envelopeId && a.month === p.month);
      if (idx >= 0) {
        const prev = ledger.allocations[idx]!;
        return { ...ledger, allocations: replaceAt(ledger.allocations, idx, { ...prev, amount: p.amount }) };
      }
      const row: Allocation = {
        id: localAllocId(p.envelopeId, p.month),
        envelopeId: p.envelopeId,
        month: p.month,
        amount: p.amount,
      };
      return { ...ledger, allocations: [...ledger.allocations, row] };
    }
    case "account.create": {
      const p = op.payload as OpPayload<"account.create">;
      if (ledger.accounts.some((a) => a.id === p.id)) return ledger; // existing id — no-op
      return { ...ledger, accounts: [...ledger.accounts, accountFromCreate(p)] };
    }
    case "account.update": {
      const p = op.payload as OpPayload<"account.update">;
      const idx = ledger.accounts.findIndex((a) => a.id === p.id);
      if (idx < 0) return ledger;
      return { ...ledger, accounts: replaceAt(ledger.accounts, idx, merge(ledger.accounts[idx]!, p)) };
    }
    case "account.delete": {
      const p = op.payload as OpPayload<"account.delete">;
      return {
        ...ledger,
        accounts: ledger.accounts.filter((a) => a.id !== p.id),
        // both FKs (account_id, to_account_id) delete the ENTIRE transaction row
        transactions: ledger.transactions.filter((t) => t.accountId !== p.id && t.toAccountId !== p.id),
      };
    }
    case "envelope.create": {
      const p = op.payload as OpPayload<"envelope.create">;
      if (ledger.envelopes.some((e) => e.id === p.id)) return ledger; // existing id — no-op
      return { ...ledger, envelopes: [...ledger.envelopes, envelopeFromCreate(p)] };
    }
    case "envelope.update": {
      const p = op.payload as OpPayload<"envelope.update">;
      const idx = ledger.envelopes.findIndex((e) => e.id === p.id);
      if (idx < 0) return ledger;
      return { ...ledger, envelopes: replaceAt(ledger.envelopes, idx, merge(ledger.envelopes[idx]!, p)) };
    }
    case "envelope.delete": {
      const p = op.payload as OpPayload<"envelope.delete">;
      return deleteEnvelopesEffects(ledger, new Set([p.id]));
    }
    case "group.create": {
      const p = op.payload as OpPayload<"group.create">;
      if (ledger.groups.some((g) => g.id === p.id)) return ledger; // existing id — no-op
      return { ...ledger, groups: [...ledger.groups, groupFromCreate(p)] };
    }
    case "group.update": {
      const p = op.payload as OpPayload<"group.update">;
      const idx = ledger.groups.findIndex((g) => g.id === p.id);
      if (idx < 0) return ledger;
      return { ...ledger, groups: replaceAt(ledger.groups, idx, merge(ledger.groups[idx]!, p)) };
    }
    case "group.delete": {
      const p = op.payload as OpPayload<"group.delete">;
      const envIds = new Set(ledger.envelopes.filter((e) => e.groupId === p.id).map((e) => e.id));
      const next = deleteEnvelopesEffects(ledger, envIds);
      return { ...next, groups: next.groups.filter((g) => g.id !== p.id) };
    }
    case "category.create": {
      const p = op.payload as OpPayload<"category.create">;
      if (ledger.categories.some((cat) => cat.id === p.id)) return ledger; // existing id — no-op
      const row: Category = { id: p.id, name: p.name };
      return { ...ledger, categories: [...ledger.categories, row] };
    }
    case "place.create": {
      const p = op.payload as OpPayload<"place.create">;
      if (ledger.places.some((pl) => pl.id === p.id)) return ledger; // existing id — no-op
      const row: Place = { id: p.id, name: p.name };
      return { ...ledger, places: [...ledger.places, row] };
    }
    case "budget.update": {
      const p = op.payload as OpPayload<"budget.update">;
      const idx = ledger.budgets.findIndex((b) => b.id === p.id);
      if (idx < 0) return ledger;
      return { ...ledger, budgets: replaceAt(ledger.budgets, idx, { ...ledger.budgets[idx]!, currency: p.currency }) };
    }
    case "budget.preferences.update": {
      const p = op.payload as OpPayload<"budget.preferences.update">;
      const idx = ledger.budgets.findIndex((budget) => budget.id === p.id);
      if (idx < 0) return ledger;
      const budget = ledger.budgets[idx]!;
      const preferences = reconcileBudgetPreferences({ ...budget.preferences, ...p.patch });
      return { ...ledger, budgets: replaceAt(ledger.budgets, idx, { ...budget, preferences }) };
    }
    default: {
      const _exhaustive: never = op.kind; // a NEW kind without a reducer must not compile
      void _exhaustive;
      // ops from newer/older app versions (or a retired feature's op kinds)
      // are ignored at RUNTIME — the server is authoritative, and an IDB
      // outbox can still hold an op queued before this app version.
      return ledger;
    }
  }
}
