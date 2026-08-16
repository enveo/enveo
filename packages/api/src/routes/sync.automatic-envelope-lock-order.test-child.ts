/**
 * Forced lock-order regression for automatic-envelope removal paths. A transaction holds a
 * linked account row, a competing delete/wipe is observed waiting on a database lock, and only
 * then does the account transaction continue toward the linked envelope. With an inverted
 * envelope→account path PostgreSQL detects a real deadlock; account→envelope lets both finish.
 *
 * Imports stay lazy so the parent test can import only this output contract without pinning its
 * pooled database to an ambient (potentially real) DATABASE_URL.
 */

import type { SQL } from "drizzle-orm";

export const SENTINEL = "__SYNC_AUTOMATIC_ENVELOPE_LOCK_ORDER__";

type ScenarioOutput = {
  waiterObserved: boolean;
  updateCompleted: boolean;
  competingCompleted: boolean;
  updateError: string | null;
  competingError: string | null;
  finalStateValid: boolean;
};

export type AutomaticEnvelopeLockOrderOutput = {
  envelopeDelete: ScenarioOutput;
  fullWipe: ScenarioOutput;
  multiAccountWipe: ScenarioOutput;
};

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
  const { applyAccountUpdate, applyEnvelopeDelete, wipeBudgetData } = await import("../sync/apply");

  await migrate(drizzle(sql, { schema: s }), { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
  const observer = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });

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
  const waitingOnLock = async (pid: number): Promise<boolean> => {
    const rows = await observer<{ waiting: boolean }[]>`
      select coalesce(wait_event_type = 'Lock', false) as waiting
        from pg_stat_activity where pid = ${pid}`;
    return rows[0]?.waiting ?? false;
  };

  const [user] = await db
    .insert(s.users)
    .values({ email: `automatic-envelope-lock-order-${crypto.randomUUID()}@example.test` })
    .returning({ id: s.users.id });
  const [budget] = await db.insert(s.budgets).values({ userId: user!.id, name: "Lock order" }).returning({ id: s.budgets.id });
  const budgetId = budget!.id;

  const runScenario = async (kind: "envelope-delete" | "full-wipe"): Promise<ScenarioOutput> => {
    const [group] = await db
      .insert(s.envelopeGroups)
      .values({ budgetId, name: `Group ${kind}` })
      .returning({ id: s.envelopeGroups.id });
    const [envelope] = await db
      .insert(s.envelopes)
      .values({ budgetId, groupId: group!.id, name: `Envelope ${kind}` })
      .returning({ id: s.envelopes.id });
    const [account] = await db
      .insert(s.accounts)
      .values({ budgetId, name: `Account ${kind}`, automaticEnvelopeId: envelope!.id })
      .returning({ id: s.accounts.id });

    let releaseAccount!: () => void;
    const accountGate = new Promise<void>((resolve) => (releaseAccount = resolve));
    let signalAccountLocked!: () => void;
    const accountLocked = new Promise<void>((resolve) => (signalAccountLocked = resolve));

    const update = db
      .transaction(async (tx) => {
        await tx.execute(dsql`set local lock_timeout = '10s'`);
        await tx.select({ id: s.accounts.id }).from(s.accounts).where(eq(s.accounts.id, account!.id)).for("update");
        signalAccountLocked();
        await accountGate;
        await applyAccountUpdate(tx, budgetId, { id: account!.id, name: `Updated ${kind}` });
      })
      .then(
        () => ({ completed: true, error: null as string | null }),
        (error) => ({ completed: false, error: errorCode(error) }),
      );
    await withTimeout(accountLocked, 10_000, `${kind}: account row lock`);

    let signalCompetingPid!: (pid: number) => void;
    const competingPid = new Promise<number>((resolve) => (signalCompetingPid = resolve));
    const competing = db
      .transaction(async (tx) => {
        await tx.execute(dsql`set local lock_timeout = '10s'`);
        signalCompetingPid(await backendPid(tx));
        if (kind === "envelope-delete") await applyEnvelopeDelete(tx, budgetId, envelope!.id);
        else await wipeBudgetData(tx, budgetId);
      })
      .then(
        () => ({ completed: true, error: null as string | null }),
        (error) => ({ completed: false, error: errorCode(error) }),
      );

    const pid = await withTimeout(competingPid, 10_000, `${kind}: competing backend pid`);
    const waiterObserved = await waitFor(() => waitingOnLock(pid), { attempts: 400, intervalMs: 25 });
    releaseAccount();
    const [updateResult, competingResult] = await withTimeout(Promise.all([update, competing]), 20_000, `${kind}: both transactions finishing`);

    const [accountAfter] = await db.select({ automaticEnvelopeId: s.accounts.automaticEnvelopeId }).from(s.accounts).where(eq(s.accounts.id, account!.id));
    const [envelopeAfter] = await db.select({ id: s.envelopes.id }).from(s.envelopes).where(eq(s.envelopes.id, envelope!.id));
    const finalStateValid =
      kind === "envelope-delete" ? accountAfter?.automaticEnvelopeId === null && !envelopeAfter : accountAfter === undefined && envelopeAfter === undefined;

    return {
      waiterObserved,
      updateCompleted: updateResult.completed,
      competingCompleted: competingResult.completed,
      updateError: updateResult.error,
      competingError: competingResult.error,
      finalStateValid,
    };
  };

  const runMultiAccountWipeScenario = async (): Promise<ScenarioOutput> => {
    const [group] = await db.insert(s.envelopeGroups).values({ budgetId, name: "Group multi-account wipe" }).returning({ id: s.envelopeGroups.id });
    const [envelope] = await db
      .insert(s.envelopes)
      .values({ budgetId, groupId: group!.id, name: "Envelope multi-account wipe" })
      .returning({ id: s.envelopes.id });
    const [lowerAccountId, higherAccountId] = [crypto.randomUUID(), crypto.randomUUID()].sort();
    // Deliberately make heap/insertion order the inverse of the lifecycle protocol's UUID order.
    await db.insert(s.accounts).values({ id: higherAccountId!, budgetId, name: "Higher UUID first", automaticEnvelopeId: envelope!.id });
    await db.insert(s.accounts).values({ id: lowerAccountId!, budgetId, name: "Lower UUID second", automaticEnvelopeId: envelope!.id });

    let releaseLifecycle!: () => void;
    const lifecycleGate = new Promise<void>((resolve) => (releaseLifecycle = resolve));
    let signalLowerAccountLocked!: () => void;
    const lowerAccountLocked = new Promise<void>((resolve) => (signalLowerAccountLocked = resolve));

    const lifecycle = db
      .transaction(async (tx) => {
        await tx.execute(dsql`set local lock_timeout = '10s'`);
        await tx.select({ id: s.accounts.id }).from(s.accounts).where(eq(s.accounts.id, lowerAccountId!)).for("update");
        signalLowerAccountLocked();
        await lifecycleGate;
        await applyEnvelopeDelete(tx, budgetId, envelope!.id);
      })
      .then(
        () => ({ completed: true, error: null as string | null }),
        (error) => ({ completed: false, error: errorCode(error) }),
      );
    await withTimeout(lowerAccountLocked, 10_000, "multi-account wipe: lower account row lock");

    let signalWipePid!: (pid: number) => void;
    const wipePid = new Promise<number>((resolve) => (signalWipePid = resolve));
    const wipe = db
      .transaction(async (tx) => {
        await tx.execute(dsql`set local lock_timeout = '10s'`);
        signalWipePid(await backendPid(tx));
        await wipeBudgetData(tx, budgetId);
      })
      .then(
        () => ({ completed: true, error: null as string | null }),
        (error) => ({ completed: false, error: errorCode(error) }),
      );

    const pid = await withTimeout(wipePid, 10_000, "multi-account wipe: backend pid");
    const waiterObserved = await waitFor(() => waitingOnLock(pid), { attempts: 400, intervalMs: 25 });
    releaseLifecycle();
    const [lifecycleResult, wipeResult] = await withTimeout(Promise.all([lifecycle, wipe]), 20_000, "multi-account wipe: both transactions finishing");

    const accountsAfter = await db.select({ id: s.accounts.id }).from(s.accounts).where(eq(s.accounts.budgetId, budgetId));
    const [envelopeAfter] = await db.select({ id: s.envelopes.id }).from(s.envelopes).where(eq(s.envelopes.id, envelope!.id));
    return {
      waiterObserved,
      updateCompleted: lifecycleResult.completed,
      competingCompleted: wipeResult.completed,
      updateError: lifecycleResult.error,
      competingError: wipeResult.error,
      finalStateValid: accountsAfter.length === 0 && envelopeAfter === undefined,
    };
  };

  const out: AutomaticEnvelopeLockOrderOutput = {
    envelopeDelete: await runScenario("envelope-delete"),
    fullWipe: await runScenario("full-wipe"),
    multiAccountWipe: await runMultiAccountWipeScenario(),
  };

  await observer.end({ timeout: 5 });
  await sql.end({ timeout: 5 });
  await emitChildResult(SENTINEL, out);
  process.exit(0);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
