/**
 * Pure label-thinning arithmetic for `CashflowColumns` (CashflowReport.tsx) — the only real logic
 * in that component, extracted so it is unit-tested rather than eyeballed. This file sits next to
 * the module it tests, mirroring `reportKit.test.ts` beside `reportKit.tsx`: this repo's web tests
 * are lib/pure-logic only (rendering a real DOM measurement is verified in a running browser, not
 * jsdom — see the task's browser-pass table in the doc comment above `labelStep` in the module).
 *
 * Cases below reproduce the measured table from the 3c browser pass: 390px → 25.3px columns fit
 * a 22.1px "Sept." with room to spare (step 1); 360px → 22.8px columns leave only 0.7px of slack,
 * which the `+2`px minimum gap correctly treats as too tight (step 2); 320px → 19.4px columns
 * would overlap outright at step 1, so every-other-column is required (step 2).
 */
import { describe, expect, test } from "bun:test";
import { labelStep } from "./CashflowReport";

describe("labelStep", () => {
  test("390px columns (25.3px) comfortably fit the widest label (22.1px) — show every label", () => {
    expect(labelStep(22.1, 25.3)).toBe(1);
  });

  test("360px columns (22.8px) leave only 0.7px of slack — too tight, thin to every other label", () => {
    expect(labelStep(22.1, 22.8)).toBe(2);
  });

  test("320px columns (19.4px) are narrower than the label itself — thin to every other label", () => {
    expect(labelStep(22.1, 19.4)).toBe(2);
  });

  test("an unmeasured or collapsed column width falls back to showing every label, not a divide-by-zero", () => {
    expect(labelStep(22.1, 0)).toBe(1);
    expect(labelStep(0, 0)).toBe(1);
    expect(labelStep(22.1, Number.NaN)).toBe(1);
    expect(labelStep(22.1, -5)).toBe(1);
  });

  test("a not-yet-measured (zero or non-finite) widest label falls back to showing every label", () => {
    expect(labelStep(0, 25.3)).toBe(1);
    expect(labelStep(Number.NaN, 25.3)).toBe(1);
    expect(labelStep(-1, 25.3)).toBe(1);
  });

  test("a column far wider than any label always returns 1 — never thins when there is no need to", () => {
    expect(labelStep(5, 100)).toBe(1);
  });
});
