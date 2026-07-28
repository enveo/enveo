import { describe, expect, test } from "bun:test";
import { monthRuler, spendMeter, sumAvailable, sumBalances, tbbState } from "./uiState";

describe("spendMeter", () => {
  test("normal spend: fill = spent/(spent+available), state ok", () => {
    const m = spendMeter({ spent: 200_00, available: 800_00 })!;
    expect(m.fill).toBeCloseTo(0.2);
    expect(m.state).toBe("ok");
    expect(m.total).toBe(1000_00);
  });
  test("warn at >= 80% of the month's pot", () => {
    expect(spendMeter({ spent: 800_00, available: 200_00 })!.state).toBe("warn");
    expect(spendMeter({ spent: 799_99, available: 200_01 })!.state).toBe("ok");
  });
  test("overspent: full red bar, total = spent", () => {
    const m = spendMeter({ spent: 240_57, available: -40_57 })!;
    expect(m).toEqual({ fill: 1, state: "over", total: 240_57 });
  });
  test("nothing spent and nothing available -> no meter (savings-style rows)", () => {
    expect(spendMeter({ spent: 0, available: 0 })).toBeNull();
  });
  test("no spend but money available -> empty ok meter (line shows an empty track)", () => {
    const m = spendMeter({ spent: 0, available: 500_00 })!;
    expect(m).toEqual({ fill: 0, state: "ok", total: 500_00 });
  });
  test("refund-heavy month (negative spent) clamps to empty", () => {
    expect(spendMeter({ spent: -50_00, available: 500_00 })!.fill).toBe(0);
  });
});

describe("monthRuler", () => {
  test("mid-month", () => {
    expect(monthRuler("2026-07-19")).toEqual({ day: 19, days: 31, pct: 61 });
  });
  test("first and last day", () => {
    expect(monthRuler("2026-02-01").pct).toBe(4); // 1/28
    expect(monthRuler("2026-02-28").pct).toBe(100);
  });
});

describe("tbbState", () => {
  test("classifies", () => {
    expect(tbbState(0)).toBe("zero");
    expect(tbbState(1)).toBe("positive");
    expect(tbbState(-1)).toBe("negative");
  });
});

describe("sums", () => {
  const envs = [
    { available: 100, archived: false, isSavings: false },
    { available: -40, archived: false, isSavings: false },
    { available: 999, archived: true, isSavings: false },
    { available: 5000, archived: false, isSavings: true },
  ];
  test("sumAvailable splits by isSavings and skips archived", () => {
    expect(sumAvailable(envs, false)).toBe(60);
    expect(sumAvailable(envs, true)).toBe(5000);
  });
  test("sumBalances skips archived accounts", () => {
    expect(sumBalances([{ balance: 10, archived: false }, { balance: 99, archived: true }])).toBe(10);
  });
});
