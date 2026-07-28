/**
 * Reports overview card summaries (reportSummary.ts).
 *
 * budgetsSummary: THRESHOLD cases (79.9 / 80 / 100 / 100.1 %) — parity
 * with the BudgetsReport thresholds.
 */
import { describe, expect, test } from "bun:test";
import { budgetsSummary } from "./reportSummary";

const envRow = (over: Partial<{ archived: boolean; allocated: number; carryIn: number; spent: number }> = {}) => ({
  archived: false,
  allocated: 0,
  carryIn: 0,
  spent: 0,
  ...over,
});

describe("budgetsSummary", () => {
  test("thresholds: 79.9% → ok, 80% → near, 100% → near, 100.1% → over", () => {
    const out = budgetsSummary([
      envRow({ allocated: 1000, spent: 799 }), // 79.9% → ok
      envRow({ allocated: 1000, spent: 800 }), // 80% → near
      envRow({ allocated: 1000, spent: 1000 }), // 100% → near (overspend only >100)
      envRow({ allocated: 1000, spent: 1001 }), // 100.1% → over
    ]);
    expect(out).toEqual({ over: 1, near: 2, ok: 1 });
  });

  test("budget = allocated + carryIn (carry-in counts)", () => {
    // 800/(500+500) = 80% → near; without carryIn it would be 160% → over
    expect(budgetsSummary([envRow({ allocated: 500, carryIn: 500, spent: 800 })])).toEqual({ over: 0, near: 1, ok: 0 });
  });

  test("filter as in BudgetsReport: no allocation and no spending → outside the counters; archived → outside", () => {
    const out = budgetsSummary([
      envRow(), // an empty envelope — skipped
      envRow({ allocated: 1000, spent: 2000, archived: true }), // archived — skipped
    ]);
    expect(out).toEqual({ over: 0, near: 0, ok: 0 });
  });

  test("spending without an allocation → the budget has a 1-minor-unit floor → over", () => {
    expect(budgetsSummary([envRow({ spent: 500 })])).toEqual({ over: 1, near: 0, ok: 0 });
  });

  test("negative spent counts as 0 → ok", () => {
    expect(budgetsSummary([envRow({ allocated: 1000, spent: -200 })])).toEqual({ over: 0, near: 0, ok: 1 });
  });
});
