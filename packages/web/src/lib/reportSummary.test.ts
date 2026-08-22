/**
 * Reports overview card summaries (reportSummary.ts).
 *
 * `budgetUsage` owns the denominator and threshold rules for both report surfaces.
 * Non-positive budgets deliberately have `pct: null`; overspending remains `left < 0`.
 */
import { describe, expect, test } from "bun:test";
import {
  type BudgetPace,
  type BudgetStep,
  type BudgetUsage,
  budgetPace,
  budgetRowPresentation,
  budgetSteps,
  budgetsOverAmount,
  budgetsSummary,
  budgetUsage,
  compareBudgetUsageRows,
  daysInMonth,
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

describe("daysInMonth", () => {
  test("gets February right in a leap year and a century non-leap year", () => {
    expect(daysInMonth("2024-02")).toBe(29); // ordinary leap year (divisible by 4)
    expect(daysInMonth("1900-02")).toBe(28); // divisible by 100 but not 400 → not a leap year
    expect(daysInMonth("2000-02")).toBe(29); // divisible by 400 → a leap year after all
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

describe("budgetSteps", () => {
  const stepRow = (id: string, over: Partial<{ archived: boolean; allocated: number; carryIn: number; spent: number }>) => ({
    id,
    name: id,
    archived: false,
    allocated: 0,
    carryIn: 0,
    spent: 0,
    ...over,
  });

  test("overspends come first, then risks, then near-limit", () => {
    const steps = budgetSteps(
      [
        stepRow("near", { allocated: 100_00, spent: 90_00 }), // near
        stepRow("risk", { allocated: 100_00, spent: 60_00 }), // projected 150.00 at 40%
        stepRow("over", { allocated: 100_00, spent: 120_00 }), // over by 20.00
      ],
      0.4,
    );
    expect(steps.map((s) => s.envelopeId)).toEqual(["over", "risk", "near"]);
    expect(steps.map((s) => s.kind)).toEqual(["over", "risk", "near"]);
  });

  test("the cover amount is exactly the overspend", () => {
    const steps = budgetSteps([stepRow("e", { allocated: 100_00, spent: 130_00 })], 0.5);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.amount).toBe(30_00);
  });

  test("the risk amount closes the projected gap", () => {
    // projected 150.00 against a 100.00 budget → 50.00
    const steps = budgetSteps([stepRow("e", { allocated: 100_00, spent: 60_00 })], 0.4);
    expect(steps[0]!.kind).toBe("risk");
    expect(steps[0]!.amount).toBe(50_00);
  });

  test("the near amount tops the envelope back up to a 20% cushion, post-application", () => {
    // budget 100.00, spent 90.00 → left 10.00. Naive round(100*0.2) - 10 = 10.00 falls short:
    // adding 10.00 grows the budget to 110.00, whose 20% cushion is 22.00 against a new left of
    // 20.00 — still short. The solved amount is 12.50: budget becomes 112.50, left becomes
    // 22.50, which is exactly 20% of 112.50.
    const steps = budgetSteps([stepRow("e", { allocated: 100_00, spent: 90_00 })], 0.5);
    expect(steps[0]!.kind).toBe("near");
    expect(steps[0]!.amount).toBe(12_50);
  });

  test("the near amount is strictly larger than the naive (pre-application) target", () => {
    // Same case as above: naive round(rawBudget * 0.2) - left = round(2000) - 1000 = 10.00,
    // but the actual step (12.50) must exceed it — the naive amount never reaches the cushion.
    const steps = budgetSteps([stepRow("e", { allocated: 100_00, spent: 90_00 })], 0.5);
    const naive = Math.round(100_00 * 0.2) - 10_00;
    expect(naive).toBe(10_00);
    expect(steps[0]!.amount).toBeGreaterThan(naive);
  });

  test("an envelope already at the cushion produces no near step", () => {
    // Within the "near" bucket (pct>=80, left>0), left = rawBudget - spent can never exceed
    // the cushion (NEAR_CUSHION * rawBudget): pct>=80 means spent>=0.8*rawBudget, so
    // left<=0.2*rawBudget always. The only way to be "at or above" the cushion while still
    // classified near is this exact boundary — budget 250.00, spent 200.00 (pct=80%) → left
    // 50.00, cushion 50.00.
    expect(budgetSteps([stepRow("e", { allocated: 250_00, spent: 200_00 })], 0.5)).toEqual([]);
  });

  test("near top-up is idempotent: applying the step once clears the checklist", () => {
    // This is the regression test for the bug itself: the old formula (round(B*0.2) - left)
    // only closed 80% of the gap each press, so re-deriving the step after "applying" it kept
    // producing a smaller, non-zero residual step forever. Simulate the UI's press (the amount
    // is added to `allocated`) and assert the envelope no longer produces a near step.
    const before = stepRow("e", { allocated: 100_00, spent: 90_00 });
    const steps = budgetSteps([before], 0.5);
    expect(steps).toHaveLength(1);
    const applied = { ...before, allocated: before.allocated + steps[0]!.amount };
    expect(budgetSteps([applied], 0.5)).toEqual([]);
  });

  test("within a kind the largest amount leads", () => {
    const steps = budgetSteps(
      [
        stepRow("small", { allocated: 100_00, spent: 110_00 }), // over by 10.00
        stepRow("big", { allocated: 100_00, spent: 150_00 }), // over by 50.00
      ],
      0.5,
    );
    expect(steps.map((s) => s.envelopeId)).toEqual(["big", "small"]);
  });

  test("calm, used-up and archived envelopes produce no step", () => {
    const steps = budgetSteps(
      [
        stepRow("calm", { allocated: 100_00, spent: 10_00 }),
        stepRow("usedUp", { allocated: 100_00, spent: 100_00 }),
        stepRow("archived", { archived: true, allocated: 100_00, spent: 200_00 }),
      ],
      0.5,
    );
    expect(steps).toEqual([]);
  });

  test("an envelope with neither budget nor spending is not a step", () => {
    expect(budgetSteps([stepRow("untouched", {})], 0.5)).toEqual([]);
  });

  test("keeps an ignored step, flagged rather than dropped", () => {
    const rows = [stepRow("over", { allocated: 100_00, spent: 120_00 }), stepRow("near", { allocated: 100_00, spent: 90_00 })];
    const steps: BudgetStep[] = budgetSteps(rows, 0.5, { ignored: new Set(["over"]) });
    // still both steps, in the usual order — ignored withholds nothing, it only flags
    expect(steps.map((s) => s.envelopeId)).toEqual(["over", "near"]);
    expect(steps.map((s) => s.ignored)).toEqual([true, false]);
  });

  test("caps fundable at the pool without changing amount", () => {
    // over by 30.00, but only 10.00 is ready to assign
    const steps = budgetSteps([stepRow("e", { allocated: 100_00, spent: 130_00 })], 0.5, { readyToAssign: 10_00 });
    expect(steps[0]!.amount).toBe(30_00);
    expect(steps[0]!.fundable).toBe(10_00);
  });

  test("treats an absent pool as unlimited", () => {
    const steps = budgetSteps([stepRow("e", { allocated: 100_00, spent: 130_00 })], 0.5);
    expect(steps[0]!.fundable).toBe(steps[0]!.amount);
  });

  test("fundable equals amount when the pool exactly covers it", () => {
    // over by 30.00, and exactly 30.00 is ready to assign — no shortfall
    const steps = budgetSteps([stepRow("e", { allocated: 100_00, spent: 130_00 })], 0.5, { readyToAssign: 30_00 });
    expect(steps[0]!.fundable).toBe(steps[0]!.amount);
  });

  test("fundable equals amount when the pool exceeds it", () => {
    // over by 30.00, but 100.00 is ready to assign — the cap never bites
    const steps = budgetSteps([stepRow("e", { allocated: 100_00, spent: 130_00 })], 0.5, { readyToAssign: 100_00 });
    expect(steps[0]!.fundable).toBe(steps[0]!.amount);
  });

  test("never returns a negative fundable when the pool is negative", () => {
    const steps = budgetSteps([stepRow("e", { allocated: 100_00, spent: 130_00 })], 0.5, { readyToAssign: -500 });
    expect(steps[0]!.fundable).toBe(0);
  });

  test("produces no step for a negative carry-in with no activity this month", () => {
    // allocated 0, carryIn -5000, spent 0 → the filter `allocated + carryIn > 0 || spent > 0`
    // excludes it. Assert both halves so this fails if the guard is ever deleted: an inactive
    // envelope with a negative carry-in stays silent, while the SAME envelope with spend this
    // month is not silent — it clears the guard and produces an "over" step.
    const inactive = stepRow("e", { allocated: 0, carryIn: -5000, spent: 0 });
    expect(budgetSteps([inactive], 0.5)).toEqual([]);

    const active = stepRow("e", { allocated: 0, carryIn: -5000, spent: 100 });
    const steps = budgetSteps([active], 0.5);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.kind).toBe("over");
  });

  test("a zero-amount top-up is dropped rather than shown as a no-op step", () => {
    // budget 100.00, spent 80.00 → pct exactly 80 → near; left 20.00 already equals the cushion
    const steps = budgetSteps([stepRow("e", { allocated: 100_00, spent: 80_00 })], 0.5);
    expect(steps).toEqual([]);
  });
});
