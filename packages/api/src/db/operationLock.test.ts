/**
 * The generic operation lock (backlog §0b): a typed (operation, id) key mapped INSIDE
 * PostgreSQL to one transaction-scoped advisory lock, serializing an invariant-critical
 * section across API processes.
 *
 *  - pure part (no DB): `operationLockKey` validation and the compile-time guard that the
 *    "InTx" overload cannot accept the pooled `db`;
 *  - DB-backed part: serialization/rollback/connection-identity/xact-scope semantics, run in a
 *    CHILD process (operationLock.serialization-child.ts) because the lock deliberately runs on
 *    the pooled `db`, whose pool is pinned to `env.DATABASE_URL` at import time.
 *
 * OPT-IN: set TEST_DATABASE_URL to a THROWAWAY Postgres — the child takes advisory locks and
 * writes rows. CI provides a service container; locally:
 *   docker run -d --rm --name enveotest -e POSTGRES_USER=enveo \
 *     -e POSTGRES_PASSWORD=enveo -e POSTGRES_DB=enveo \
 *     -p 127.0.0.1:5499:5432 postgres:16-alpine
 *   TEST_DATABASE_URL=postgres://enveo:enveo@127.0.0.1:5499/enveo \
 *     bun test packages/api/src/db/operationLock.test.ts
 * There is deliberately NO fallback to DATABASE_URL (that one points at real data).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
// Constant + type only — the child's app imports are lazy (see its header), so importing it
// here does NOT pull env/db/client into this process.
import { SENTINEL, type LockChildOutput } from "./operationLock.serialization-child";
import * as s from "./schema";
import {
  OPERATION_LOCK,
  operationLockKey,
  withOperationLockInTx,
  type OperationLockKey,
  type OperationLockName,
} from "./operationLock";
import type { db } from "./client";

/* ── operationLockKey: central registry + validation (pure) ─────────────── */

describe("operationLockKey", () => {
  it("builds the (operation, id) key for a registered operation", () => {
    const key = operationLockKey(OPERATION_LOCK.ensureInitialBudget, "user-1");
    expect(key).toEqual({ operation: "budget.ensure-initial", id: "user-1" });
  });

  it("rejects an empty id", () => {
    expect(() => operationLockKey(OPERATION_LOCK.ensureInitialBudget, "")).toThrow();
  });

  it("rejects an unreasonably large id", () => {
    expect(() =>
      operationLockKey(OPERATION_LOCK.ensureInitialBudget, "a".repeat(10_000)),
    ).toThrow();
  });

  it("rejects an empty operation (a forged key cannot pick a lock domain by accident)", () => {
    expect(() => operationLockKey("" as OperationLockName, "user-1")).toThrow();
  });

  it("does not leak the raw id in the validation error (ids may become sensitive)", () => {
    const secret = `secret-${"x".repeat(400)}`;
    try {
      operationLockKey(OPERATION_LOCK.ensureInitialBudget, secret);
      throw new Error("expected operationLockKey to throw");
    } catch (e) {
      expect((e as Error).message).not.toContain("secret-");
    }
  });
});

/* ── Compile-time guard: the InTx overload must reject the pooled db ──────
 *
 * Never executed. If `DbTransaction` ever widened to accept `typeof db`, the
 * @ts-expect-error below would become an "unused directive" and `tsc --noEmit`
 * would fail — that is the whole point of the overload split. */

const _rejectPooledDbAtCompileTime = (pooled: typeof db, key: OperationLockKey): void => {
  void (async () => {
    // @ts-expect-error — the pooled db is not a DbTransaction: a session-scoped acquire through
    // the pool could land on a different connection than the guarded work (the exact misuse the
    // type split exists to prevent).
    await withOperationLockInTx(pooled, key, async () => {});
  });
};
void _rejectPooledDbAtCompileTime;

/* ── The DB-backed semantics (child process) ─────────────────────────────── */

const TEST_URL = process.env.TEST_DATABASE_URL ?? "";
if (TEST_URL && TEST_URL === process.env.DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL — this suite writes to the DB.");
}

const CHILD = new URL("./operationLock.serialization-child.ts", import.meta.url).pathname;

describe.skipIf(!TEST_URL)("operation lock semantics (DB-backed, child process)", () => {
  let out: LockChildOutput;

  beforeAll(async () => {
    const client = postgres(TEST_URL, { max: 1, onnotice: () => {} });
    await migrate(drizzle(client, { schema: s }), {
      migrationsFolder: new URL("../../drizzle", import.meta.url).pathname,
    });
    await client.end({ timeout: 5 });

    const child = Bun.spawn([process.execPath, CHILD], {
      cwd: new URL("../..", import.meta.url).pathname,
      env: { ...process.env, DATABASE_URL: TEST_URL, EXPECT_DATABASE_URL: TEST_URL },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const code = await child.exited;
    const line = stdout.split("\n").find((l) => l.startsWith(SENTINEL));
    if (code !== 0 || !line) {
      throw new Error(
        `operation-lock child failed (exit ${code})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
    out = JSON.parse(line.slice(SENTINEL.length)) as LockChildOutput;
  });

  afterAll(() => {});

  it("the same (operation, id) serializes across independent connections — forced, not lucky", () => {
    // B really parked on the lock (pg_locks showed the ungranted waiter) …
    expect(out.serialization.waiterObserved).toBe(true);
    // … and could only enter after A's callback finished.
    expect(out.serialization.events).toEqual([
      "A-enter",
      "B-blocked-observed",
      "A-exit",
      "B-enter",
    ]);
  });

  it("a different id and a different operation do not block (both tuple halves reach the key)", () => {
    expect(out.serialization.otherIdFinishedWhileHeld).toBe(true);
    expect(out.serialization.otherOperationFinishedWhileHeld).toBe(true);
  });

  it("a thrown callback rolls back its writes and releases the lock for the next caller", () => {
    expect(out.rollback.threw).toBe(true);
    expect(out.rollback.rowVisibleAfter).toBe(false);
    expect(out.rollback.reacquiredOk).toBe(true);
  });

  it("the lock is held by the SAME backend connection the callback runs on", () => {
    expect(out.sameConnection.callbackPid).toBeGreaterThan(0);
    expect(out.sameConnection.lockHeldByCallbackPid).toBe(true);
  });

  it("withOperationLockInTx keeps the lock until the OUTER transaction commits", () => {
    expect(out.inTx.callbackTxIsOuterTx).toBe(true);
    expect(out.inTx.heldAfterCallbackReturned).toBe(true);
    expect(out.inTx.heldAfterOuterCommit).toBe(false);
  });

  it("invalid keys fail before the work callback ever runs", () => {
    expect(out.invalidKeys.emptyOperationRejected).toBe(true);
    expect(out.invalidKeys.emptyIdRejected).toBe(true);
    expect(out.invalidKeys.oversizedIdRejected).toBe(true);
    expect(out.invalidKeys.inTxInvalidRejected).toBe(true);
    expect(out.invalidKeys.workInvoked).toBe(false);
  });
});
