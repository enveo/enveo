/**
 * Outbox — durable queue of local ops awaiting push.
 *
 * Architecture:
 * - the in-memory mirror (`entries`) is the source of truth for the sync engine and UI —
 *   all reads are synchronous,
 * - durability goes through ONE serial persist.ts chain: addOutbox of the op,
 *   THEN persistLedger of the ledger snapshot — IDB write order = op
 *   order, and the mirror is always a PREFIX of the durable outbox (never ahead).
 *   A crash between addOutbox and persistLedger is safe: boot REPLAYS
 *   the whole outbox onto the hydrated mirror (applyOp reducers are idempotent),
 * - compaction: ONLY merging an unsent `alloc.set` of the same
 *   (envelopeId, month) — state-based, trivially safe.
 *
 * Pending-guard keys (pendingKeys) MUST match the format
 * in store.applyPulled: "<ClientLedgerCollection>:<id>", and for allocations
 * the natural key "allocations:<envelopeId>|<month>".
 */
import type { OpPayload, SyncOp } from "@enveo/shared";
import { idbGetAll } from "./idb";
import * as persist from "./persist";
import { store } from "./store";

export interface OutboxEntry {
  /** IDB key (autoIncrement); null until idbAdd on the chain finishes. */
  localSeq: number | null;
  op: SyncOp;
}

export interface DeadLetter {
  opId: string;
  op: SyncOp;
  error: string;
  at: string;
}

/* ── Module state ─────────────────────────────────────────────────────── */

let entries: OutboxEntry[] = [];
let deadLetters: DeadLetter[] = [];
/** opIds currently in flight (in an ongoing POST /sync/push) — don't coalesce. */
const inFlight = new Set<string>();
/**
 * TRUE from the start to the end of THIS tab's reconcileFromIdb. In that window add() does NOT
 * merge `alloc.set` in-place (see add() and the reconcile header) — reconcile reads
 * the `rows` snapshot from IDB BEFORE the awaits, and a merge swaps the opId of an existing
 * entry (localSeq unchanged). If a reentrant (blur/Enter) `alloc.set` merged
 * within the read window, `rows` (old opId) would diverge from the mirror (new opId) →
 * step (1) would drop the fresh entry, step (2) would resurrect the old op as an orphan → silent
 * allocation revert. Flag is PER TAB — doesn't affect merges done by OTHER tabs.
 */
let reconciling = false;

let onChange: (() => void) | null = null;

/** Register a queue-change observer (sync engine → status for the UI). */
export function setOnChange(fn: () => void): void {
  onChange = fn;
}

const notify = (): void => {
  onChange?.();
};

/** Promise resolved once all writes SO FAR (persist.ts) have completed. */
export function flushed(): Promise<void> {
  return persist.flushed();
}

/* ── Hydrate (boot) ──────────────────────────────────────────────────── */

let hydratePromise: Promise<void> | null = null;

/**
 * One-time load of the outbox + dead-letters from IDB (StrictMode-safe). On
 * rejection (transient IDB) it CLEARS the cache so retryBoot can try again (D4).
 */
export function hydrate(): Promise<void> {
  if (!hydratePromise) {
    const p = (async () => {
      const [rows, dls] = await Promise.all([
        idbGetAll<{ localSeq: number; op: SyncOp }>("outbox"),
        idbGetAll<DeadLetter>("deadletter"),
      ]);
      rows.sort((a, b) => a.localSeq - b.localSeq);
      entries = rows.map((r) => ({ localSeq: r.localSeq, op: r.op }));
      deadLetters = dls.sort((a, b) => a.at.localeCompare(b.at));
      notify();
    })();
    p.catch(() => {
      if (hydratePromise === p) hydratePromise = null;
    });
    hydratePromise = p;
  }
  return hydratePromise;
}

/**
 * INVARIANT: the outbox = a SHARED (origin-scoped) IDB queue; each tab
 * reconciles its in-memory mirror with IDB at the start of a cycle, so any live
 * tab drains ops enqueued by a tab that has meanwhile
 * CLOSED. Server idempotency (opId → the sync_ops guard) makes a concurrent
 * double push safe (one gets "duplicate").
 *
 * Reconciliation is TWO-PHASE relative to the in-memory mirror (`entries`), which is read
 * from IDB only ONCE at boot (hydrate):
 *
 *  (1) REMOVE entries whose IDB row is GONE — ANOTHER tab acked or
 *      dead-lettered them and deleted the shared row. Only PERSISTED
 *      (localSeq !== null) and NOT in flight: own entries without localSeq (addOutbox
 *      still on the persist chain) may temporarily lack a row — we do NOT
 *      touch them. Without this step the tab would push the op again (idempotency would
 *      yield "duplicate" — safe but wasteful) or re-dead-letter an already
 *      rejected op (a needless fullResync).
 *
 *  (2) ABSORB "orphans" — IDB rows THIS tab's memory has never
 *      seen (an op enqueued by a tab closed before its own push;
 *      no live tab re-reads the outbox, so without this it would be stuck until a full
 *      reload). Dedupe by opId, not localSeq: catches own entries still without
 *      localSeq and merged ones (a new opId overwrote the row). We weave them in
 *      localSeq order (global autoIncrement = the real cross-tab order; important
 *      for LWW — two `alloc.set`s of the same key must go in that order);
 *      own entries without localSeq = the freshest → at the end.
 *
 * Phase (1) before (2) also fixes the cross-tab coalescing race: when ANOTHER
 * tab merged an `alloc.set` (same localSeq, NEW opId), the old opId disappears in (1),
 * and the new one enters in (2) as an orphan — without this both would land in the mirror at once.
 *
 * RACE (same tab): `rows` is read BEFORE the awaits, so if a reentrant
 * `alloc.set` (blur/Enter within the read window) merged in-place — swapping the opId
 * of a PERSISTED entry without changing localSeq — `rows` (old opId) would diverge from the
 * mirror (new opId): (1) would drop the fresh entry, (2) would resurrect the old op as an
 * orphan → silent allocation revert and loss of the newest amount. Closed by the
 * `reconciling` flag: for the duration of this function add() APPENDS a new op instead of merging.
 *
 * `flushed()` FIRST — closes write windows still on the persist chain
 * (addOutbox / putOutbox of a merge / deleteOutbox of an ack/dead-letter), so the
 * comparison with IDB is trustworthy. Called at the start of every cycle (doCycle),
 * where inFlight is already cleared (the guard stays regardless). Returns the ABSORBED
 * ops (localSeq order — the caller applies them onto the mirror: pending-guard + UI)
 * AND `peerDeadLettered` — ANOTHER tab REJECTED (dead-lettered) an op THIS tab
 * had in its outbox mirror; its optimistic effect hangs as a PHANTOM (the server
 * never accepted the id, so no tombstone will remove it) → the caller MUST
 * markResyncPending (fullResync undoes the phantom — delete wins). Removals from (1)
 * are refreshed in the UI by `notify()` alone.
 *
 * RACE (multi-tab) closed by TWO assumptions: (a) the dead-letter write is
 * ATOMIC with the outbox row removal (idbMoveToDeadLetter — one
 * transaction over both stores), (b) we read outbox BEFORE deadletter. Then
 * "the outbox row disappeared" ⇒ the deadletter entry is already visible (the deadletter read
 * is later) — no window in which an ack and a rejection would look
 * identical.
 */
export interface ReconcileResult {
  absorbed: SyncOp[];
  peerDeadLettered: boolean;
}

export async function reconcileFromIdb(): Promise<ReconcileResult> {
  // Set the flag SYNCHRONOUSLY before the first await, clear it in finally: for the ENTIRE
  // duration (all await windows) a reentrant add() of this tab appends instead of merging
  // (see `reconciling` and add()). finally also covers the exception path (transient IDB),
  // so merging doesn't stay disabled forever.
  reconciling = true;
  try {
    return await reconcileInner();
  } finally {
    reconciling = false;
  }
}

async function reconcileInner(): Promise<ReconcileResult> {
  await persist.flushed();
  // Read ORDER matters: outbox BEFORE deadletter (see the header — closes the race).
  const rows = await idbGetAll<{ localSeq: number; op: SyncOp }>("outbox");
  const dlRows = await idbGetAll<DeadLetter>("deadletter");
  const byOpId = new Map<string, { localSeq: number; op: SyncOp }>();
  for (const r of rows) byOpId.set(r.op.opId, r);
  const dlById = new Map<string, DeadLetter>();
  for (const d of dlRows) dlById.set(d.opId, d);

  // (1) remove entries whose IDB row is gone (acked/dead-lettered by another tab).
  //     If the vanished entry IS now in the deadletter store → another tab REJECTED it,
  //     and its optimistic effect hangs in our mirror as a phantom → force a resync.
  const before = entries.length;
  const kept: OutboxEntry[] = [];
  let peerDeadLettered = false;
  for (const e of entries) {
    if (e.localSeq === null || inFlight.has(e.op.opId) || byOpId.has(e.op.opId)) {
      kept.push(e);
    } else if (dlById.has(e.op.opId)) {
      peerDeadLettered = true; // rejected by ANOTHER tab → fullResync undoes the phantom
    }
  }
  entries = kept;
  let changed = entries.length !== before;

  // Reconcile the dead-letter mirror with the SHARED IDB store (another tab may have added
  // via a rejection or removed via "Discard") — keeps the UI and `known` in (2) current.
  const nextDl = dlRows.slice().sort((a, b) => a.at.localeCompare(b.at));
  const prevIds = deadLetters.map((d) => d.opId).join(",");
  if (nextDl.map((d) => d.opId).join(",") !== prevIds) {
    deadLetters = nextDl;
    changed = true;
  }

  // (2) absorb orphans (dedupe by opId)
  const known = new Set<string>();
  for (const e of entries) known.add(e.op.opId);
  for (const id of inFlight) known.add(id);
  for (const d of deadLetters) known.add(d.opId);
  const orphanEntries: OutboxEntry[] = rows
    .filter((r) => !known.has(r.op.opId))
    .map((r) => ({ localSeq: r.localSeq, op: r.op }));

  if (orphanEntries.length > 0) {
    changed = true;
    // merge by localSeq; own entries without localSeq (the freshest) at the end
    const nulls = entries.filter((e) => e.localSeq === null);
    const withSeq = [...entries.filter((e) => e.localSeq !== null), ...orphanEntries].sort(
      (a, b) => (a.localSeq as number) - (b.localSeq as number),
    );
    entries = [...withSeq, ...nulls];
  }

  if (changed) notify();
  return { absorbed: orphanEntries.map((e) => e.op), peerDeadLettered };
}

/* ── Queue operations ────────────────────────────────────────────────── */

/**
 * Add an op: memory IMMEDIATELY; durability on the serial persist.ts chain —
 * addOutbox of the op BEFORE persistLedger of the snapshot (the mirror never gets
 * ahead of the outbox). We take the snapshot HERE (after store.applyLocal in mutate.ts) — an
 * immutable reference, so the next op N+1 won't "taint" it.
 * An `alloc.set` for the same (envelopeId, month) merges with the LAST
 * unsent op of that key instead of appending a new one.
 */
export function add(op: SyncOp): void {
  const snap = store.snapshotForPersist(); // after applyLocal — includes this op's effect
  // `!reconciling`: don't merge during this tab's ongoing reconcileFromIdb (see the
  // `reconciling` flag) — within the IDB read window an in-place merge would swap the opId
  // of an entry that reconcile's `rows` hasn't seen yet, which would revert this allocation.
  // Instead of merging we APPEND a new op: both versions go in localSeq order, and the server's
  // LWW keeps the newest (no loss). Outside the window merging works as before.
  if (op.kind === "alloc.set" && !reconciling) {
    const p = op.payload as OpPayload<"alloc.set">;
    // from the end: we merge with the NEWEST entry of the key (an earlier one may be
    // back in the queue after a failed push — overwriting it would produce the wrong
    // LWW order on the server)
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (e.op.kind !== "alloc.set" || inFlight.has(e.op.opId)) continue;
      const ep = e.op.payload as OpPayload<"alloc.set">;
      if (ep.envelopeId !== p.envelopeId || ep.month !== p.month) continue;
      // NEW opId: if the old op had already been applied (lost push
      // response), a retry of the old opId would get "duplicate" and the new amount would be lost
      e.op = op;
      // overwrite the existing outbox row, THEN the mirror — both on the persist chain
      void persist.putOutbox(() => e.localSeq, e.op);
      void persist.persistLedger(snap);
      notify();
      return;
    }
  }
  const entry: OutboxEntry = { localSeq: null, op };
  entries.push(entry);
  // addOutbox BEFORE persistLedger on the same chain (add-before-persist)
  void persist.addOutbox(op).then((seq) => {
    if (seq !== undefined) entry.localSeq = seq;
  });
  void persist.persistLedger(snap);
  notify();
}

/** First `max` ops to send; marks them as in flight. */
export function takeBatch(max: number): OutboxEntry[] {
  const batch = entries.slice(0, max);
  for (const e of batch) inFlight.add(e.op.opId);
  return batch;
}

/** End of a send attempt (successful or not) — unblock coalescing. */
export function clearInFlight(): void {
  inFlight.clear();
}

/** Remove acknowledged (applied|duplicate) ops from memory and IDB. */
export function removeAcked(opIds: string[]): void {
  if (opIds.length === 0) return;
  const ids = new Set(opIds);
  const removed = entries.filter((e) => ids.has(e.op.opId));
  entries = entries.filter((e) => !ids.has(e.op.opId));
  // localSeq is read at execution time (addOutbox of these entries is earlier on the chain)
  void persist.deleteOutbox(removed.map((e) => () => e.localSeq));
  notify();
}

/**
 * "Discard" a dead-letter (Settings): remove from memory + IDB. Doesn't throw (like the rest
 * of the module); unknown opId = no-op. The rejected op's optimistic effect was already undone
 * by fullResync (delete wins) — here we only clean the entry off the list.
 */
export function discardDeadLetter(opId: string): void {
  const next = deadLetters.filter((d) => d.opId !== opId);
  if (next.length === deadLetters.length) return;
  deadLetters = next;
  void persist.deleteDeadLetter(opId);
  notify();
}

/**
 * Clear the ENTIRE queue (memory + IDB: outbox and dead-letter). Called after uploading
 * the local replica to the server via /sync/replace (pushLocalToServer / backup import /
 * enabling the "delete server data" mode): server == local, so every op awaiting
 * push is already reflected in the ledger and becomes moot. Without this
 * the queue would try to push the ops after sync resumes and would duplicate data
 * (server idempotency would catch some, but the canonical state is the fresh replace).
 */
export function clearAll(): void {
  entries = [];
  deadLetters = [];
  inFlight.clear();
  void persist.clearOutbox();
  notify();
}

/** A rejected op: from the queue to dead-letter (memory + IDB). */
export function toDeadLetter(entry: OutboxEntry, error: string): void {
  entries = entries.filter((e) => e !== entry);
  const dl: DeadLetter = { opId: entry.op.opId, op: entry.op, error, at: new Date().toISOString() };
  deadLetters = [...deadLetters, dl];
  // remove from the outbox + write the dead-letter in one task (localSeq at execution time)
  void persist.putDeadLetter(dl, () => entry.localSeq);
  notify();
}

/* ── Reads ─────────────────────────────────────────────────────────── */

export const size = (): number => entries.length;

export const getDeadLetters = (): readonly DeadLetter[] => deadLetters;

/** Copy of the queue in order — for replay at boot and fullResync. */
export const snapshot = (): OutboxEntry[] => entries.slice();

/** op kind → ClientLedger collection (pending-guard key). */
const COLLECTION: Record<string, string> = {
  txn: "transactions",
  account: "accounts",
  group: "groups",
  envelope: "envelopes",
  category: "categories",
  place: "places",
  budget: "budgets",
};

/**
 * Keys of entities with pending ops — pull does NOT overwrite them with server state
 * (the optimistic local version wins until the push is confirmed).
 */
export function pendingKeys(): Set<string> {
  const keys = new Set<string>();
  for (const { op } of entries) {
    if (op.kind === "alloc.set") {
      const p = op.payload as OpPayload<"alloc.set">;
      keys.add(`allocations:${p.envelopeId}|${p.month}`);
      continue;
    }
    const collection = COLLECTION[op.kind.split(".")[0]!];
    if (!collection) continue; // defense: unknown kind
    keys.add(`${collection}:${(op.payload as { id: string }).id}`);
  }
  return keys;
}
