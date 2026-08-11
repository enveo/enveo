/**
 * Lazy initial-budget creation under the generic operation lock (backlog §0b).
 *
 * The defect: two concurrent FIRST requests could both observe "no budget" and both insert one
 * — accidental initialization, not intentional multi-budget creation (which stays a valid
 * future feature: budgets.user_id is deliberately NOT unique). The fix serializes ONLY the
 * "ensure an initial budget exists" critical section on the `budget.ensure-initial` operation
 * lock; the fast path (a budget already exists) takes no lock at all.
 *
 * DB-backed via a CHILD process (context.budget-init.test-child.ts): the locked path runs on the
 * pooled `db`, pinned to `env.DATABASE_URL` at import time. The race is FORCED — a gate holds
 * the user's operation lock until pg_locks shows both initializers parked.
 *
 * OPT-IN: set TEST_DATABASE_URL to a THROWAWAY Postgres — the child migrates nothing but WRITES
 * users/budgets rows. CI provides a service container; locally:
 *   docker run -d --rm --name enveotest -e POSTGRES_USER=enveo \
 *     -e POSTGRES_PASSWORD=enveo -e POSTGRES_DB=enveo \
 *     -p 127.0.0.1:5499:5432 postgres:16-alpine
 *   TEST_DATABASE_URL=postgres://enveo:enveo@127.0.0.1:5499/enveo \
 *     bun test packages/api/src/context.test.ts
 * There is deliberately NO fallback to DATABASE_URL (that one points at real data).
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
// Constant + type only — the child's app imports are lazy (see its header), so importing it
// here does NOT pull env/db/client into this process.
import { SENTINEL, type BudgetInitOutput } from "./context.budget-init.test-child";
import { runChild } from "./api.test-support";

/** The child forces real lock waits (bounded pg_locks polling) — beyond bun's 5 s default.
 *  Applied to the ONE hook that spawns it, NOT via setDefaultTimeout (process-global in bun:
 *  it would silently relax every other suite sharing the run). */
const CHILD_TIMEOUT_MS = 120_000;
import * as s from "./db/schema";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "";
if (TEST_URL && TEST_URL === process.env.DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL — this suite writes to the DB.");
}

const CHILD = new URL("./context.budget-init.test-child.ts", import.meta.url).pathname;

describe.skipIf(!TEST_URL)("getBudgetId: serialized lazy initial-budget creation", () => {
  let out: BudgetInitOutput;

  beforeAll(async () => {
    const client = postgres(TEST_URL, { max: 1, onnotice: () => {} });
    await migrate(drizzle(client, { schema: s }), {
      migrationsFolder: new URL("../drizzle", import.meta.url).pathname,
    });
    await client.end({ timeout: 5 });

    out = await runChild<BudgetInitOutput>({
      path: CHILD,
      testUrl: TEST_URL,
      sentinel: SENTINEL,
      cwd: new URL(".", import.meta.url).pathname,
    });
  }, CHILD_TIMEOUT_MS);

  it("two concurrent first calls really raced (both parked on the operation lock)", () => {
    expect(out.race.bothParkedObserved).toBe(true);
  });

  it("…and both returned the SAME id, leaving exactly one budget row", () => {
    expect(out.race.idA).toBe(out.race.idB);
    expect(out.race.budgetRowCount).toBe(1);
  });

  it("…and the changes journal carries exactly ONE budget insert (no no-op noise)", () => {
    expect(out.race.journalInsertCount).toBe(1);
  });

  it("two different new users initialize independently and get distinct budgets", () => {
    expect(out.twoUsers.id1).not.toBe(out.twoUsers.id2);
    expect(out.twoUsers.rowCount1).toBe(1);
    expect(out.twoUsers.rowCount2).toBe(1);
  });

  it("a caller-owned transaction locks IN PLACE (withOperationLockInTx), creating one budget", () => {
    // Guards the executor discrimination: the lock is held by the OUTER transaction's own
    // backend while it is still open — the pooled path would have locked another connection.
    expect(out.inTxPath.lockHeldByOuterTxPid).toBe(true);
    expect(out.inTxPath.createdId).not.toBe("");
    expect(out.inTxPath.rowCount).toBe(1);
  });

  it("an existing single budget takes the fast path: returned as-is, no new rows, no journal noise", () => {
    expect(out.fastPath.existingReturned).toBe(true);
    expect(out.fastPath.rowCountAfter).toBe(1);
    expect(out.fastPath.journalRowsAdded).toBe(0);
  });

  it("a pre-existing multi-budget user keeps both rows and the deterministic ORDER BY id selection", () => {
    expect(out.multiBudget.returnedId).toBe(out.multiBudget.minId);
    expect(out.multiBudget.rowCountAfter).toBe(2);
  });

  it("getBudgetId(null) — the non-HTTP single-budget convenience — still works", () => {
    expect(out.nullCtxReturnedABudget).toBe(true);
  });
});
