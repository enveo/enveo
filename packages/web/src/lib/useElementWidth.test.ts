/**
 * Container measurement for charts (useElementWidth.ts).
 *
 * Only the pure fallback rule is unit-tested — jsdom has no layout, so ResizeObserver
 * behaviour is verified in the browser instead (see the plan's verification task).
 */
import { describe, expect, test } from "bun:test";
import { chartWidth } from "./useElementWidth";

describe("chartWidth", () => {
  test("an unmeasured container uses the fallback", () => {
    expect(chartWidth(null, 340)).toBe(340);
  });

  test("a measured container wins over the fallback", () => {
    expect(chartWidth(804, 340)).toBe(804);
    expect(chartWidth(390, 340)).toBe(390);
  });

  test("a zero or negative measurement falls back — a collapsed container must not divide by zero", () => {
    expect(chartWidth(0, 340)).toBe(340);
    expect(chartWidth(-10, 340)).toBe(340);
  });

  test("a non-finite measurement falls back", () => {
    expect(chartWidth(Number.NaN, 340)).toBe(340);
    expect(chartWidth(Number.POSITIVE_INFINITY, 340)).toBe(340);
  });

  test("a fractional measurement is rounded — a viewBox of 803.5 units helps nobody", () => {
    expect(chartWidth(803.5, 340)).toBe(804);
    expect(chartWidth(389.2, 340)).toBe(389);
  });

  test("a sub-pixel width falls back — rounding it would produce a zero-width viewBox", () => {
    expect(chartWidth(0.4, 340)).toBe(340);
    expect(chartWidth(0.5, 340)).toBe(1);
  });
});
