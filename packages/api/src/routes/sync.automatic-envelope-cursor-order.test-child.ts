/**
 * Forced changes-cursor/lifecycle interleavings. A blocker pauses each lifecycle DML after its
 * row pre-locks but before the journal trigger asks for the shared cursor lock. An exclusive
 * barrier is then allowed to touch the same row. A correct writer protocol parks on the cursor
 * before taking lifecycle rows; the old trigger-only protocol forms a real 40P01 cycle.
 *
 * Imports stay lazy so the parent test can read this output contract without binding the API
 * pool to an ambient (potentially real) DATABASE_URL.
 */

import type { SQL } from "drizzle-orm";

export const SENTINEL = "__SYNC_AUTOMATIC_ENVELOPE_CURSOR_ORDER__";

type ScenarioOutput = {
  lifecycleWaitObserved: boolean;
  lifecycleWaitedOnCursor: boolean;
  barrierWaitedOnLifecycleRow: boolean;
  lifecycleCompleted: boolean;
  barrierCompleted: boolean;
  lifecycleError: string | null;
  barrierError: string | null;
  deadlockDetected: boolean;
  syncClaimPersisted: boolean | null;
};

export type AutomaticEnvelopeCursorOrderOutput = {
  accountCreate: ScenarioOutput;
  accountUpdate: ScenarioOutput;
  syncAccountUpdate: ScenarioOutput;
  envelopeArchive: ScenarioOutput;
  envelopeDelete: ScenarioOutput;
  groupDelete: ScenarioOutput;
  fullWipe: ScenarioOutput;
};

type ScenarioKind = keyof AutomaticEnvelopeCursorOrderOutput;

async function main(): Promise<void> {
  const { assertThrowawayDb, emitChildResult, waitFor, withTimeout } = await import("../api.test-support");
  const { env } = await import("../env");
  assertThrowawayDb(env.DATABASE_URL);

  const { eq, sql: dsql } = await import("drizzle-orm");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const postgres = (await import("postgres")).default;
  const { db, sql } = await import("../db/client");
  const s = await import("../db/schema");
  const { applyAccountCreate, applyAccountUpdate, applyEnvelopeDelete, applyEnvelopeUpdate, applyGroupDelete, wipeBudgetData } = await import("../sync/apply");
  const { applyPushOp, CHANGES_CURSOR_LOCK_TEXT } = await import("./sync");

  await migrate(drizzle(sql, { schema: s }), { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });

  const observer = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
  const pause = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
  const cursorRows = await observer<{ key: string }[]>`select hashtext(${CHANGES_CURSOR_LOCK_TEXT})::bigint::text as key`;
  const cursorKey = cursorRows[0]?.key;
  if (!cursorKey) throw new Error("changes cursor key was not resolved");

  await observer.unsafe(`
    create or replace function enveo_test_pause_lifecycle_dml() returns trigger
    language plpgsql as $$
    declare row_id text;
    begin
      row_id := case when TG_OP = 'DELETE' then OLD.id::text else NEW.id::text end;
      if row_id = TG_ARGV[0] then
        perform pg_advisory_xact_lock(TG_ARGV[1]::bigint);
      end if;
      if TG_OP = 'DELETE' then return OLD; end if;
      return NEW;
    end;
    $$;
  `);

  const backendPid = async (x: { execute: (query: SQL) => Promise<unknown> }): Promise<number> => {
    const rows = (await x.execute(dsql`select pg_backend_pid()::int as pid`)) as Array<{ pid: number }>;
    return Number(rows[0]?.pid);
  };
  const errorCode = (error: unknown): string => {
    let current: unknown = error;
    while (current && typeof current === "object") {
      if ("code" in current && typeof current.code === "string") return current.code;
      current = "cause" in current ? current.cause : null;
    }
    return error instanceof Error ? error.message : String(error);
  };
  const blockersOf = async (pid: number): Promise<number[]> => {
    const rows = await observer<{ blockers: number[] }[]>`select pg_blocking_pids(${pid}) as blockers`;
    return rows[0]?.blockers ?? [];
  };
  const activeLockWaiterBlockedBy = async (blockerPids: number[]): Promise<number | null> => {
    const rows = await observer<{ pid: number }[]>`
      select pid::int as pid
        from pg_stat_activity
       where datname = current_database()
         and wait_event_type = 'Lock'
         and cardinality(pg_blocking_pids(pid)) > 0
         and pg_blocking_pids(pid) && ${blockerPids}::int[]
       order by pid
       limit 1`;
    return rows[0]?.pid ?? null;
  };

  let sequence = 0;
  const runScenario = async (kind: ScenarioKind): Promise<ScenarioOutput> => {
    sequence++;
    const pauseKey = 8_600_000_000 + sequence;
    const suffix = `${kind.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}_${sequence}`;
    const [user] = await db
      .insert(s.users)
      .values({ email: `cursor-${suffix}-${crypto.randomUUID()}@example.test` })
      .returning({ id: s.users.id });
    const [budget] = await db
      .insert(s.budgets)
      .values({ userId: user!.id, name: `Cursor ${suffix}` })
      .returning({ id: s.budgets.id });
    const [group] = await db
      .insert(s.envelopeGroups)
      .values({ budgetId: budget!.id, name: `Group ${suffix}` })
      .returning({ id: s.envelopeGroups.id });
    const [envelope] = await db
      .insert(s.envelopes)
      .values({ budgetId: budget!.id, groupId: group!.id, name: `Envelope ${suffix}` })
      .returning({ id: s.envelopes.id });
    const accountId = crypto.randomUUID();
    if (kind !== "accountCreate") {
      await db.insert(s.accounts).values({
        id: accountId,
        budgetId: budget!.id,
        name: `Account ${suffix}`,
        automaticEnvelopeId: kind === "envelopeArchive" ? null : envelope!.id,
      });
    }

    const trigger = `enveo_cursor_${suffix}`;
    const triggerTarget =
      kind === "accountCreate" || kind === "accountUpdate" || kind === "syncAccountUpdate" || kind === "fullWipe"
        ? "accounts"
        : kind === "groupDelete"
          ? "envelope_groups"
          : "envelopes";
    const triggerEvent = kind === "accountCreate" ? "insert" : kind === "envelopeDelete" || kind === "groupDelete" || kind === "fullWipe" ? "delete" : "update";
    const triggerRowId =
      kind === "accountCreate" || kind === "accountUpdate" || kind === "syncAccountUpdate" || kind === "fullWipe"
        ? accountId
        : kind === "groupDelete"
          ? group!.id
          : envelope!.id;
    await observer.unsafe(
      `create trigger ${trigger} before ${triggerEvent} on ${triggerTarget} ` +
        `for each row execute function enveo_test_pause_lifecycle_dml('${triggerRowId}', '${pauseKey}')`,
    );

    await pause`select pg_advisory_lock(${pauseKey}::bigint)`;
    const pausePidRows = await pause<{ pid: number }[]>`select pg_backend_pid()::int as pid`;
    const pausePid = pausePidRows[0]!.pid;

    let releaseBarrier!: () => void;
    const barrierGate = new Promise<void>((resolve) => (releaseBarrier = resolve));
    let signalBarrierLocked!: (pid: number) => void;
    const barrierLocked = new Promise<number>((resolve) => (signalBarrierLocked = resolve));
    let barrierSettled = false;
    const barrier = db
      .transaction(async (tx) => {
        await tx.execute(dsql`set local deadlock_timeout = '100ms'`);
        const pid = await backendPid(tx);
        await tx.execute(dsql`select pg_advisory_xact_lock(${cursorKey}::bigint)`);
        signalBarrierLocked(pid);
        await barrierGate;
        if (kind === "accountCreate" || kind === "envelopeArchive") {
          await tx.select({ id: s.envelopes.id }).from(s.envelopes).where(eq(s.envelopes.id, envelope!.id)).for("update");
        } else {
          await tx.select({ id: s.accounts.id }).from(s.accounts).where(eq(s.accounts.id, accountId)).for("update");
        }
      })
      .then(
        () => ({ completed: true, error: null as string | null }),
        (error) => ({ completed: false, error: errorCode(error) }),
      )
      .finally(() => {
        barrierSettled = true;
      });
    const barrierPid = await withTimeout(barrierLocked, 10_000, `${kind}: exclusive cursor lock`);

    let lifecyclePid: number | null = null;
    const syncOpId = kind === "syncAccountUpdate" ? crypto.randomUUID() : null;
    const lifecycle =
      kind === "syncAccountUpdate"
        ? applyPushOp(budget!.id, `cursor-${suffix}`, {
            opId: syncOpId!,
            kind: "account.update",
            payload: { id: accountId, name: `Updated ${suffix}` },
          })
            .then((result) => {
              if (result.status !== "applied") throw new Error(result.error ?? result.status);
            })
            .then(
              () => ({ completed: true, error: null as string | null }),
              (error) => ({ completed: false, error: errorCode(error) }),
            )
        : db
            .transaction(async (tx) => {
              await tx.execute(dsql`set local deadlock_timeout = '100ms'`);
              lifecyclePid = await backendPid(tx);
              switch (kind) {
                case "accountCreate":
                  await applyAccountCreate(tx, budget!.id, { id: accountId, name: `Created ${suffix}`, automaticEnvelopeId: envelope!.id });
                  return;
                case "accountUpdate":
                  await applyAccountUpdate(tx, budget!.id, { id: accountId, name: `Updated ${suffix}` });
                  return;
                case "envelopeArchive":
                  await applyEnvelopeUpdate(tx, budget!.id, { id: envelope!.id, archived: true });
                  return;
                case "envelopeDelete":
                  await applyEnvelopeDelete(tx, budget!.id, envelope!.id);
                  return;
                case "groupDelete":
                  await applyGroupDelete(tx, budget!.id, group!.id);
                  return;
                case "fullWipe":
                  await wipeBudgetData(tx, budget!.id);
                  return;
                default:
                  throw new Error(`unhandled scenario ${kind}`);
              }
            })
            .then(
              () => ({ completed: true, error: null as string | null }),
              (error) => ({ completed: false, error: errorCode(error) }),
            );

    const lifecycleWaitObserved = await waitFor(
      async () => {
        if (lifecyclePid !== null) return (await blockersOf(lifecyclePid)).length > 0;
        lifecyclePid = await activeLockWaiterBlockedBy([barrierPid, pausePid]);
        return lifecyclePid !== null;
      },
      { attempts: 400, intervalMs: 25 },
    );
    const lifecycleWaitedOnCursor = lifecyclePid !== null && (await blockersOf(lifecyclePid)).includes(barrierPid);

    releaseBarrier();
    const barrierWaitedOnLifecycleRow = await waitFor(
      async () => {
        if (barrierSettled || lifecyclePid === null) return false;
        return (await blockersOf(barrierPid)).includes(lifecyclePid);
      },
      { attempts: 20, intervalMs: 25 },
    );
    await waitFor(async () => barrierSettled, { attempts: 20, intervalMs: 25 });
    await pause`select pg_advisory_unlock(${pauseKey}::bigint)`;

    const [lifecycleResult, barrierResult] = await withTimeout(Promise.all([lifecycle, barrier]), 20_000, `${kind}: transactions finishing`);
    const [claim] = syncOpId ? await db.select({ opId: s.syncOps.opId }).from(s.syncOps).where(eq(s.syncOps.opId, syncOpId)) : [];
    await observer.unsafe(`drop trigger if exists ${trigger} on ${triggerTarget}`);

    return {
      lifecycleWaitObserved,
      lifecycleWaitedOnCursor,
      barrierWaitedOnLifecycleRow,
      lifecycleCompleted: lifecycleResult.completed,
      barrierCompleted: barrierResult.completed,
      lifecycleError: lifecycleResult.error,
      barrierError: barrierResult.error,
      deadlockDetected: lifecycleResult.error === "40P01" || barrierResult.error === "40P01",
      syncClaimPersisted: syncOpId ? claim?.opId === syncOpId : null,
    };
  };

  const out: AutomaticEnvelopeCursorOrderOutput = {
    accountCreate: await runScenario("accountCreate"),
    accountUpdate: await runScenario("accountUpdate"),
    syncAccountUpdate: await runScenario("syncAccountUpdate"),
    envelopeArchive: await runScenario("envelopeArchive"),
    envelopeDelete: await runScenario("envelopeDelete"),
    groupDelete: await runScenario("groupDelete"),
    fullWipe: await runScenario("fullWipe"),
  };

  await observer.unsafe("drop function if exists enveo_test_pause_lifecycle_dml() cascade");
  await Promise.all([observer.end({ timeout: 5 }), pause.end({ timeout: 5 }), sql.end({ timeout: 5 })]);
  await emitChildResult(SENTINEL, out);
  process.exit(0);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
