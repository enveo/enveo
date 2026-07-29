/**
 * Reports overview card summaries (reportSummary.ts).
 *
 * budgetsSummary: THRESHOLD cases (79.9 / 80 / 100 / 100.1 %) — parity with the
 * BudgetsReport thresholds, via the shared `classifyBudget` rule: over = left < 0
 * (equivalent to spent > budget on the RAW, unfloored budget); near = !over && pct >= 80
 * && left > 0; else ok (the "amber-wall" fix — pct === 100 with left === 0, i.e. spent
 * EXACTLY down to the budget with no room left to overrun, reads as calm).
 *
 * `over` is defined on `left`, NOT on `pct`, because callers compute `pct` against a
 * FLOORED budget (`Math.max(1, allocated+carryIn)`) to avoid divide-by-zero, while `left`
 * stays on the RAW (unfloored) budget — so a zero/negative raw budget with any positive
 * spend can land pct AT exactly 100 (not > 100) while `left` is already negative. Using
 * `pct > 100` for `over` would misclassify that as "ok"/"used up" — a real overspend
 * reading as calm, the amber-wall failure inverted.
 */
import { describe, expect, test } from "bun:test";
import { budgetsOverAmount, budgetsSummary, classifyBudget } from "./reportSummary";

const envRow = (over: Partial<{ archived: boolean; allocated: number; carryIn: number; spent: number }> = {}) => ({
  archived: false,
  allocated: 0,
  carryIn: 0,
  spent: 0,
  ...over,
});

describe("classifyBudget", () => {
  test("over: left < 0, regardless of pct", () => {
    expect(classifyBudget(100.1, -1)).toBe("over");
    expect(classifyBudget(101, -5)).toBe("over");
  });

  test("the zero/negative-budget boundary: floored-budget pct lands at exactly 100 (not > 100) while left is already negative → still over, not ok", () => {
    // e.g. allocated=0, carryIn=0, spent=1 → floored budget=1 → pct=100, left=-1
    expect(classifyBudget(100, -1)).toBe("over");
  });

  test("near requires BOTH pct >= 80 AND left > 0", () => {
    expect(classifyBudget(80, 1)).toBe("near");
    expect(classifyBudget(99, 1)).toBe("near");
    expect(classifyBudget(100, 1)).toBe("near"); // pct===100 but still room left (left>0) → near, not used-up
  });

  test("the amber-wall fix: pct === 100 with left === 0 (used up, no room to overrun) is calm, not near", () => {
    expect(classifyBudget(100, 0)).toBe("ok");
  });

  test("ok below 80%", () => {
    expect(classifyBudget(79.9, 500)).toBe("ok");
  });
});

describe("budgetsSummary", () => {
  test("thresholds: 79.9% → ok, 80% → near, 100% → ok (used up), 100.1% → over", () => {
    const out = budgetsSummary([
      envRow({ allocated: 1000, spent: 799 }), // 79.9%, left=201 → ok
      envRow({ allocated: 1000, spent: 800 }), // 80%, left=200>0 → near
      envRow({ allocated: 1000, spent: 1000 }), // 100%, left=0 → ok (the amber-wall fix)
      envRow({ allocated: 1000, spent: 1001 }), // 100.1% → over
    ]);
    expect(out).toEqual({ over: 1, near: 1, ok: 2 });
  });

  test("budget = allocated + carryIn (carry-in counts)", () => {
    // 800/(500+500) = 80%, left=200>0 → near; without carryIn it would be 160% → over
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

  test("the zero-budget boundary: spent === the 1-minor-unit floor exactly → pct lands at 100 (not > 100) but left=-1 → still over", () => {
    expect(budgetsSummary([envRow({ spent: 1 })])).toEqual({ over: 1, near: 0, ok: 0 });
  });

  test("negative spent counts as 0 → ok", () => {
    expect(budgetsSummary([envRow({ allocated: 1000, spent: -200 })])).toEqual({ over: 0, near: 0, ok: 1 });
  });
});

/* budgetsOverAmount: the € total behind the hub Budgets mini-card's "over budget" line — MUST
 * agree with budgetsSummary's `over` count (same classifyBudget call), not an inline `pct > 100`
 * check, which silently drops the zero-budget boundary case from the € total even though the
 * pill above still counts it as "over" (the regression this test pins). */
describe("budgetsOverAmount", () => {
  test("sums -left over ordinary overspent envelopes", () => {
    expect(budgetsOverAmount([envRow({ allocated: 1000, spent: 1300 })])).toBe(300); // left=-300
  });

  test("the zero-budget boundary: no allocation, spent=1 → floored-budget pct is exactly 100 (not > 100), left=-1 → still counted", () => {
    // an inline `pct > 100` filter would miss this row entirely (pct===100) and return 0,
    // even though budgetsSummary already counts it as `over`.
    expect(budgetsOverAmount([envRow({ spent: 1 })])).toBe(1);
  });

  test("used up exactly (pct=100, left=0) → ok, not over → 0", () => {
    expect(budgetsOverAmount([envRow({ allocated: 1000, spent: 1000 })])).toBe(0);
  });

  test("near (pct>=80, left>0) contributes nothing", () => {
    expect(budgetsOverAmount([envRow({ allocated: 1000, spent: 800 })])).toBe(0);
  });

  test("archived and inactive (no allocation, no spend) envelopes are excluded", () => {
    expect(budgetsOverAmount([envRow({ allocated: 1000, spent: 2000, archived: true }), envRow()])).toBe(0);
  });

  test("sums across multiple overspent envelopes", () => {
    expect(
      budgetsOverAmount([
        envRow({ allocated: 1000, spent: 1300 }), // left=-300
        envRow({ allocated: 500, spent: 800 }), // left=-300
        envRow({ allocated: 1000, spent: 500 }), // ok, not counted
      ]),
    ).toBe(600);
  });
});
