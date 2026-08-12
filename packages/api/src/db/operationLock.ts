/**
 * Generic operation lock (backlog §0b) — serializes ONE invariant-critical section across API
 * processes with a PostgreSQL TRANSACTION advisory lock keyed by a typed (operation, id) tuple.
 * First consumer: lazy initial-budget creation (`getBudgetId` in context.ts).
 *
 * Key mapping (PRIVATE to this module — production callers must never couple business logic to
 * numeric lock ids): the tuple is framed as the versioned canonical JSON string
 *   ["enveo-operation-lock", 1, operation, id]
 * and hashed INSIDE PostgreSQL with `hashtextextended(canonical, 0)` (fixed seed, one-bigint
 * form of `pg_advisory_xact_lock`). JSON framing keeps the tuple unambiguous (no
 * `operation + ":" + id` concatenation, whose halves could bleed into each other), and the
 * version prefix preserves the ability to introduce a new mapping deliberately. A 64-bit hash
 * collision between DIFFERENT keys would only over-serialize unrelated work; IDENTICAL
 * canonical keys always map to the same lock — which is the correctness property.
 *
 * API rules (the full contract lives in the §0b decision record):
 *  - Callback + transaction only: the lock is acquired as the FIRST statement of the very
 *    transaction the callback runs on, and PostgreSQL releases it automatically on
 *    commit/rollback. There is no "acquire and remember to unlock" primitive.
 *  - `withOperationLockInTx` types its transaction as `DbTransaction`, which the pooled `db`
 *    does not satisfy — the pool could acquire on one connection and run the work on another,
 *    the exact misuse this rejects at compile time.
 *  - One key per call. Do NOT nest operation locks or take several in arbitrary order — that is
 *    a deadlock protocol. A future multi-key need gets a separate batch API that sorts
 *    de-duplicated canonical keys first.
 *  - Blocking semantics only — no "try lock and maybe skip" overload: a caller must never
 *    accidentally run an invariant-critical section without the lock.
 *  - Keep callbacks short database work: no HTTP calls, model requests, hashing or other
 *    unbounded I/O while the lock is held.
 *
 * LOCK ORDER with the changes-cursor barrier (routes/sync.ts): creating a budget fires
 * `log_change()` (SHARED changes lock), so an initializer's order is operation lock → shared
 * changes lock. Routes that take the EXCLUSIVE changes lock (snapshot/pull/replace) must ensure
 * the initial budget through the STANDALONE lock path BEFORE opening their barrier transaction
 * and only resolve an EXISTING budget inside it — lazy creation under the exclusive lock would
 * invert the order and deadlock. The signup gate (auth.ts) and `lockChangesCursor` keep their
 * own dedicated protocols; neither may be migrated onto this utility.
 */
import { sql as dsql } from "drizzle-orm";
import { type DbTransaction, db } from "./client";

/**
 * Central registry — the only source of operation names. A free-form string is rejected by the
 * `OperationLockName` union at compile time (a typo would silently create a different lock
 * domain); adding an operation is an explicit, reviewed code change. Any future path that can
 * turn "zero budgets" into the first/default budget must REUSE `ensureInitialBudget`; creating
 * an intentional additional budget is a different operation and must not share it.
 */
export const OPERATION_LOCK = {
  ensureInitialBudget: "budget.ensure-initial",
} as const;

export type OperationLockName = (typeof OPERATION_LOCK)[keyof typeof OPERATION_LOCK];

export type OperationLockKey = Readonly<{
  operation: OperationLockName;
  id: string;
}>;

/** Version prefix of the canonical string — bump ONLY as a deliberate re-mapping. */
const KEY_VERSION = 1;
/** Ids beyond this are a caller bug (nothing legitimate approaches it), not lock input. */
const MAX_ID_LENGTH = 256;

/**
 * Deliberately does NOT echo the offending values: ids may become sensitive in future uses.
 * Called by the constructor AND (as the single defense for a FORGED key that bypassed it) at
 * the top of `acquire` — i.e. before any lock statement and before any `work` callback runs.
 */
function assertValidKey(key: OperationLockKey): void {
  if (typeof key.operation !== "string" || key.operation.length === 0) {
    throw new Error("operation lock: operation name must be a non-empty registry entry.");
  }
  if (typeof key.id !== "string" || key.id.length === 0 || key.id.length > MAX_ID_LENGTH) {
    throw new Error(`operation lock: id must be a 1..${MAX_ID_LENGTH} character string.`);
  }
}

/** Builds and validates a lock key. The only intended way to construct one. */
export function operationLockKey(operation: OperationLockName, id: string): OperationLockKey {
  const key: OperationLockKey = { operation, id };
  assertValidKey(key);
  return key;
}

/**
 * PRIVATE: validate, derive and take the xact lock on the given transaction. The ONE place the
 * key is checked on the way in (every public entry point funnels through here before its
 * `work` callback), and the first statement `withOperationLock` issues in its transaction;
 * released automatically at commit/rollback.
 */
async function acquire(tx: DbTransaction, key: OperationLockKey): Promise<void> {
  assertValidKey(key);
  const canonical = JSON.stringify(["enveo-operation-lock", KEY_VERSION, key.operation, key.id]);
  await tx.execute(dsql`SELECT pg_advisory_xact_lock(hashtextextended(${canonical}, 0))`);
}

/**
 * Opens its own transaction, takes the key's lock as the FIRST statement, runs `work` on that
 * same transaction, and commits/rolls back with the callback. Every guarded read/write must use
 * the `tx` argument — reads through the pooled `db` would escape the serialization.
 */
export async function withOperationLock<T>(key: OperationLockKey, work: (tx: DbTransaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await acquire(tx, key); // validates first — an invalid key never reaches `work`
    return work(tx);
  });
}

/**
 * For a transaction the CALLER already owns (never the pooled `db` — rejected at compile time).
 * The lock stays held until the OUTER transaction ends, not merely until the callback returns.
 */
export async function withOperationLockInTx<T>(tx: DbTransaction, key: OperationLockKey, work: (tx: DbTransaction) => Promise<T>): Promise<T> {
  await acquire(tx, key); // validates first — an invalid key never reaches `work`
  return work(tx);
}

/**
 * TEST-ONLY: takes the key's lock on a test-owned transaction so tests can FORCE interleavings
 * (hold the lock, observe waiters via pg_locks) without duplicating the private hash
 * expression. Not for production callers — the numeric key stays an implementation detail.
 */
export async function acquireOperationLockForTests(tx: DbTransaction, key: OperationLockKey): Promise<void> {
  await acquire(tx, key);
}
