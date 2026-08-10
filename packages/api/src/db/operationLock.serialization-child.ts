/**
 * Child process for the DB-backed operation-lock tests in operationLock.test.ts — NOT a test
 * file itself (bun's runner only picks up *.test.ts).
 *
 * WHY A SEPARATE PROCESS. `db/operationLock.ts` runs on the POOLED `db` from `db/client.ts`,
 * which builds its Postgres pool from `env.DATABASE_URL` at IMPORT time, and bun's test runner
 * shares ONE module registry across every test file in a run: whichever suite imports
 * `db/client` first pins that pool for the whole process — and locally `DATABASE_URL` points at
 * a real database (see auth.signup-race-child.ts, which hit the exact hazard first). The lock
 * semantics under test (same backend connection as the callback, transaction scope, pool
 * concurrency) are exactly what cannot be exercised through a test-owned executor, so the whole
 * scenario runs in a fresh process that gets the throwaway `DATABASE_URL` from the test. The
 * EXPECT_DATABASE_URL fuse below refuses to run against anything else.
 *
 * Every interleaving is FORCED (in-callback gates + pg_locks observation), never lucky timing:
 * a caller is only declared "blocked" after pg_locks shows its ungranted advisory waiter.
 *
 * Contract (all app imports are lazy, so the test can import SENTINEL/types from here without
 * pulling in env/db/client):
 *   in  — EXPECT_DATABASE_URL (+ DATABASE_URL, both set to the same throwaway Postgres)
 *   out — one SENTINEL-prefixed JSON line on stdout: LockChildOutput
 */
import { sql as dsql, type SQL } from "drizzle-orm";

export const SENTINEL = "__OPERATION_LOCK_CHILD__";

export type LockChildOutput = {
  serialization: {
    /** Must read ["A-enter", "B-blocked-observed", "A-exit", "B-enter"]. */
    events: string[];
    /** pg_locks showed B's ungranted advisory waiter while A held the lock. */
    waiterObserved: boolean;
    /** Same operation, different id — completed while A still held its lock. */
    otherIdFinishedWhileHeld: boolean;
    /** Different operation, same id — completed while A still held its lock. */
    otherOperationFinishedWhileHeld: boolean;
  };
  rollback: {
    threw: boolean;
    /** The row written inside the throwing callback must NOT survive. */
    rowVisibleAfter: boolean;
    /** A following caller can take the same key (the xact lock was released). */
    reacquiredOk: boolean;
  };
  sameConnection: {
    callbackPid: number;
    /** The advisory lock is held by the SAME backend the callback runs on. */
    lockHeldByCallbackPid: boolean;
  };
  inTx: {
    /** tx handed to the callback is the caller's own transaction object. */
    callbackTxIsOuterTx: boolean;
    /** Lock still held AFTER the callback returned, while the outer tx is open. */
    heldAfterCallbackReturned: boolean;
    /** Lock gone once the outer transaction committed. */
    heldAfterOuterCommit: boolean;
  };
  invalidKeys: {
    emptyOperationRejected: boolean;
    emptyIdRejected: boolean;
    oversizedIdRejected: boolean;
    inTxInvalidRejected: boolean;
    /** Must stay false: an invalid key fails BEFORE the work callback runs. */
    workInvoked: boolean;
  };
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
  // The fuse: this process takes advisory locks and writes rows. Throwaway database only.
  if (!expected || env.DATABASE_URL !== expected) {
    throw new Error(
      `refusing to run: env.DATABASE_URL is not the throwaway database given by the test ` +
        `(EXPECT_DATABASE_URL=${expected || "<unset>"})`,
    );
  }

  const postgres = (await import("postgres")).default;
  const { db } = await import("./client");
  const s = await import("./schema");
  const {
    OPERATION_LOCK,
    operationLockKey,
    withOperationLock,
    withOperationLockInTx,
  } = await import("./operationLock");
  type OperationLockName = (typeof OPERATION_LOCK)[keyof typeof OPERATION_LOCK];
  type Key = ReturnType<typeof operationLockKey>;

  // Independent raw connection — observes pg_locks from OUTSIDE the pooled db.
  const observer = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });

  const advisoryWaiters = async (): Promise<number> => {
    const rows = await observer<{ n: number }[]>`
      select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`;
    return rows[0]?.n ?? 0;
  };
  const advisoryHeldByPid = async (pid: number): Promise<number> => {
    const rows = await observer<{ n: number }[]>`
      select count(*)::int as n from pg_locks
       where locktype = 'advisory' and granted and pid = ${pid}`;
    return rows[0]?.n ?? 0;
  };
  const backendPid = async (x: { execute: (q: SQL) => Promise<unknown> }): Promise<number> => {
    const rows = (await x.execute(dsql`select pg_backend_pid()::int as pid`)) as Array<{
      pid: number;
    }>;
    return Number(rows[0]?.pid);
  };

  /* ── 1+2: same (operation, id) serializes; other id / other operation do not block ── */

  const sameId = `serialize-${crypto.randomUUID()}`;
  const keyA = operationLockKey(OPERATION_LOCK.ensureInitialBudget, sameId);

  const events: string[] = [];
  let releaseA!: () => void;
  const gateA = new Promise<void>((r) => (releaseA = r));
  let signalAEntered!: () => void;
  const aEntered = new Promise<void>((r) => (signalAEntered = r));

  const pA = withOperationLock(keyA, async () => {
    events.push("A-enter");
    signalAEntered();
    await gateA; // A holds the lock until the orchestrator releases it
    events.push("A-exit");
  });
  await withTimeout(aEntered, 10_000, "A entering its callback");

  const pB = withOperationLock(keyA, async () => {
    events.push("B-enter");
  });

  // B is only "blocked" once pg_locks shows its ungranted advisory waiter — no lucky timing.
  let waiterObserved = false;
  for (let i = 0; i < 200 && !waiterObserved; i++) {
    if ((await advisoryWaiters()) >= 1) waiterObserved = true;
    else await Bun.sleep(25);
  }
  events.push("B-blocked-observed");

  // While A still holds (operation, sameId): a different id and a different operation both
  // complete — a derivation that ignored half the tuple would block here.
  const otherIdFinishedWhileHeld = await withTimeout(
    withOperationLock(
      operationLockKey(OPERATION_LOCK.ensureInitialBudget, `other-${crypto.randomUUID()}`),
      async () => true,
    ),
    5_000,
    "different id under a held lock",
  );
  const otherOperationFinishedWhileHeld = await withTimeout(
    withOperationLock(
      // Deliberate cast: the registry has one member today; the point is that the OPERATION
      // half of the tuple reaches the key derivation. Runtime validation only rejects
      // empty/oversized parts — the union is the compile-time guard.
      operationLockKey("test.other-operation" as OperationLockName, sameId),
      async () => true,
    ),
    5_000,
    "different operation under a held lock",
  );

  releaseA();
  await withTimeout(Promise.all([pA, pB]), 10_000, "A and B finishing");

  /* ── 3: a thrown callback rolls back its writes and releases the lock ── */

  const keyRollback = operationLockKey(
    OPERATION_LOCK.ensureInitialBudget,
    `rollback-${crypto.randomUUID()}`,
  );
  const rollbackEmail = `lock-rollback-${crypto.randomUUID()}@example.test`;
  let threw = false;
  try {
    await withOperationLock(keyRollback, async (tx) => {
      await tx.insert(s.users).values({ email: rollbackEmail });
      throw new Error("deliberate rollback");
    });
  } catch {
    threw = true;
  }
  const allEmails = await observer<{ email: string }[]>`
    select email from users where email = ${rollbackEmail}`;
  const rowVisibleAfter = allEmails.length > 0;
  const reacquiredOk = await withTimeout(
    withOperationLock(keyRollback, async () => true),
    5_000,
    "reacquiring after a rollback",
  );

  /* ── 4a: the lock and the callback share ONE backend connection ── */

  let callbackPid = 0;
  let lockHeldByCallbackPid = false;
  await withOperationLock(
    operationLockKey(OPERATION_LOCK.ensureInitialBudget, `samepid-${crypto.randomUUID()}`),
    async (tx) => {
      callbackPid = await backendPid(tx);
      lockHeldByCallbackPid = (await advisoryHeldByPid(callbackPid)) >= 1;
    },
  );

  /* ── 4b: withOperationLockInTx holds until the OUTER transaction commits ── */

  let callbackTxIsOuterTx = false;
  let heldAfterCallbackReturned = false;
  let outerPid = 0;
  await db.transaction(async (outer) => {
    outerPid = await backendPid(outer);
    await withOperationLockInTx(
      outer,
      operationLockKey(OPERATION_LOCK.ensureInitialBudget, `intx-${crypto.randomUUID()}`),
      async (tx) => {
        callbackTxIsOuterTx = tx === outer;
      },
    );
    // callback is DONE — the lock must still be held while the outer tx is open
    heldAfterCallbackReturned = (await advisoryHeldByPid(outerPid)) >= 1;
  });
  let heldAfterOuterCommit = true;
  for (let i = 0; i < 100 && heldAfterOuterCommit; i++) {
    if ((await advisoryHeldByPid(outerPid)) === 0) heldAfterOuterCommit = false;
    else await Bun.sleep(25);
  }

  /* ── 5: invalid keys fail BEFORE the work callback runs ── */

  let workInvoked = false;
  const rejects = async (key: Key): Promise<boolean> => {
    try {
      await withOperationLock(key, async () => {
        workInvoked = true;
      });
      return false;
    } catch {
      return true;
    }
  };
  const forged = (operation: string, id: string): Key => ({ operation, id }) as Key;
  const emptyOperationRejected = await rejects(forged("", "some-id"));
  const emptyIdRejected = await rejects(forged(OPERATION_LOCK.ensureInitialBudget, ""));
  const oversizedIdRejected = await rejects(
    forged(OPERATION_LOCK.ensureInitialBudget, "a".repeat(10_000)),
  );
  let inTxInvalidRejected = false;
  await db.transaction(async (outer) => {
    try {
      await withOperationLockInTx(outer, forged(OPERATION_LOCK.ensureInitialBudget, ""), async () => {
        workInvoked = true;
      });
    } catch {
      inTxInvalidRejected = true;
    }
  });

  const out: LockChildOutput = {
    serialization: {
      events,
      waiterObserved,
      otherIdFinishedWhileHeld,
      otherOperationFinishedWhileHeld,
    },
    rollback: { threw, rowVisibleAfter, reacquiredOk },
    sameConnection: { callbackPid, lockHeldByCallbackPid },
    inTx: { callbackTxIsOuterTx, heldAfterCallbackReturned, heldAfterOuterCommit },
    invalidKeys: {
      emptyOperationRejected,
      emptyIdRejected,
      oversizedIdRejected,
      inTxInvalidRejected,
      workInvoked,
    },
  };

  await observer.end({ timeout: 5 });
  const { sql } = await import("./client");
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
