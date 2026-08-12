/**
 * The durable check-then-record spend counter (backlog §1).
 *
 *  - pure part: the policy registry (the $5 cloud-v1 constant) and the admission rule;
 *  - DB-backed part: lazy period rows, threshold denial, accepted overshoot, forced
 *    concurrency, durability across connections, CHECK/PK integrity and migration-0020
 *    idempotency — run in a CHILD process (counter.concurrency.test-child.ts) because the
 *    counter deliberately runs on the pooled client pinned to `env.DATABASE_URL` at import.
 *
 * OPT-IN like every DB suite: set TEST_DATABASE_URL to a THROWAWAY Postgres (see
 * operationLock.test.ts for the local recipe). No fallback to DATABASE_URL, ever.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { runChild } from "../api.test-support";
import { type checkSpend, recordSpend, SPEND_POLICY, spendAllowed, spendThresholdNanoUsd } from "./counter";
// Constant + type only — the child's app imports are lazy (see its header).
import { type CounterChildOutput, SENTINEL } from "./counter.concurrency.test-child";

describe("spend policy registry (pure)", () => {
  it("operator-ai is the registered policy with exactly 5_000_000_000 nanoUsd (~$5) per UTC month", () => {
    expect(SPEND_POLICY.operatorAi).toBe("operator-ai");
    expect(spendThresholdNanoUsd(SPEND_POLICY.operatorAi)).toBe(5_000_000_000n);
  });
});

describe("spendAllowed — the admission rule (deny only when RECORDED spend reached the threshold)", () => {
  const T = 5_000_000_000n;
  it("zero spend allows", () => {
    expect(spendAllowed(0n, T)).toBe(true);
  });
  it("exactly one nano-USD below the threshold allows", () => {
    expect(spendAllowed(4_999_999_999n, T)).toBe(true);
  });
  it("exactly the threshold denies", () => {
    expect(spendAllowed(5_000_000_000n, T)).toBe(false);
  });
  it("above the threshold (an accepted overshoot) denies the NEXT attempt", () => {
    expect(spendAllowed(6_800_000_000n, T)).toBe(false);
  });
});

describe("recordSpend/checkSpend input validation (throws before any SQL)", () => {
  it("rejects a negative amount", async () => {
    await expect(recordSpend({ policy: SPEND_POLICY.operatorAi, userId: "u", periodKey: "2026-08", actualNanoUsd: -1n })).rejects.toThrow();
  });
  it("rejects a malformed period key", async () => {
    await expect(recordSpend({ policy: SPEND_POLICY.operatorAi, userId: "u", periodKey: "2026-13", actualNanoUsd: 1n })).rejects.toThrow();
  });
  it("rejects a non-bigint amount smuggled past the types", async () => {
    await expect(recordSpend({ policy: SPEND_POLICY.operatorAi, userId: "u", periodKey: "2026-08", actualNanoUsd: 5 as unknown as bigint })).rejects.toThrow();
  });
});

describe("no reservation machinery exists (the design the spec rejects)", () => {
  it("checkSpend's result carries no reserved/lease/maximum state and no per-request handle", () => {
    // Shape contract: an allowed check is {allowed, periodKey, recordedNanoUsd} and nothing else.
    // (Executed against the DB in the child; here we pin the TYPE surface.)
    type Allowed = Extract<Awaited<ReturnType<typeof checkSpend>>, { allowed: true }>;
    const keys: Record<keyof Allowed, true> = { allowed: true, periodKey: true, recordedNanoUsd: true };
    expect(Object.keys(keys).sort()).toEqual(["allowed", "periodKey", "recordedNanoUsd"]);
  });
});

/* ── DB-backed semantics (child process, throwaway Postgres) ─────────────── */

const TEST_URL = process.env.TEST_DATABASE_URL ?? "";
if (TEST_URL && TEST_URL === process.env.DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL — this suite writes to the DB.");
}

const CHILD = new URL("./counter.concurrency.test-child.ts", import.meta.url).pathname;
const CHILD_TIMEOUT_MS = 120_000;

describe.skipIf(!TEST_URL)("spend counter semantics (DB-backed, child process)", () => {
  let out: CounterChildOutput;

  beforeAll(async () => {
    out = await runChild<CounterChildOutput>({
      path: CHILD,
      testUrl: TEST_URL,
      sentinel: SENTINEL,
      cwd: new URL("../..", import.meta.url).pathname,
    });
  }, CHILD_TIMEOUT_MS);

  it("migration 0020 applies from the previous schema, reruns idempotently and preserves data", () => {
    expect(out.migration).toEqual({ rerunIdempotent: true, dataPreserved: true });
  });

  it("creates exactly one period row lazily, pinned to the half-open UTC month", () => {
    expect(out.lazyRow).toEqual({
      oneRowAfterFirstCheck: true,
      stillOneRowAfterSecondCheck: true,
      periodBoundsAreUtcMonth: true,
      firstCheckAllowed: true,
      recordedZero: true,
    });
  });

  it("denies at exactly $5 and above; one nano-USD below still allows; Retry-After is a positive integer", () => {
    expect(out.thresholds).toEqual({ oneBelowAllows: true, exactThresholdDenies: true, aboveDenies: true, retryAfterPositiveInt: true });
  });

  it("a successful charge may cross $5 (retained), and only the FOLLOWING attempt is denied", () => {
    expect(out.crossing).toEqual({ overshootRetained: true, nextAttemptDenied: true });
  });

  it("forced concurrency: both below-threshold checks pass and both atomic increments are retained; users are independent", () => {
    expect(out.concurrency).toEqual({ bothChecksAllowed: true, bothIncrementsRetained: true, distinctUsersIndependent: true });
  });

  it("an independent connection (a new API replica) observes the recorded totals", () => {
    expect(out.durability).toEqual({ freshConnectionSeesTotal: true });
  });

  it("rollback cannot decrement; CHECK refuses negatives; the composite PK refuses duplicate periods", () => {
    expect(out.integrity).toEqual({
      rollbackCannotDecrement: true,
      negativeStoreRejected: true,
      duplicatePeriodRejected: true,
      negativeAmountRejected: true,
    });
  });

  it("a charge recorded after the UTC month rolled lands in the CHECKED period, not the new one", () => {
    expect(out.latePeriod).toEqual({ chargedIntoCheckedPeriod: true, currentMonthUntouched: true });
  });
});
