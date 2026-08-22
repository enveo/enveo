/**
 * Pure gridline-selection logic for `NetWorthChart` (reportKit.tsx) — the only real logic in
 * that component. `gridTicks` is tested in isolation with synthetic `format` functions so each
 * collision shape (all distinct / all collide / one-sided collisions / flat) is pinned exactly,
 * independent of `useCompactMask`'s real rounding behavior.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gridTicks } from "./reportKit";

describe("gridTicks", () => {
  test("three distinct labels draw three ticks, sorted top to bottom", () => {
    const ticks = gridTicks(0, 300, (v) => `$${v}`);
    expect(ticks).toEqual([
      { value: 300, label: "$300" },
      { value: 150, label: "$150" },
      { value: 0, label: "$0" },
    ]);
  });

  test("all three colliding draws exactly one tick — the mid one", () => {
    // A formatter that collapses every value to the same string (e.g. discreet mode's "••••",
    // or a modest-variance series whose max/mid/min all round to the same compact label).
    const ticks = gridTicks(0, 100, () => "••••");
    expect(ticks).toEqual([{ value: 50, label: "••••" }]);
  });

  test("min and mid colliding, max distinct: extremes win, mid is dropped — MIN survives", () => {
    const ticks = gridTicks(0, 100, (v) => (v <= 60 ? "LOW" : "HIGH")); // mid=50→LOW, min=0→LOW, max=100→HIGH
    expect(ticks).toEqual([
      { value: 100, label: "HIGH" },
      { value: 0, label: "LOW" },
    ]);
  });

  test("max and mid colliding, min distinct: extremes win, mid is dropped", () => {
    const ticks = gridTicks(0, 100, (v) => (v >= 40 ? "HIGH" : "LOW")); // mid=50→HIGH, max=100→HIGH, min=0→LOW
    expect(ticks).toEqual([
      { value: 100, label: "HIGH" },
      { value: 0, label: "LOW" },
    ]);
  });

  test("a flat series (min === max) draws a single tick at the shared value", () => {
    const ticks = gridTicks(100, 100, (v) => `$${v}`);
    expect(ticks).toEqual([{ value: 100, label: "$100" }]);
  });
});

/**
 * Every amount `NetWorthChart` renders goes through `useCompactMask()` (from `../lib/contexts`),
 * which returns `"••••"` for every value in discreet mode. Nothing about the component's own
 * types stops a future edit from importing `compactMoney`/`formatMoney` straight from
 * `../lib/format` instead and calling the real formatter directly — that would render a live
 * amount even with discreet mode on, and no other test would catch it. This scans reportKit.tsx's
 * own source for exactly that import.
 *
 * Matched against the IMPORT clause only (`import { … } from "../lib/format"`), not against every
 * mention of the identifier — the module doc comment above names `compactMoney` in prose
 * ("never `compactMoney` directly"), and a regex over the whole file would trip on that. Capturing
 * only the braced specifier list of a `from "../lib/format"` import and checking the NAMES in it
 * makes that a non-issue by construction: prose never has the shape `import { compactMoney } from
 * "../lib/format"`, so there is nothing for the check to accidentally match there.
 */
describe("NetWorthChart stays under the discreet-mode mask", () => {
  test('reportKit.tsx does not import compactMoney or formatMoney from "../lib/format"', () => {
    const src = readFileSync(join(import.meta.dir, "reportKit.tsx"), "utf8");
    const importedFromFormat = src.match(/import\s*{([^}]*)}\s*from\s*["']\.\.\/lib\/format["']/);
    const names = importedFromFormat ? importedFromFormat[1]!.split(",").map((n) => n.trim().split(/\s+as\s+/)[0]!) : [];
    const bypassing = names.filter((n) => n === "compactMoney" || n === "formatMoney");
    if (bypassing.length > 0) {
      throw new Error(
        `reportKit.tsx imports ${bypassing.join(", ")} directly from "../lib/format". Every amount NetWorthChart ` +
          'renders must go through useCompactMask() instead — that hook is what returns "••••" in discreet mode. ' +
          "Calling compactMoney/formatMoney directly here bypasses the mask and leaks a real amount to a viewer " +
          "who turned discreet mode on.",
      );
    }
  });
});
