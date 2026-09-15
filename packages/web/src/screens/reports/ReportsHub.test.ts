import { describe, expect, test } from "bun:test";
import { netWorthDeltaPct } from "./ReportsHub";

function points(...totals: number[]): { month: string; total: number }[] {
  return totals.map((total, i) => ({ month: `2026-${String(i + 1).padStart(2, "0")}`, total }));
}

describe("netWorthDeltaPct", () => {
  test("an empty series has nothing to compare — null", () => {
    expect(netWorthDeltaPct([])).toBeNull();
  });

  test("a single point has no prior month to compare against — null", () => {
    expect(netWorthDeltaPct(points(1000))).toBeNull();
  });

  test("a positive delta is signed with a leading '+', one decimal (the design's own worked example: 1000 -> 1097 is +9.7%)", () => {
    expect(netWorthDeltaPct(points(1000, 1097))).toBe("+9.7%");
  });

  test("a negative delta keeps toFixed's own '-' sign, with no extra '+' prefix", () => {
    expect(netWorthDeltaPct(points(1000, 900))).toBe("-10.0%");
  });

  test("no change m/m is still signed '+0.0%' (0 >= 0 takes the positive branch)", () => {
    expect(netWorthDeltaPct(points(1000, 1000))).toBe("+0.0%");
  });

  test("a zero prior value is guarded to 1, matching the design's own '|| 1' fallback, instead of dividing by zero", () => {
    expect(netWorthDeltaPct(points(0, 50))).toBe("+5000.0%");
  });

  test("only the last two points of a longer series are compared", () => {
    expect(netWorthDeltaPct(points(100, 100, 100, 1000, 1097))).toBe("+9.7%");
  });
});
