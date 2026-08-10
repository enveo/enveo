/**
 * Child process for the "first-use snapshot/pull/replace vs. a concurrent initializer" lock-
 * order regression test in sync.test.ts — NOT a test file itself (bun's runner only picks up
 * *.test.ts).
 *
 * THE HAZARD UNDER TEST (backlog §0b). An initializer's order is: operation lock → (budget
 * INSERT fires `log_change()`) → SHARED changes-cursor lock. Snapshot/pull/replace take the
 * EXCLUSIVE changes-cursor lock for their barrier. If those routes lazily created the budget
 * INSIDE the barrier transaction, their order would be exclusive changes lock → operation lock
 * — the exact inverse — and a concurrent initializer would deadlock with them. The fix ensures
 * the initial budget through the STANDALONE operation-lock path BEFORE the barrier and resolves
 * only an EXISTING budget inside it.
 *
 * The interleaving is FORCED: a gate transaction holds the fresh user's `budget.ensure-initial`
 * lock while all three routes are fired; pg_locks must show all three parked on the OPERATION
 * lock (waiters on the changes-cursor key are excluded from the count); the changes-cursor lock
 * must be FREE at that moment (probed with a short statement_timeout); the gate then inserts
 * the budget — the trigger's shared changes lock must not deadlock — and commits. All three
 * routes must finish 200 on the gate's budget id, with exactly one budget row at the end.
 *
 * WHY A SEPARATE PROCESS: the route handlers run on the POOLED `db` (db/client.ts), pinned to
 * `env.DATABASE_URL` at import time — see auth.signup-race-child.ts. The EXPECT_DATABASE_URL
 * fuse refuses anything but the throwaway Postgres.
 *
 * Contract (all app imports are lazy):
 *   in  — EXPECT_DATABASE_URL (+ DATABASE_URL, both set to the same throwaway Postgres)
 *   out — one SENTINEL-prefixed JSON line on stdout: FirstUseBarrierOutput
 */
export const SENTINEL = "__SYNC_FIRST_USE_BARRIER__";

export type FirstUseBarrierOutput = {
  /** All three routes parked on the OPERATION lock (not the changes lock) while the gate held it. */
  parkedBeforeBarrier: boolean;
  /** The exclusive changes-cursor lock was acquirable while they waited — none of them held it. */
  changesLockFreeWhileParked: boolean;
  /** The gate's budget INSERT (trigger → shared changes lock) went through without deadlocking. */
  gateInsertCompleted: boolean;
  gateBudgetId: string;
  snapshotStatus: number;
  pullStatus: number;
  replaceStatus: number;
  snapshotBudgetId: string | null;
  pullBudgetId: string | null;
  replaceBudgetId: string | null;
  /** Exactly one budget row — a concurrent initializer cannot split writes across budget ids. */
  budgetRowCount: number;
};

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    p,
    Bun.sleep(ms).then(() => {
      throw new Error(`timeout after ${ms}ms: ${label}`);
    }),
  ]);

async function main(): Promise<void> {
  const expected = process.env.EXPECT_DATABASE_URL ?? "";
  const { env } = await import("../env");
  // The fuse: this process writes users/budgets rows and wipes a budget. Throwaway DB only.
  if (!expected || env.DATABASE_URL !== expected) {
    throw new Error(
      `refusing to run: env.DATABASE_URL is not the throwaway database given by the test ` +
        `(EXPECT_DATABASE_URL=${expected || "<unset>"})`,
    );
  }

  const postgres = (await import("postgres")).default;
  const { eq } = await import("drizzle-orm");
  const { Hono } = await import("hono");
  const { db } = await import("../db/client");
  const s = await import("../db/schema");
  const { syncRoutes } = await import("./sync");
  const { OPERATION_LOCK, operationLockKey, acquireOperationLockForTests } = await import(
    "../db/operationLock"
  );

  const observer = postgres(env.DATABASE_URL, { max: 2, onnotice: () => {} });

  /** Ungranted advisory waiters EXCLUDING the changes-cursor key — i.e. operation-lock waiters. */
  const operationLockWaiters = async (): Promise<number> => {
    const rows = await observer<{ n: number }[]>`
      with k as (select hashtext('enveo:changes')::bigint as key)
      select count(*)::int as n
        from pg_locks, k
       where locktype = 'advisory' and not granted
         and not (classid = ((k.key >> 32) & 4294967295)::oid
                  and objid = (k.key & 4294967295)::oid
                  and objsubid = 1)`;
    return rows[0]?.n ?? 0;
  };

  const [user] = await db
    .insert(s.users)
    .values({ email: `first-use-barrier-${crypto.randomUUID()}@example.test` })
    .returning({ id: s.users.id });
  const userId = user!.id;

  // Minimal stand-in for index.ts's session middleware (same as sync.replace-recurrence-child).
  const app = new Hono<{ Variables: { userId?: string } }>();
  app.use("*", async (c, next) => {
    c.set("userId", userId);
    await next();
  });
  app.route("/api", syncRoutes);

  const EMPTY_LEDGER = {
    accounts: [],
    groups: [],
    envelopes: [],
    categories: [],
    places: [],
    allocations: [],
    transactions: [],
  };

  /* Gate: hold the user's ensure-initial lock, park all three routes, probe, insert, commit. */

  let releaseGate!: () => void;
  const gate = new Promise<void>((r) => (releaseGate = r));
  let signalHeld!: () => void;
  const held = new Promise<void>((r) => (signalHeld = r));
  let gateBudgetId = "";
  let gateInsertCompleted = false;

  const gateTx = db
    .transaction(async (tx) => {
      await acquireOperationLockForTests(
        tx,
        operationLockKey(OPERATION_LOCK.ensureInitialBudget, userId),
      );
      signalHeld();
      await gate; // orchestrator: routes parked + changes lock probed
      // The concurrent initializer's second step: INSERT fires log_change() → SHARED changes
      // lock. If any parked route held the EXCLUSIVE changes lock, this would deadlock.
      const [b] = await tx
        .insert(s.budgets)
        .values({ userId, name: "Budget" })
        .returning({ id: s.budgets.id });
      gateBudgetId = b!.id;
      gateInsertCompleted = true;
    })
    .catch((e) => {
      // deadlock/timeout — recorded via gateInsertCompleted=false; do not hang the child
      console.error("gate transaction failed:", e);
    });
  await withTimeout(held, 10_000, "gate acquiring the operation lock");

  const pSnapshot = app.fetch(new Request("http://x/api/sync/snapshot"));
  const pPull = app.fetch(new Request("http://x/api/sync/pull?since=0"));
  const pReplace = app.fetch(
    new Request("http://x/api/sync/replace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ledger: EMPTY_LEDGER, userId }),
    }),
  );

  let parkedBeforeBarrier = false;
  for (let i = 0; i < 400 && !parkedBeforeBarrier; i++) {
    if ((await operationLockWaiters()) >= 3) parkedBeforeBarrier = true;
    else await Bun.sleep(25);
  }

  // While all three wait on the OPERATION lock, the exclusive changes-cursor lock must be free
  // — the pre-fix code would be holding it here (barrier first, lazy resolve second).
  let changesLockFreeWhileParked = false;
  try {
    await observer.begin(async (ptx) => {
      await ptx`set local statement_timeout = 2000`;
      await ptx`select pg_advisory_xact_lock(hashtext('enveo:changes')::bigint)`;
    }); // released at commit
    changesLockFreeWhileParked = true;
  } catch {
    changesLockFreeWhileParked = false;
  }

  releaseGate();
  await withTimeout(gateTx, 15_000, "gate committing its budget insert");

  const [rSnapshot, rPull, rReplace] = await withTimeout(
    Promise.all([pSnapshot, pPull, pReplace]),
    30_000,
    "snapshot/pull/replace finishing after the gate released",
  );
  const budgetIdOf = async (r: Response): Promise<string | null> => {
    const body = (await r.json().catch(() => ({}))) as { budgetId?: string };
    return body.budgetId ?? null;
  };

  const budgetRows = await db
    .select({ id: s.budgets.id })
    .from(s.budgets)
    .where(eq(s.budgets.userId, userId));

  const out: FirstUseBarrierOutput = {
    parkedBeforeBarrier,
    changesLockFreeWhileParked,
    gateInsertCompleted,
    gateBudgetId,
    snapshotStatus: rSnapshot.status,
    pullStatus: rPull.status,
    replaceStatus: rReplace.status,
    snapshotBudgetId: await budgetIdOf(rSnapshot),
    pullBudgetId: await budgetIdOf(rPull),
    replaceBudgetId: await budgetIdOf(rReplace),
    budgetRowCount: budgetRows.length,
  };

  await observer.end({ timeout: 5 });
  const { sql } = await import("../db/client");
  await sql.end({ timeout: 5 });
  await Bun.write(Bun.stdout, `${SENTINEL}${JSON.stringify(out)}\n`);
  process.exit(0);
}

// Only when RUN as a process — importing this module (for SENTINEL) must have no side effects.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
