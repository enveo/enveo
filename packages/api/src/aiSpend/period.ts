/**
 * Pure UTC calendar-month arithmetic for the AI spend counter (backlog §1).
 *
 * A period is the half-open interval [monthStartUtc, nextMonthStartUtc) with the canonical
 * 'YYYY-MM' key. The TIMESTAMP these functions are applied to comes from POSTGRES (`now()` read
 * by the counter) — never the API host's local timezone, a browser clock or a request header.
 * Keeping the arithmetic pure (time injected) makes the 28/29/30/31-day and December→January
 * cases deterministic to test.
 */

export interface SpendPeriod {
  /** Canonical UTC period key, 'YYYY-MM'. */
  key: string;
  /** Inclusive period start (UTC ms). */
  startMs: number;
  /** Exclusive period end = next UTC month start (UTC ms). */
  endMs: number;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The period containing `utcMs`. `Date.UTC(y, 12, 1)` rolls into January — calendar arithmetic,
 *  no hand-written month-length table. */
export function periodAtUtc(utcMs: number): SpendPeriod {
  if (!Number.isFinite(utcMs)) throw new Error("periodAtUtc: not a finite timestamp");
  const d = new Date(utcMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return { key: `${y}-${pad2(m + 1)}`, startMs: Date.UTC(y, m, 1), endMs: Date.UTC(y, m + 1, 1) };
}

const KEY_RE = /^(\d{4})-(\d{2})$/;

/** Re-derive start/end from a canonical key — recordSpend charges the period the PREFLIGHT check
 *  evaluated, even when OpenAI answers after the next UTC month has begun. */
export function periodForKey(key: string): SpendPeriod {
  const m = KEY_RE.exec(key);
  if (!m) throw new Error(`invalid period key: ${key}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`invalid period key: ${key}`);
  return { key, startMs: Date.UTC(year, month - 1, 1), endMs: Date.UTC(year, month, 1) };
}

/**
 * `retryAfterSeconds` for a denial: the CEILING of the distance to the next UTC month boundary,
 * always a positive integer (the Retry-After header contract). Recomputed on every denial from
 * fresh Postgres time — never a persisted countdown.
 */
export function retryAfterSecondsUntil(endMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((endMs - nowMs) / 1000));
}
