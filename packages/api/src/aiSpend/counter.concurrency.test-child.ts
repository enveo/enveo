/**
 * Child process for the DB-backed spend-counter tests in counter.test.ts — NOT a test file
 * itself (bun's runner only picks up *.test.ts).
 *
 * WHY A SEPARATE PROCESS: `aiSpend/counter.ts` runs on the pooled client from `db/client.ts`,
 * whose Postgres pool is built from `env.DATABASE_URL` at IMPORT time; bun's test runner shares
 * one module registry per run, so the pool must be pinned to the throwaway database in a fresh
 * process (same pattern as operationLock.serialization.test-child.ts). The
 * EXPECT_DATABASE_URL fuse refuses anything but the throwaway Postgres the test handed over.
 *
 * Contract (all app imports are lazy so the parent can import SENTINEL/types without pulling
 * env/db/client into its own process):
 *   in  — EXPECT_DATABASE_URL (+ DATABASE_URL, both the same throwaway Postgres)
 *   out — one SENTINEL-prefixed JSON line on stdout: CounterChildOutput
 */
import { assertThrowawayDb, emitChildResult } from "../api.test-support";

export const SENTINEL = "__AI_SPEND_COUNTER_CHILD__";

export type CounterChildOutput = {
  migration: {
    /** drizzle migrator ran twice against the same database without error. */
    rerunIdempotent: boolean;
    /** All pre-existing data survived the rerun (a user row written between the two runs). */
    dataPreserved: boolean;
  };
  lazyRow: {
    /** First check created exactly one period row for (policy, user, current month). */
    oneRowAfterFirstCheck: boolean;
    /** A second check did not create another row. */
    stillOneRowAfterSecondCheck: boolean;
    /** The row pins the half-open UTC month interval (end = start of next month). */
    periodBoundsAreUtcMonth: boolean;
    firstCheckAllowed: boolean;
    recordedZero: boolean;
  };
  thresholds: {
    /** spent = threshold - 1 nanoUsd → allowed. */
    oneBelowAllows: boolean;
    /** spent = exactly $5 → denied. */
    exactThresholdDenies: boolean;
    aboveDenies: boolean;
    /** Denial carries a positive integer retryAfterSeconds bounded by the days left in the month. */
    retryAfterPositiveInt: boolean;
  };
  crossing: {
    /** A successful charge may cross $5 (4e9 + 2e9 = 6e9 retained). */
    overshootRetained: boolean;
    /** The FOLLOWING attempt is denied. */
    nextAttemptDenied: boolean;
  };
  concurrency: {
    /** Two checks below the threshold are BOTH allowed (no reservation can block the second). */
    bothChecksAllowed: boolean;
    /** Both concurrent atomic increments are retained even though the sum exceeds $5. */
    bothIncrementsRetained: boolean;
    /** Two different users record concurrently without contending on shared global state. */
    distinctUsersIndependent: boolean;
  };
  durability: {
    /** An INDEPENDENT connection (a "new API replica") observes the recorded total. */
    freshConnectionSeesTotal: boolean;
  };
  integrity: {
    /** A rolled-back foreign transaction cannot decrement the counter. */
    rollbackCannotDecrement: boolean;
    /** The CHECK constraint refuses a negative stored value. */
    negativeStoreRejected: boolean;
    /** The composite PK refuses a duplicate (policy, user, period) row. */
    duplicatePeriodRejected: boolean;
    /** recordSpend rejects a negative amount before any SQL. */
    negativeAmountRejected: boolean;
  };
  latePeriod: {
    /** A charge recorded with LAST month's checked periodKey lands in that period row. */
    chargedIntoCheckedPeriod: boolean;
    /** …and leaves the current month's counter untouched. */
    currentMonthUntouched: boolean;
  };
};

async function main() {
  const { env } = await import("../env");
  assertThrowawayDb(env.DATABASE_URL);
  const { db, sql: pooled } = await import("../db/client");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const postgres = (await import("postgres")).default;
  const s = await import("../db/schema");
  const { checkSpend, recordSpend, SPEND_POLICY, spendThresholdNanoUsd } = await import("./counter");
  const { periodAtUtc } = await import("./period");

  const migrationsFolder = new URL("../../drizzle", import.meta.url).pathname;
  await migrate(drizzle(pooled, { schema: s }), { migrationsFolder });
  // a row written BETWEEN the two runs must survive the rerun
  const [marker] = await db
    .insert(s.users)
    .values({ email: `spend-marker-${crypto.randomUUID()}@test.local` })
    .returning({ id: s.users.id });
  let rerunIdempotent = true;
  try {
    await migrate(drizzle(pooled, { schema: s }), { migrationsFolder });
  } catch {
    rerunIdempotent = false;
  }
  const markerRows = await pooled`select 1 from users where id = ${marker!.id}`;

  const POLICY = SPEND_POLICY.operatorAi;
  const THRESHOLD = spendThresholdNanoUsd(POLICY);
  const newUser = async (tag: string) => {
    const [u] = await db
      .insert(s.users)
      .values({ email: `spend-${tag}-${crypto.randomUUID()}@test.local` })
      .returning({ id: s.users.id });
    return u!.id;
  };
  const spentOf = async (userId: string, periodKey: string): Promise<bigint> => {
    const rows = await pooled<{ spent: string }[]>`
      select spent_nano_usd::text as spent from ai_user_monthly_spend
      where policy = ${POLICY} and user_id = ${userId} and period_key = ${periodKey}`;
    return BigInt(rows[0]?.spent ?? "-1"); // -1 = row absent
  };
  const setSpent = async (userId: string, periodKey: string, v: bigint) => {
    await pooled`update ai_user_monthly_spend set spent_nano_usd = ${v.toString()}::bigint
      where policy = ${POLICY} and user_id = ${userId} and period_key = ${periodKey}`;
  };

  /* ── lazy row creation ── */
  const userA = await newUser("a");
  const first = await checkSpend({ policy: POLICY, userId: userA });
  // epoch ms via SQL — drizzle overrides the shared client's parsers, so timestamps arrive as strings
  const rowsAfterFirst = await pooled<{ start_ms: string; end_ms: string; period_key: string }[]>`
    select (extract(epoch from period_start) * 1000)::bigint as start_ms,
           (extract(epoch from period_end) * 1000)::bigint as end_ms,
           period_key
    from ai_user_monthly_spend where user_id = ${userA}`;
  const second = await checkSpend({ policy: POLICY, userId: userA });
  const rowsAfterSecond = await pooled`select 1 from ai_user_monthly_spend where user_id = ${userA}`;
  const periodRow = rowsAfterFirst[0];
  const expected = periodRow ? periodAtUtc(Number(periodRow.start_ms)) : null;
  const periodBoundsAreUtcMonth =
    !!periodRow &&
    !!expected &&
    expected.key === periodRow.period_key &&
    Number(periodRow.start_ms) === expected.startMs &&
    Number(periodRow.end_ms) === expected.endMs;
  const currentKey = first.periodKey;

  /* ── thresholds ── */
  await setSpent(userA, currentKey, THRESHOLD - 1n);
  const oneBelow = await checkSpend({ policy: POLICY, userId: userA });
  await setSpent(userA, currentKey, THRESHOLD);
  const exact = await checkSpend({ policy: POLICY, userId: userA });
  await setSpent(userA, currentKey, THRESHOLD + 123n);
  const above = await checkSpend({ policy: POLICY, userId: userA });
  const retryAfterPositiveInt =
    !exact.allowed && Number.isSafeInteger(exact.retryAfterSeconds) && exact.retryAfterSeconds >= 1 && exact.retryAfterSeconds <= 32 * 24 * 3600;

  /* ── crossing the threshold with an actual charge ── */
  await setSpent(userA, currentKey, 4_000_000_000n);
  await recordSpend({ policy: POLICY, userId: userA, periodKey: currentKey, actualNanoUsd: 2_000_000_000n });
  const afterCross = await spentOf(userA, currentKey);
  const nextAttempt = await checkSpend({ policy: POLICY, userId: userA });

  /* ── forced concurrency: both below-threshold checks pass; both increments retained ── */
  const userB = await newUser("b");
  const kb = (await checkSpend({ policy: POLICY, userId: userB })).periodKey;
  await setSpent(userB, kb, 3_000_000_000n);
  const [c1, c2] = await Promise.all([checkSpend({ policy: POLICY, userId: userB }), checkSpend({ policy: POLICY, userId: userB })]);
  await Promise.all([
    recordSpend({ policy: POLICY, userId: userB, periodKey: kb, actualNanoUsd: 1_500_000_000n }),
    recordSpend({ policy: POLICY, userId: userB, periodKey: kb, actualNanoUsd: 1_500_000_000n }),
  ]);
  const bothIncrementsRetained = (await spentOf(userB, kb)) === 6_000_000_000n;

  const userC = await newUser("c");
  const userD = await newUser("d");
  const [ck, dk] = await Promise.all([checkSpend({ policy: POLICY, userId: userC }), checkSpend({ policy: POLICY, userId: userD })]);
  await Promise.all([
    recordSpend({ policy: POLICY, userId: userC, periodKey: ck.periodKey, actualNanoUsd: 7n }),
    recordSpend({ policy: POLICY, userId: userD, periodKey: dk.periodKey, actualNanoUsd: 11n }),
  ]);
  const distinctUsersIndependent = (await spentOf(userC, ck.periodKey)) === 7n && (await spentOf(userD, dk.periodKey)) === 11n;

  /* ── durability across "replicas": an independent connection sees the totals ── */
  const independent = postgres(env.DATABASE_URL, { max: 1, onnotice: () => {} });
  const freshRows = await independent<{ spent: string }[]>`
    select spent_nano_usd::text as spent from ai_user_monthly_spend
    where policy = ${POLICY} and user_id = ${userB} and period_key = ${kb}`;
  const freshConnectionSeesTotal = BigInt(freshRows[0]?.spent ?? "-1") === 6_000_000_000n;

  /* ── integrity: rollback, CHECK, PK, negative amount ── */
  let rollbackCannotDecrement = false;
  await independent
    .begin(async (tx) => {
      await tx`update ai_user_monthly_spend set spent_nano_usd = 1
        where policy = ${POLICY} and user_id = ${userB} and period_key = ${kb}`;
      throw new Error("force rollback");
    })
    .catch(() => {});
  rollbackCannotDecrement = (await spentOf(userB, kb)) === 6_000_000_000n;

  let negativeStoreRejected = false;
  try {
    await independent`update ai_user_monthly_spend set spent_nano_usd = -1
      where policy = ${POLICY} and user_id = ${userB} and period_key = ${kb}`;
  } catch {
    negativeStoreRejected = true;
  }

  let duplicatePeriodRejected = false;
  try {
    await independent`insert into ai_user_monthly_spend (policy, user_id, period_key, period_start, period_end)
      select policy, user_id, period_key, period_start, period_end from ai_user_monthly_spend
      where policy = ${POLICY} and user_id = ${userB} and period_key = ${kb}`;
  } catch {
    duplicatePeriodRejected = true;
  }
  await independent.end({ timeout: 5 });

  let negativeAmountRejected = false;
  try {
    await recordSpend({ policy: POLICY, userId: userB, periodKey: kb, actualNanoUsd: -1n });
  } catch {
    negativeAmountRejected = true;
  }

  /* ── an attempt checked before UTC midnight, recorded after: the charge follows the CHECKED key ── */
  const userE = await newUser("e");
  const nowKey = (await checkSpend({ policy: POLICY, userId: userE })).periodKey;
  const prev = new Date(Date.UTC(Number(nowKey.slice(0, 4)), Number(nowKey.slice(5, 7)) - 1, 1) - 1);
  const prevKey = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`;
  await recordSpend({ policy: POLICY, userId: userE, periodKey: prevKey, actualNanoUsd: 42n });
  const chargedIntoCheckedPeriod = (await spentOf(userE, prevKey)) === 42n;
  const currentMonthUntouched = (await spentOf(userE, nowKey)) === 0n;

  const out: CounterChildOutput = {
    migration: { rerunIdempotent, dataPreserved: markerRows.length === 1 },
    lazyRow: {
      oneRowAfterFirstCheck: rowsAfterFirst.length === 1,
      stillOneRowAfterSecondCheck: rowsAfterSecond.length === 1,
      periodBoundsAreUtcMonth,
      firstCheckAllowed: first.allowed,
      recordedZero: first.allowed && second.allowed && second.recordedNanoUsd === 0n,
    },
    thresholds: {
      oneBelowAllows: oneBelow.allowed,
      exactThresholdDenies: !exact.allowed,
      aboveDenies: !above.allowed,
      retryAfterPositiveInt,
    },
    crossing: {
      overshootRetained: afterCross === 6_000_000_000n,
      nextAttemptDenied: !nextAttempt.allowed,
    },
    concurrency: {
      bothChecksAllowed: c1.allowed && c2.allowed,
      bothIncrementsRetained,
      distinctUsersIndependent,
    },
    durability: { freshConnectionSeesTotal },
    integrity: { rollbackCannotDecrement, negativeStoreRejected, duplicatePeriodRejected, negativeAmountRejected },
    latePeriod: { chargedIntoCheckedPeriod, currentMonthUntouched },
  };
  await emitChildResult(SENTINEL, out);
  await pooled.end({ timeout: 5 });
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
