/**
 * Reports overview card summaries (reportSummary.ts).
 *
 * `budgetUsage` owns the denominator and threshold rules for both report surfaces.
 * Non-positive budgets deliberately have `pct: null`; overspending remains `left < 0`.
 */
import { describe, expect, test } from "bun:test";
import {
  type BudgetPace,
  type BudgetUsage,
  budgetPace,
  budgetRowPresentation,
  budgetsOverAmount,
  budgetsSummary,
  budgetUsage,
  compareBudgetUsageRows,
  monthProgress,
} from "./reportSummary";

const envRow = (over: Partial<{ archived: boolean; allocated: number; carryIn: number; spent: number }> = {}) => ({
  archived: false,
  allocated: 0,
  carryIn: 0,
  spent: 0,
  ...over,
});

const calculateUsage = (row: ReturnType<typeof envRow>): BudgetUsage => budgetUsage(row);

describe("budgetUsage", () => {
  test("a zero budget with spending has no percentage and remains overspent", () => {
    // given: an envelope with no allocation or carry-in
    const envelope = envRow({ spent: 500 });

    // when: report usage is calculated
    const usage = calculateUsage(envelope);

    // then: the report keeps the real zero denominator instead of inventing one minor unit
    expect(usage).toEqual({ rawBudget: 0, spent: 500, left: -500, pct: null, status: "over" });
  });

  test("a negative effective budget never produces a percentage", () => {
    const usage = calculateUsage(envRow({ carryIn: -200, spent: 100 }));

    expect(usage).toEqual({ rawBudget: -200, spent: 100, left: -300, pct: null, status: "over" });
  });

  test.each([
    { spent: 799, pct: 79.9, left: 201, status: "ok" as const },
    { spent: 800, pct: 80, left: 200, status: "near" as const },
    { spent: 1000, pct: 100, left: 0, status: "ok" as const },
    { spent: 1001, pct: 100.1, left: -1, status: "over" as const },
  ])("classifies a positive budget at $pct% as $status", ({ spent, pct, left, status }) => {
    expect(calculateUsage(envRow({ allocated: 1000, spent }))).toEqual({ rawBudget: 1000, spent, left, pct, status });
  });
});

describe("budget report row presentation", () => {
  test("a zero-budget overspend uses an em dash percentage and a full warning bar without changing business data", () => {
    const usage = calculateUsage(envRow({ spent: 500 }))!;
    const presentation = budgetRowPresentation(usage);

    expect(presentation).toEqual({ percentage: null, visualBarPct: 100, noBudget: true, overspend: 500 });
  });

  test("a positive budget keeps its real percentage for display and bar width", () => {
    const usage = calculateUsage(envRow({ allocated: 1000, spent: 800 }))!;
    const presentation = budgetRowPresentation(usage);

    expect(presentation).toEqual({ percentage: 80, visualBarPct: 80, noBudget: false, overspend: 0 });
  });
});

describe("budget report row ordering", () => {
  type Row = BudgetUsage & { name: string };
  const compare = (a: Row, b: Row): number => compareBudgetUsageRows(a, b, (left, right) => left.localeCompare(right, "en"));

  test("orders rows with real budgets by descending percentage", () => {
    const low = { ...calculateUsage(envRow({ allocated: 1000, spent: 800 }))!, name: "Low" };
    const high = { ...calculateUsage(envRow({ allocated: 1000, spent: 1200 }))!, name: "High" };

    expect([low, high].sort(compare).map((row) => row.name)).toEqual(["High", "Low"]);
  });

  test("orders undefined-percentage overspends by descending overspend amount", () => {
    const small = { ...calculateUsage(envRow({ spent: 300 }))!, name: "Small" };
    const large = { ...calculateUsage(envRow({ spent: 500 }))!, name: "Large" };

    expect([small, large].sort(compare).map((row) => row.name)).toEqual(["Large", "Small"]);
  });

  test("uses the injected name comparer as a stable final tie-breaker", () => {
    const beta = { ...calculateUsage(envRow({ spent: 500 }))!, name: "Beta" };
    const alpha = { ...calculateUsage(envRow({ spent: 500 }))!, name: "Alpha" };

    expect([beta, alpha].sort(compare).map((row) => row.name)).toEqual(["Alpha", "Beta"]);
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

  test("spending without an allocation remains over without inventing a budget", () => {
    expect(budgetsSummary([envRow({ spent: 500 })])).toEqual({ over: 1, near: 0, ok: 0 });
  });

  test("the zero-budget boundary remains over even though percentage is undefined", () => {
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

  test("the zero-budget boundary: no allocation and spent=1 contributes the real overspend", () => {
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

describe("monthProgress", () => {
  test("a past month is complete, a future month has not started", () => {
    expect(monthProgress("2026-06", "2026-07-14")).toBe(1);
    expect(monthProgress("2026-08", "2026-07-14")).toBe(0);
  });

  test("the current month is the elapsed fraction, day-inclusive", () => {
    expect(monthProgress("2026-07", "2026-07-14")).toBeCloseTo(14 / 31, 6);
    expect(monthProgress("2026-07", "2026-07-01")).toBeCloseTo(1 / 31, 6);
    expect(monthProgress("2026-07", "2026-07-31")).toBe(1);
  });

  test("short and leap months use their own length", () => {
    expect(monthProgress("2026-02", "2026-02-14")).toBeCloseTo(14 / 28, 6);
    expect(monthProgress("2024-02", "2024-02-14")).toBeCloseTo(14 / 29, 6);
  });
});

describe("budgetPace", () => {
  const row = (over: Partial<{ archived: boolean; allocated: number; carryIn: number; spent: number }> = {}) => ({
    archived: false,
    allocated: 0,
    carryIn: 0,
    spent: 0,
    ...over,
  });

  test("overspent stays over even when the pace looks calm", () => {
    const p: BudgetPace = budgetPace(row({ allocated: 100_00, spent: 130_00 }), 0.5);
    expect(p.bucket).toBe("over");
  });

  test("a zero budget with spending is over, never usedUp — the floored-denominator trap", () => {
    expect(budgetPace(row({ allocated: 0, spent: 1 }), 0.5).bucket).toBe("over");
  });

  test("near the limit is preserved from budgetUsage", () => {
    // 90% spent, money still left → near
    expect(budgetPace(row({ allocated: 100_00, spent: 90_00 }), 0.5).bucket).toBe("near");
  });

  test("spent exactly to the limit is usedUp, not near and not over", () => {
    expect(budgetPace(row({ allocated: 100_00, spent: 100_00 }), 0.5).bucket).toBe("usedUp");
  });

  test("a calm envelope whose pace overshoots the budget is risk", () => {
    // 60.00 of a 100.00 budget spent with 40% of the month gone → projected 150.00
    const p = budgetPace(row({ allocated: 100_00, spent: 60_00 }), 0.4);
    expect(p.projected).toBe(150_00);
    expect(p.bucket).toBe("risk");
  });

  test("a calm envelope whose pace lands inside the budget is ok", () => {
    const p = budgetPace(row({ allocated: 100_00, spent: 30_00 }), 0.5);
    expect(p.projected).toBe(60_00);
    expect(p.bucket).toBe("ok");
  });

  test("risk cannot fire once the month is over — projection equals reality", () => {
    const p = budgetPace(row({ allocated: 100_00, spent: 60_00 }), 1);
    expect(p.projected).toBe(60_00);
    expect(p.bucket).toBe("ok");
  });

  test("no spending never projects a risk, and progress 0 does not divide by zero", () => {
    const p = budgetPace(row({ allocated: 100_00, spent: 0 }), 0);
    expect(p.projected).toBe(0);
    expect(p.bucket).toBe("ok");
  });

  test("an envelope with no budget at all and no spending is ok", () => {
    expect(budgetPace(row({}), 0.5).bucket).toBe("ok");
  });

  test("carryIn counts toward the budget", () => {
    // 40.00 carried in + 60.00 allocated = 100.00 budget; 30.00 spent at half the month
    expect(budgetPace(row({ allocated: 60_00, carryIn: 40_00, spent: 30_00 }), 0.5).bucket).toBe("ok");
  });
});
