/**
 * Pure gridline-selection logic for `NetWorthChart` (reportKit.tsx) — the only real logic in
 * that component. `gridTicks` is tested in isolation with synthetic `format` functions so each
 * collision shape (all distinct / all collide / one-sided collisions / flat) is pinned exactly,
 * independent of `useCompactMask`'s real rounding behavior.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { gridTicks, TrendSpark } from "./reportKit";

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
 * `TrendSpark`'s median line (Task 1, Trends redesign) — unlike `NetWorthChart` below, this
 * component reads no hooks/context, so it can be rendered directly via `renderToStaticMarkup`
 * (same pattern already used elsewhere in this package, e.g. `accountListRowContent.test.ts`)
 * and its actual `<line y1>` asserted against, rather than duplicating the y-scaling arithmetic
 * in the test.
 */
describe("TrendSpark median line", () => {
  function medianLineY(series: number[], median: number): string {
    const html = renderToStaticMarkup(createElement(TrendSpark, { series, color: "#000", median }));
    const match = html.match(/<line[^>]*\sy1="([^"]+)"/);
    if (!match) throw new Error(`expected a <line> element in: ${html}`);
    return match[1]!;
  }

  test("a median equal to the series max sits at the top pad", () => {
    // h defaults to 24, pad is the component's internal inset of 2 — top of the drawable area.
    expect(medianLineY([0, 10], 10)).toBe("2");
  });

  test("a median equal to the series min sits at the bottom pad", () => {
    expect(medianLineY([0, 10], 0)).toBe("22");
  });

  test("a flat series (min === max) puts the median at h/2, matching the polyline's own flat case", () => {
    expect(medianLineY([5, 5, 5], 5)).toBe("12");
  });

  test("omitting median draws no line at all, matching both existing call sites' behavior", () => {
    const html = renderToStaticMarkup(createElement(TrendSpark, { series: [0, 10], color: "#000" }));
    expect(html).not.toContain("<line");
  });

  test("the last-point dot is opt-in and uses the polyline's own color", () => {
    const withDot = renderToStaticMarkup(createElement(TrendSpark, { series: [0, 10], color: "#123456", dot: true }));
    expect(withDot).toContain("<circle");
    expect(withDot).toContain("fill:#123456");

    const withoutDot = renderToStaticMarkup(createElement(TrendSpark, { series: [0, 10], color: "#123456" }));
    expect(withoutDot).not.toContain("<circle");
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
 * Matched against IMPORT clauses only, not against every mention of the identifier — the module
 * doc comment above names `compactMoney` in prose ("never `compactMoney` directly"), and a regex
 * over the whole file would trip on that. Prose never has the shape of an import statement, so
 * that false positive is excluded by construction rather than by luck.
 *
 * Three things this deliberately does NOT get wrong, each of which a first version did:
 * ALL imports from the module are scanned (`matchAll`, not `match`) — with a single-match regex a
 * second import statement placed after an innocent first one sails through. A NAMESPACE import
 * (`import * as fmt from "../lib/format"`, then `fmt.compactMoney(...)`) is rejected outright,
 * because it makes every export reachable without ever naming one. And `import type` is allowed
 * through: a type-only binding cannot be called at runtime, so it cannot leak an amount.
 */
describe("NetWorthChart stays under the discreet-mode mask", () => {
  const BYPASS_MSG =
    'Every amount NetWorthChart renders must go through useCompactMask() — that hook is what returns "••••" in ' +
    "discreet mode. Formatting an amount directly here bypasses the mask and shows a real figure to a viewer who " +
    "turned discreet mode on.";

  test('reportKit.tsx does not import compactMoney or formatMoney from "../lib/format"', () => {
    const src = readFileSync(join(import.meta.dir, "reportKit.tsx"), "utf8");
    const FORMAT_MODULE = /import\s+(type\s+)?(?:{([^}]*)}|\*\s+as\s+\w+)\s+from\s*["']\.\.\/lib\/format["']/g;
    const bypassing = new Set<string>();
    for (const m of src.matchAll(FORMAT_MODULE)) {
      if (m[1]) continue; // `import type` — erased at build time, unreachable at runtime
      if (m[2] === undefined) {
        throw new Error(`reportKit.tsx namespace-imports "../lib/format", which reaches every formatter in it. ${BYPASS_MSG}`);
      }
      for (const spec of m[2].split(",")) {
        const name = spec.trim().split(/\s+as\s+/)[0]!;
        if (name === "compactMoney" || name === "formatMoney") bypassing.add(name);
      }
    }
    if (bypassing.size > 0) {
      throw new Error(`reportKit.tsx imports ${[...bypassing].join(", ")} directly from "../lib/format". ${BYPASS_MSG}`);
    }
  });
});
