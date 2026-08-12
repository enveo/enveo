/**
 * Child process for the lazy initial-budget serialization tests in context.test.ts — NOT a test
 * file itself (bun's runner only picks up *.test.ts).
 *
 * WHY A SEPARATE PROCESS. `getBudgetId`'s locked ensure path deliberately runs on the POOLED
 * `db` (db/client.ts), whose Postgres pool is pinned to `env.DATABASE_URL` at IMPORT time, and
 * bun's test runner shares ONE module registry across every test file — locally `DATABASE_URL`
 * points at a real database (see auth.signup-race.test-child.ts). The EXPECT_DATABASE_URL fuse below
 * refuses to run against anything but the throwaway Postgres the test hands over.
 *
 * The two-initializer race is FORCED, not lucky: a gate transaction holds the user's
 * `budget.ensure-initial` operation lock (via the test-only acquire helper) until pg_locks
 * shows BOTH `getBudgetId` calls parked as ungranted advisory waiters.
 *
 * Contract (all app imports are lazy, so the test can import SENTINEL/types from here without
 * pulling in env/db/client):
 *   in  — EXPECT_DATABASE_URL (+ DATABASE_URL, both set to the same throwaway Postgres)
 *   out — one SENTINEL-prefixed JSON line on stdout: BudgetInitOutput
 */
import { and, sql as dsql, eq } from "drizzle-orm";
import { assertThrowawayDb, emitChildResult, lockObserver, waitFor, withTimeout } from "./api.test-support";

export const SENTINEL = "__BUDGET_INIT_CHILD__";

export type BudgetInitOutput = {
  race: {
    /** pg_locks showed BOTH initializers parked on the operation lock (the race is not vacuous). */
    bothParkedObserved: boolean;
    idA: string;
    idB: string;
    /** Budget rows for the user afterwards — must be exactly 1. */
    budgetRowCount: number;
    /** `changes` journal rows for that budget insert — must be exactly 1 (no no-op noise). */
    journalInsertCount: number;
  };
  twoUsers: {
    id1: string;
    id2: string;
    rowCount1: number;
    rowCount2: number;
  };
  /** Lazy creation through a CALLER-OWNED transaction (the withOperationLockInTx path). */
  inTxPath: {
    createdId: string;
    rowCount: number;
    /** The lock was held by the OUTER transaction's backend — i.e. the InTx path really ran. */
    lockHeldByOuterTxPid: boolean;
  };
  fastPath: {
    /** A pre-existing single budget is returned as-is … */
    existingReturned: boolean;
    rowCountAfter: number;
    /** … and the fast path leaves NO new journal rows behind. */
    journalRowsAdded: number;
  };
  multiBudget: {
    returnedId: string;
    /** The smallest budgets.id — the pre-existing deterministic selection (ORDER BY id). */
    minId: string;
    rowCountAfter: number;
  };
  /** getBudgetId(null) — the non-HTTP single-budget convenience still works. */
  nullCtxReturnedABudget: boolean;
};

async function main(): Promise<void> {
  const { env } = await import("./env");
  // The fuse: this process writes budgets/users rows. Throwaway database only.
  assertThrowawayDb(env.DATABASE_URL);

  const postgres = (await import("postgres")).default;
  const { db } = await import("./db/client");
  const s = await import("./db/schema");
  const { getBudgetId } = await import("./context");
  const { OPERATION_LOCK, operationLockKey, acquireOperationLockForTests } = await import("./db/operationLock");

  const observer = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
  const locks = lockObserver(observer);

  const newUser = async (tag: string): Promise<string> => {
    const [u] = await db
      .insert(s.users)
      .values({ email: `budget-init-${tag}-${crypto.randomUUID()}@example.test` })
      .returning({ id: s.users.id });
    return u!.id;
  };
  const ctxFor = (userId: string) => ({ get: (_k: "userId") => userId });
  const budgetRowsOf = async (userId: string) => db.select({ id: s.budgets.id }).from(s.budgets).where(eq(s.budgets.userId, userId));
  const journalInsertsOf = async (budgetId: string): Promise<number> => {
    const rows = await db
      .select({ seq: s.changes.seq })
      .from(s.changes)
      .where(and(eq(s.changes.tableName, "budgets"), eq(s.changes.rowId, budgetId), eq(s.changes.op, "upsert")));
    return rows.length;
  };

  /* ── 6: two deliberately concurrent FIRST calls converge on one budget ── */

  const raceUser = await newUser("race");
  const raceKey = operationLockKey(OPERATION_LOCK.ensureInitialBudget, raceUser);

  let releaseGate!: () => void;
  const gate = new Promise<void>((r) => (releaseGate = r));
  let signalHeld!: () => void;
  const held = new Promise<void>((r) => (signalHeld = r));
  const gateTx = db.transaction(async (tx) => {
    await acquireOperationLockForTests(tx, raceKey);
    signalHeld();
    await gate;
  });
  await withTimeout(held, 10_000, "gate acquiring the operation lock");

  // Both take the fast path (no budget yet), then must park on the held operation lock.
  const pA = getBudgetId(ctxFor(raceUser));
  const pB = getBudgetId(ctxFor(raceUser));
  const bothParkedObserved = await waitFor(async () => (await locks.waiters()) >= 2);
  releaseGate();
  await withTimeout(gateTx, 15_000, "gate releasing the operation lock");
  const [idA, idB] = await withTimeout(Promise.all([pA, pB]), 30_000, "both initializers finishing");

  const race: BudgetInitOutput["race"] = {
    bothParkedObserved,
    idA,
    idB,
    budgetRowCount: (await budgetRowsOf(raceUser)).length,
    journalInsertCount: await journalInsertsOf(idA),
  };

  /* ── 7: two different new users initialize independently ── */

  const [user1, user2] = await Promise.all([newUser("u1"), newUser("u2")]);
  const [id1, id2] = await Promise.all([getBudgetId(ctxFor(user1!)), getBudgetId(ctxFor(user2!))]);
  const twoUsers: BudgetInitOutput["twoUsers"] = {
    id1,
    id2,
    rowCount1: (await budgetRowsOf(user1!)).length,
    rowCount2: (await budgetRowsOf(user2!)).length,
  };

  /* ── The InTx path: lazy creation inside a transaction the CALLER owns ──
   *
   * Routes that already hold a transaction (demo.ts, the sync2 tier flips) pass it to
   * requireTier → getBudgetId, which must lock IN PLACE (withOperationLockInTx) instead of
   * opening a second transaction on another pool connection. Proven by observing that the
   * advisory lock is held by the OUTER transaction's own backend pid while it is still open:
   * had the pooled path run, that lock would live on a different connection and be gone by the
   * time the callback returns. This is the regression guard for the executor discrimination. */

  const inTxUser = await newUser("intx");
  let inTxCreatedId = "";
  let lockHeldByOuterTxPid = false;
  await db.transaction(async (tx) => {
    const rows = (await tx.execute(dsql`select pg_backend_pid()::int as pid`)) as Array<{
      pid: number;
    }>;
    const outerPid = Number(rows[0]?.pid);
    inTxCreatedId = await getBudgetId(ctxFor(inTxUser), tx);
    lockHeldByOuterTxPid = (await locks.heldByPid(outerPid)) >= 1;
  });
  const inTxPath: BudgetInitOutput["inTxPath"] = {
    createdId: inTxCreatedId,
    rowCount: (await budgetRowsOf(inTxUser)).length,
    lockHeldByOuterTxPid,
  };

  /* ── 8a: an existing single budget takes the fast path — returned, not replaced ── */

  const fastUser = await newUser("fast");
  const [preexisting] = await db.insert(s.budgets).values({ userId: fastUser, name: "Existing" }).returning({ id: s.budgets.id });
  const journalBefore = await journalInsertsOf(preexisting!.id);
  const fastResolved = await getBudgetId(ctxFor(fastUser));
  const fastPath: BudgetInitOutput["fastPath"] = {
    existingReturned: fastResolved === preexisting!.id,
    rowCountAfter: (await budgetRowsOf(fastUser)).length,
    journalRowsAdded: (await journalInsertsOf(preexisting!.id)) - journalBefore,
  };

  /* ── 8b: a pre-existing multi-budget user keeps BOTH rows and the ORDER BY id selection ── */

  const multiUser = await newUser("multi");
  const inserted = await db
    .insert(s.budgets)
    .values([
      { userId: multiUser, name: "One" },
      { userId: multiUser, name: "Two" },
    ])
    .returning({ id: s.budgets.id });
  const minId = inserted
    .map((r) => r.id)
    .sort()
    .at(0)!;
  const multiResolved = await getBudgetId(ctxFor(multiUser));
  const multiBudget: BudgetInitOutput["multiBudget"] = {
    returnedId: multiResolved,
    minId,
    rowCountAfter: (await budgetRowsOf(multiUser)).length,
  };

  /* ── getBudgetId(null): non-HTTP single-budget convenience preserved ── */

  const nullResolved = await getBudgetId(null);
  const nullCtxReturnedABudget = typeof nullResolved === "string" && nullResolved.length > 0;

  const out: BudgetInitOutput = {
    race,
    twoUsers,
    inTxPath,
    fastPath,
    multiBudget,
    nullCtxReturnedABudget,
  };

  await observer.end({ timeout: 5 });
  const { sql } = await import("./db/client");
  await sql.end({ timeout: 5 });
  await emitChildResult(SENTINEL, out);
  process.exit(0);
}

// Only when RUN as a process — importing this module (for SENTINEL) must have no side effects.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
