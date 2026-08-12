/**
 * LedgerStore — module singleton: in-memory mirror of the full replica
 * (ClientLedger) + persistence in IndexedDB + React notification via
 * useSyncExternalStore (subscribe/getVersion).
 *
 * Rules:
 * - screen reads NEVER wait for IDB or the network — they compute from the mirror,
 * - the store does NOT persist on its own: replace/applyPulled/applyLocal change
 *   ONLY memory + version++; durability is done by the callers via persist.ts
 *   (serial chain: addOutbox → persistLedger), so the mirror is always a
 *   PREFIX of the durable outbox (see persist.ts) — a persistence failure doesn't
 *   break operation (the in-memory mirror is the source for the UI).
 *
 * Local mutations (Phase 4): applyLocal(op) changes the mirror synchronously
 * (UI in the same tick); durability is provided by the persist.ts chain (addOutbox of the op
 * → persistLedger of the snapshot) + outbox replay at boot.
 */
import { applyOp, type Allocation, type ClientLedger, type ReplicatedTable, type SyncOp } from "@enveo/shared";
import { idbGet } from "./idb";

/** A change from GET /api/sync/pull (shape from packages/api/src/routes/sync.ts). */
export type PullChange =
  | { seq: number; table: ReplicatedTable; op: "upsert"; row: unknown }
  | { seq: number; table: ReplicatedTable; op: "delete"; rowId: string };

/** DB table name → ClientLedger key (envelope_groups → groups). */
const TABLE_KEY: Record<ReplicatedTable, keyof ClientLedger> = {
  accounts: "accounts",
  envelope_groups: "groups",
  envelopes: "envelopes",
  categories: "categories",
  places: "places",
  transactions: "transactions",
  allocations: "allocations",
  budgets: "budgets",
};

/**
 * "foreign" — the replica on this device provably belongs to ANOTHER account (its owner stamp
 * names a different user than the session): every server write is refused and the app hands the
 * decision to the human (ForeignReplicaScreen: export a backup, or remove the data and
 * continue). It is deliberately NOT a self-healing state — the replica may be the last copy of
 * that budget, and a user id is not stable across a server rebuild.
 */
export type BootStatus = "booting" | "ready" | "error" | "unauthed" | "locked" | "foreign";

/**
 * Pending-guard key for allocations (natural key) — MUST match
 * the format in outbox.pendingKeys().
 */
const allocPendingKey = (a: Pick<Allocation, "envelopeId" | "month">): string => `allocations:${a.envelopeId}|${a.month}`;

/* ── Module state ─────────────────────────────────────────────────────── */

let ledger: ClientLedger | null = null;
let cursor = 0;
let budgetId: string | null = null;
let version = 0;
let bootStatus: BootStatus = "booting";
const listeners = new Set<() => void>();

function bump(): void {
  version++;
  for (const fn of listeners) fn();
}

/* ── API ─────────────────────────────────────────────────────────────── */

/**
 * Backfills collections added AFTER the replica was saved (old blob in IDB / old
 * backup) — a missing field must not mean a crash or a dead UI. Applies to every
 * newly replicated entity (today: budgets since 1.1.8).
 */
function normalizeLedger(l: ClientLedger): ClientLedger {
  return l.budgets ? l : { ...l, budgets: [] };
}

let hydratePromise: Promise<"ready" | "empty"> | null = null;

async function doHydrate(): Promise<"ready" | "empty"> {
  const [l, c, b] = await Promise.all([idbGet<ClientLedger>("meta", "ledger"), idbGet<number>("meta", "cursor"), idbGet<string>("meta", "budgetId")]);
  if (!l) return "empty";
  ledger = normalizeLedger(l);
  cursor = c ?? 0;
  budgetId = b ?? null;
  bump();
  return "ready";
}

export const store = {
  /**
   * One-time load of {ledger, cursor, budgetId} from meta at boot
   * (StrictMode-safe). On rejection (transient IDB) it CLEARS the cache so
   * retryBoot can try again (D4).
   */
  hydrate(): Promise<"ready" | "empty"> {
    if (!hydratePromise) {
      const p = doHydrate();
      p.catch(() => {
        if (hydratePromise === p) hydratePromise = null;
      });
      hydratePromise = p;
    }
    return hydratePromise;
  },

  /**
   * Snapshot for durability: the current IMMUTABLE references (no copy — applyOp/
   * applyPulled/replace always swap the whole object). The caller does the persist
   * (persist.persistLedger), so the durable mirror won't get ahead of the durable outbox.
   */
  snapshotForPersist(): { ledger: ClientLedger | null; cursor: number; budgetId: string | null } {
    return { ledger, cursor, budgetId };
  },

  /**
   * Full mirror replacement (snapshot / fullResync) — ONLY memory + version++.
   * The caller ensures the persist (persist.persistLedger(snapshotForPersist())).
   */
  replace(next: ClientLedger, nextCursor: number, nextBudgetId: string): void {
    ledger = normalizeLedger(next);
    cursor = nextCursor;
    budgetId = nextBudgetId;
    bump();
  },

  /**
   * Applies a pull delta onto the mirror:
   * - upsert: replace-or-insert of the WHOLE object by id (transactions have
   *   embedded items); allocations with a natural-key fallback
   *   (envelopeId+month) — catches local synthetic ids,
   * - delete: removal by rowId (unknown id → ignore; an allocation tombstone
   *   is resolved by id from the mirror to learn its natural key),
   * - pending-guard: changes to entities with ops waiting in the outbox are SKIPPED
   *   (the optimistic local state wins until the push is confirmed; keys as
   *   in outbox.pendingKeys()).
   * ONLY memory + version++ — durability is done by the caller (persist.persistLedger).
   */
  applyPulled(changes: PullChange[], nextCursor: number, pendingKeys?: ReadonlySet<string>): void {
    if (!ledger) return; // no bootstrap — pull has nothing to apply onto
    const next = { ...ledger };
    const copied = new Map<keyof ClientLedger, Array<{ id: string }>>();
    const arrFor = (k: keyof ClientLedger): Array<{ id: string }> => {
      let a = copied.get(k);
      if (!a) {
        // ?? []: an old replica may lack a freshly added collection (see normalizeLedger)
        a = [...((next[k] as Array<{ id: string }> | undefined) ?? [])];
        copied.set(k, a);
      }
      return a;
    };

    for (const ch of changes) {
      const key = TABLE_KEY[ch.table];
      // defensive: `ch.table` is only TYPED as ReplicatedTable — it is actually untrusted wire
      // data (server JSON cast via `as PullResponse`), so an old/wider server can still send a
      // table name this build's TABLE_KEY has no entry for (e.g. a table for a retired feature).
      if (!key) continue;
      const arr = arrFor(key);
      if (ch.op === "delete") {
        const i = arr.findIndex((r) => r.id === ch.rowId);
        if (i < 0) continue; // unknown id → ignore
        if (pendingKeys) {
          const pk = ch.table === "allocations" ? allocPendingKey(arr[i] as unknown as Allocation) : `${key}:${ch.rowId}`;
          if (pendingKeys.has(pk)) continue; // pending-guard
        }
        arr.splice(i, 1);
        continue;
      }
      const row = ch.row as { id: string };
      if (pendingKeys) {
        const pk = ch.table === "allocations" ? allocPendingKey(row as unknown as Allocation) : `${key}:${row.id}`;
        if (pendingKeys.has(pk)) continue; // pending-guard
      }
      let i = arr.findIndex((r) => r.id === row.id);
      if (i < 0 && ch.table === "allocations") {
        // natural key — the canonical row replaces its local counterpart
        const a = row as unknown as Allocation;
        i = (arr as unknown as Allocation[]).findIndex((r) => r.envelopeId === a.envelopeId && r.month === a.month);
      }
      if (i >= 0) arr[i] = row;
      else arr.push(row);
    }

    for (const [k, arr] of copied) {
      (next as Record<keyof ClientLedger, unknown>)[k] = arr;
    }
    ledger = next;
    cursor = nextCursor;
    bump();
  },

  /**
   * Sync v2 (E2EE): apply decrypted pull ops onto the mirror — applyOp one by one
   * (the same reducers as local mutations ⇒ client↔client parity) + cursor + bump.
   * `skipOpIds` = opIds of own ops WAITING in the outbox: their optimistic
   * effect is already in the mirror, and the server version (pushed e.g. by another tab)
   * must not undo it — the applyPulled pending-guard equivalent. An op that fails to
   * apply is logged and skipped (the journal moves on — like replayOutbox).
   * ONLY memory + version++ — durability is done by the caller (persist.persistLedger).
   */
  applyRemoteOps(ops: readonly SyncOp[], nextCursor: number, skipOpIds?: ReadonlySet<string>): void {
    if (!ledger) return; // no bootstrap — pull has nothing to apply onto
    let next = ledger;
    for (const op of ops) {
      if (skipOpIds?.has(op.opId)) continue; // own pending op — the optimistic state wins
      try {
        next = applyOp(next, op);
      } catch (e) {
        console.warn("applyRemoteOps: journal op does not apply onto the mirror", op, e);
      }
    }
    ledger = next;
    cursor = nextCursor;
    bump();
  },

  /**
   * Re-hydrate the mirror from IDB after ANOTHER tab synced and persisted
   * changes (BroadcastChannel "updated"): loads the ledger blob + cursor + budgetId
   * from meta and bumps the version — this tab's UI reflects the leader's sync WITHOUT
   * its own network request. The caller (sync.ts) adds a replay of its own
   * outbox so THIS tab's optimistic ops aren't lost. Persists nothing
   * (no write loop). Empty blob (nothing persisted yet) → no-op.
   */
  async rehydrateFromIdb(): Promise<void> {
    const [l, c, b] = await Promise.all([idbGet<ClientLedger>("meta", "ledger"), idbGet<number>("meta", "cursor"), idbGet<string>("meta", "budgetId")]);
    if (!l) return;
    ledger = normalizeLedger(l);
    cursor = c ?? cursor;
    budgetId = b ?? budgetId;
    bump();
  },

  /**
   * A local mutation (an op headed to the outbox): mirror + version++ SYNCHRONOUSLY
   * (UI updates in the same tick). Does NOT persist — durability rides the
   * serial persist.ts chain (addOutbox of the op → persistLedger); a crash
   * in the window is healed by the outbox replay at boot (applyOp reducers are idempotent).
   */
  applyLocal(op: SyncOp): void {
    if (!ledger) throw new Error("applyLocal: replica not booted yet");
    ledger = applyOp(ledger, op);
    bump();
  },

  /**
   * Cursor-only advance — a pull that brought no changes FOR US. The `changes` sequence is
   * global to the instance, so it also moves on other tenants' writes (their rows are filtered
   * out of our delta): take the number, but touch neither the ledger nor the version (no
   * re-render) and do not persist (the caller decides — see doPull).
   */
  setCursor(next: number): void {
    cursor = next;
  },

  getLedger: (): ClientLedger | null => ledger,
  getCursor: (): number => cursor,
  getBudgetId: (): string | null => budgetId,
  getVersion: (): number => version,
  getBootStatus: (): BootStatus => bootStatus,

  setBootStatus(s: BootStatus): void {
    if (bootStatus === s) return;
    bootStatus = s;
    bump();
  },

  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
