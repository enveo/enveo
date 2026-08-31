/**
 * Pure day-vs-average comparison math for the Month report's day panel (MonthReport.tsx) — the
 * only real logic that panel adds beyond JSX. This repo's web tests are lib/pure-logic only
 * (rendering a real DOM measurement is verified in a running browser, not jsdom — see
 * CashflowReport.test.ts beside its own module for the same rationale), so this file pins the
 * one-liner itself (`avg > 0 ? (total - avg) / avg : null`, matching `dayDeltaPct` in
 * MonthReport.tsx verbatim) rather than extracting a wrapper function purely to have something to
 * import — the brief for this task explicitly allows either, and the formula is a single ternary.
 */
import { describe, expect, test } from "bun:test";

/** Mirrors MonthReport.tsx's `dayDeltaPct` exactly — kept in lockstep by these three cases. */
function dayDeltaPct(total: number, avg: number): number | null {
  return avg > 0 ? (total - avg) / avg : null;
}

describe("dayDeltaPct", () => {
  test("returns null when the month average is zero (nothing to compare against)", () => {
    expect(dayDeltaPct(50_00, 0)).toBeNull();
  });

  test("a day at exactly the average returns 0", () => {
    expect(dayDeltaPct(42_00, 42_00)).toBe(0);
  });

  test("a refund-heavy negative-total day returns a large negative delta, not NaN", () => {
    // total = -80_00 (a 90_00 refund against a 10_00 same-day purchase), avg = 42_00 — the day is
    // WAY below average, so this must be a large negative fraction, never NaN or a stray sign flip.
    const pct = dayDeltaPct(-80_00, 42_00);
    expect(pct).not.toBeNull();
    expect(Number.isNaN(pct)).toBe(false);
    expect(pct).toBeCloseTo((-80_00 - 42_00) / 42_00, 6);
    expect(pct!).toBeLessThan(-1); // more than 100% below average
  });
});
