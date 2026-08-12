/**
 * The generic durable check-then-record spend counter (backlog §1) — REPLACES the rejected
 * reservation design. There is deliberately NO `reserved`/`inFlight`/lease state, no predicted
 * request cost, no delayed settlement, no reconciliation job and no cleanup queue:
 *
 *  - `checkSpend` reads/creates the user's UTC-month row and denies ONLY when already-recorded
 *    spend is >= the policy threshold. It never reserves anything, and it never holds a
 *    transaction or lock while the caller waits on OpenAI (each statement is autocommit on the
 *    pooled client). This is explicitly NOT the operation lock — spend accounting is one atomic
 *    upsert/increment, not a serialized critical section.
 *  - `recordSpend` adds ACTUAL usage-derived cost with one atomic upsert-increment into the
 *    period the preflight check evaluated (even when OpenAI answers after the UTC month rolled).
 *    The increment may push the counter past the threshold — accepted; only the NEXT attempt is
 *    denied. Two concurrent attempts may both pass below the threshold and both be added later —
 *    also accepted, do not serialize users.
 *
 * The POLICY REGISTRY owns thresholds and period semantics; routes cannot invent limits. Time is
 * authoritative from POSTGRES (`now()`), never the API host clock. Failures here are the
 * caller's to treat as FAIL OPEN for this feature only (aiSpend/transport.ts) — session, tenant
 * and every unrelated database guarantee stay fail closed.
 */
import { sql as pg } from "../db/client";
import { periodAtUtc, periodForKey, retryAfterSecondsUntil } from "./period";

export const SPEND_POLICY = {
  operatorAi: "operator-ai",
} as const;

export type SpendPolicyName = (typeof SPEND_POLICY)[keyof typeof SPEND_POLICY];

/** Cloud v1 product constant: approximately USD 5.00 per user per UTC calendar month.
 *  Deliberately NOT an environment variable (decision: no operator use case yet). */
const POLICIES: Record<SpendPolicyName, { thresholdNanoUsd: bigint }> = {
  "operator-ai": { thresholdNanoUsd: 5_000_000_000n },
};

export function spendThresholdNanoUsd(policy: SpendPolicyName): bigint {
  return POLICIES[policy].thresholdNanoUsd;
}

/** The pure admission rule: deny only when RECORDED spend already reached the threshold. */
export function spendAllowed(recordedNanoUsd: bigint, thresholdNanoUsd: bigint): boolean {
  return recordedNanoUsd < thresholdNanoUsd;
}

export type SpendCheck = { allowed: true; periodKey: string; recordedNanoUsd: bigint } | { allowed: false; periodKey: string; retryAfterSeconds: number };

/**
 * Read/create the user's current UTC-month counter and decide admission. The period row is
 * created lazily on the first check (or first recorded charge) of the month; `retryAfterSeconds`
 * is recomputed from fresh Postgres time on every denial — never persisted.
 */
export async function checkSpend(i: { policy: SpendPolicyName; userId: string }): Promise<SpendCheck> {
  const threshold = spendThresholdNanoUsd(i.policy);
  // Epoch ms straight from SQL: drizzle (db/client) overrides the shared postgres.js client's
  // type parsers, so a raw `now()` would come back as a STRING here — never rely on Date parsing.
  const [nowRow] = await pg<{ ms: string }[]>`select (floor(extract(epoch from now()) * 1000))::bigint as ms`;
  const nowMs = Number(nowRow!.ms);
  const period = periodAtUtc(nowMs);
  const rows = await pg<{ spent: string }[]>`
    insert into ai_user_monthly_spend (policy, user_id, period_key, period_start, period_end)
    values (${i.policy}, ${i.userId}, ${period.key}, ${new Date(period.startMs).toISOString()}::timestamptz, ${new Date(period.endMs).toISOString()}::timestamptz)
    on conflict (policy, user_id, period_key)
    do update set updated_at = ai_user_monthly_spend.updated_at
    returning spent_nano_usd::text as spent`;
  const recorded = BigInt(rows[0]?.spent ?? "0");
  if (!spendAllowed(recorded, threshold)) {
    return { allowed: false, periodKey: period.key, retryAfterSeconds: retryAfterSecondsUntil(period.endMs, nowMs) };
  }
  return { allowed: true, periodKey: period.key, recordedNanoUsd: recorded };
}

/**
 * One atomic upsert-increment of actual cost into the CHECKED period. Checked bigint arithmetic:
 * a negative amount is a programmer error and is rejected before any SQL; the database CHECK
 * keeps the stored value non-negative independently.
 */
export async function recordSpend(i: { policy: SpendPolicyName; userId: string; periodKey: string; actualNanoUsd: bigint }): Promise<void> {
  if (typeof i.actualNanoUsd !== "bigint" || i.actualNanoUsd < 0n) {
    throw new Error("recordSpend: actualNanoUsd must be a non-negative bigint");
  }
  const period = periodForKey(i.periodKey); // validates the key and re-derives start/end
  await pg`
    insert into ai_user_monthly_spend (policy, user_id, period_key, period_start, period_end, spent_nano_usd)
    values (${i.policy}, ${i.userId}, ${period.key}, ${new Date(period.startMs).toISOString()}::timestamptz, ${new Date(period.endMs).toISOString()}::timestamptz, ${i.actualNanoUsd.toString()}::bigint)
    on conflict (policy, user_id, period_key)
    do update set spent_nano_usd = ai_user_monthly_spend.spent_nano_usd + excluded.spent_nano_usd,
                  updated_at = now()`;
}
