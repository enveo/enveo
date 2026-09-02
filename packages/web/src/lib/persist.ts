/**
 * persist.ts — the sole owner of IndexedDB durability for local-first.
 *
 * ALL writes (outbox add/put/delete, dead-letter, ledger mirror in `meta`,
 * single meta keys) go through ONE serial promise chain (`chain`),
 * so IDB write order = call order. Thanks to this the add-op path
 * does addOutbox() BEFORE persistLedger() on the same chain:
 *
 *   INVARIANT: the durable ledger mirror reflects a PREFIX of the durable outbox
 *   (never gets ahead of it) ⇒ boot = hydrate mirror + hydrate outbox +
 *   replayOutbox (idempotent) yields the correct state; a crash leaves the mirror
 *   AT MOST behind the outbox (never ahead), and the replay fills the gap.
 *
 * Write failure (D3): the first rejected task sets `durableBroken`, warns
 * ONCE and from then on every subsequent (and already queued but not yet
 * executed) task is SKIPPED — the durable log never gets a GAP or a
 * "mirror ahead of outbox" state. The in-memory queue still pushes correctly in this
 * session; a reload loses the non-durable tail (acceptable — better than a silent phantom).
 *
 * Imports ONLY idb.ts (pure data in/out) — no dependency on
 * store/outbox/sync, so no import cycle arises.
 */
import { runPersistenceAccountStorageWrite } from "./accountStorageOperations";
import { idbAdd, idbClear, idbDelete, idbMoveToDeadLetter, idbPut, idbPutMany } from "./idb";

/** Mirror snapshot for durability (immutable references from store.snapshotForPersist). */
export interface LedgerSnap {
  ledger: unknown;
  cursor: number;
  budgetId: string | null;
}

/* ── Serial chain + "durability broken" mode (D3) ────────────────────── */

let chain: Promise<void> = Promise.resolve();
let durableBroken = false;

export interface PersistWriteGate {
  beforeWrite(): Promise<"run" | "skip">;
}

let writeGate: PersistWriteGate | null = null;

/** Installed by the multi-tab composition root; kept injectable for deterministic race tests. */
export function configurePersistWriteGate(gate: PersistWriteGate | null): void {
  writeGate = gate;
}

export const isDurableBroken = (): boolean => durableBroken;

/** Unit-test isolation after deliberately exercising the fail-closed persistence path. */
export function __resetPersistForTests(): void {
  chain = Promise.resolve();
  durableBroken = false;
  writeGate = null;
}

function markBroken(e: unknown): void {
  if (durableBroken) return;
  durableBroken = true;
  console.warn("persist: durable IDB write failed — continuing memory-only for this session (reload loses the non-durable tail)", e);
}

/**
 * Append a task to the end of the chain; returns its result (or undefined when
 * skipped/failed). A task queued AFTER a detected failure is skipped right away;
 * a task queued EARLIER but not yet executed checks
 * `durableBroken` at EXECUTION time (closes the race ⇒ no gap in the log).
 */
export function enqueue<T>(task: () => Promise<T>): Promise<T | undefined> {
  if (durableBroken) return Promise.resolve(undefined);
  const run = chain.then(async () => {
    if (durableBroken) return undefined;
    // The decision is taken at EXECUTION time, after earlier writes. During coordinated
    // sign-out it waits without touching IDB; cancellation resumes, generation rotation skips.
    if (writeGate && (await writeGate.beforeWrite().catch(() => "skip" as const)) === "skip") return undefined;
    return task();
  });
  // the chain never throws (markBroken catches the failure) — subsequent tasks keep going
  chain = run.then(
    () => {},
    (e) => markBroken(e),
  );
  return run.catch(() => undefined);
}

/** Promise resolved once all writes SO FAR have completed. */
export function flushed(): Promise<void> {
  return chain;
}

/* ── Typed helpers (each = one task on the chain) ───────────────────── */

/**
 * Ledger mirror (ledger/cursor/budgetId) in ONE IDB transaction.
 * WITHOUT `lastSyncAt` (D6) — that stamp is written exclusively by finishSuccess (putMeta).
 */
export function persistLedger(snap: LedgerSnap): Promise<void> {
  return enqueue(() =>
    runPersistenceAccountStorageWrite(() =>
      idbPutMany("meta", [
        { value: snap.ledger, key: "ledger" },
        { value: snap.cursor, key: "cursor" },
        { value: snap.budgetId, key: "budgetId" },
      ]),
    ),
  ).then(() => {});
}

/** Add an op to the outbox; returns the assigned localSeq (undefined when durability is broken). */
export function addOutbox(op: unknown): Promise<number | undefined> {
  return enqueue(() => runPersistenceAccountStorageWrite(() => idbAdd("outbox", { op }) as Promise<number>));
}

/**
 * Overwrite an existing outbox row (alloc.set coalescing). `getSeq` is read
 * at execution time — this entry's addOutbox is earlier on the chain (FIFO),
 * so localSeq is already assigned.
 */
export function putOutbox(getSeq: () => number | null, op: unknown): Promise<void> {
  return enqueue(async () => {
    const seq = getSeq();
    if (seq !== null) await runPersistenceAccountStorageWrite(() => idbPut("outbox", { localSeq: seq, op }));
  }).then(() => {});
}

/** Delete outbox rows; the `getSeq`s are read at execution time (localSeq assigned after addOutbox). */
export function deleteOutbox(getSeqs: ReadonlyArray<() => number | null>): Promise<void> {
  return enqueue(async () => {
    for (const get of getSeqs) {
      const seq = get();
      if (seq !== null) await runPersistenceAccountStorageWrite(() => idbDelete("outbox", seq));
    }
  }).then(() => {});
}

/**
 * Move an op to dead-letter: remove from the outbox + write the dead-letter ATOMICALLY (one
 * IDB transaction over both stores — idbMoveToDeadLetter), so another tab never
 * sees "the op vanished from the outbox but isn't in deadletter". `getSeq`
 * is read at execution time (this entry's addOutbox is earlier on the chain).
 */
export function putDeadLetter(dl: object, getSeq: () => number | null): Promise<void> {
  return enqueue(() => runPersistenceAccountStorageWrite(() => idbMoveToDeadLetter(getSeq(), dl))).then(() => {});
}

/** Delete a dead-letter by opId (the "Discard" action in Settings) — on the same chain. */
export function deleteDeadLetter(opId: string): Promise<void> {
  return enqueue(() => runPersistenceAccountStorageWrite(() => idbDelete("deadletter", opId))).then(() => {});
}

/**
 * Clear the ENTIRE durable outbox + dead-letter (outbox.clearAll — after uploading the local
 * replica to the server via /sync/replace: the queue becomes moot, because
 * server == local). On the same chain, so it runs AFTER any
 * unfinished addOutbox/persistLedger — IDB ends up empty.
 */
export function clearOutbox(): Promise<void> {
  return enqueue(async () => {
    await runPersistenceAccountStorageWrite(() => idbClear("outbox"));
    await runPersistenceAccountStorageWrite(() => idbClear("deadletter"));
  }).then(() => {});
}

/** A single meta key (lastSyncAt, resyncPending) — on the same chain. */
export function putMeta(key: string, value: unknown): Promise<void> {
  return enqueue(() => runPersistenceAccountStorageWrite(() => idbPut("meta", value, key))).then(() => {});
}
