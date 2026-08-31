/**
 * Pure gridline-selection logic for `NetWorthChart` (reportKit.tsx) — the only real logic in
 * that component. `gridTicks` is tested in isolation with synthetic `format` functions so each
 * collision shape (all distinct / all collide / one-sided collisions / flat) is pinned exactly,
 * independent of `useCompactMask`'s real rounding behavior.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DailySpendingPoint } from "@enveo/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type Lang, loadLocale, type Message, translatePlural } from "../lib/i18n";
import { gridTicks, heatWeeks, netWorthRangeLabel, TrendRow, TrendSpark } from "./reportKit";

/** Builds `count` consecutive `DailySpendingPoint`s starting at `${month}-01` — real calendar
 *  months, so `heatWeeks`'s offsets below are checkable by hand rather than fixture noise. */
function daysFor(month: string, count: number): DailySpendingPoint[] {
  return Array.from({ length: count }, (_, i) => ({ date: `${month}-${String(i + 1).padStart(2, "0")}`, total: i }));
}

describe("heatWeeks", () => {
  test("2026-06-01 is a Monday — the first week has zero leading nulls", () => {
    const weeks = heatWeeks(daysFor("2026-06", 30)); // June 2026 has 30 days
    expect(weeks.length).toBe(5);
    expect(weeks[0]!.every((c) => c !== null)).toBe(true);
    expect(weeks[0]![0]!.date).toBe("2026-06-01");
    // last week: days 29-30 (2 real cells) padded out with 5 trailing nulls
    expect(weeks[4]!.slice(0, 2).map((c) => c?.date)).toEqual(["2026-06-29", "2026-06-30"]);
    expect(weeks[4]!.slice(2)).toEqual([null, null, null, null, null]);
  });

  test("2026-02-01 is a Sunday — 6 leading nulls, and the last week ends with ONE trailing null (28 + 6 = 34, padded to 35)", () => {
    const weeks = heatWeeks(daysFor("2026-02", 28)); // 2026 is not a leap year: 28 days
    expect(weeks.length).toBe(5);
    expect(weeks[0]!.slice(0, 6)).toEqual([null, null, null, null, null, null]);
    expect(weeks[0]![6]!.date).toBe("2026-02-01");
    // last week: days 23-28 (6 real cells) + exactly 1 trailing null, not zero
    expect(weeks[4]!.slice(0, 6).map((c) => c?.date)).toEqual(["2026-02-23", "2026-02-24", "2026-02-25", "2026-02-26", "2026-02-27", "2026-02-28"]);
    expect(weeks[4]![6]).toBe(null);
  });

  test("a leap February (2024-02-01, 29 days) produces one more real cell than 2026's non-leap February, and a different trailing count", () => {
    const weeks = heatWeeks(daysFor("2024-02", 29));
    expect(weeks.length).toBe(5);
    expect(weeks[0]!.slice(0, 3)).toEqual([null, null, null]); // 2024-02-01 is a Thursday → mondayIndex 3 (3 leading nulls)
    expect(weeks[0]![3]!.date).toBe("2024-02-01");
    // last week: days 26-29 (4 real cells, one more real day than the 2026 case above) + 3 trailing nulls
    expect(weeks[4]!.slice(0, 4).map((c) => c?.date)).toEqual(["2024-02-26", "2024-02-27", "2024-02-28", "2024-02-29"]);
    expect(weeks[4]!.slice(4)).toEqual([null, null, null]);
  });

  test("every row is exactly 7 slots, in every case above including the first and last", () => {
    for (const weeks of [heatWeeks(daysFor("2026-06", 30)), heatWeeks(daysFor("2026-02", 28)), heatWeeks(daysFor("2024-02", 29))]) {
      for (const week of weeks) expect(week.length).toBe(7);
    }
  });

  test("empty input produces no rows", () => {
    expect(heatWeeks([])).toEqual([]);
  });
});

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
 * `netWorthRangeLabel` (design parity wave D task 2) — the "last {n} months · {start}–{end}"
 * caption shared by the reports hub hero and the Wealth report. `tp()` is exercised via the
 * real `translatePlural` (same pattern as `i18n.test.ts`: `await loadLocale("pl")` then call it
 * directly) so this pins the actual CLDR one/few/many/other boundary for pl, not a stub.
 */
describe("netWorthRangeLabel", () => {
  /** `n` consecutive months of net worth starting at `startMonth` — only `.month` matters. */
  function points(n: number, startMonth: string): { month: string; total: number }[] {
    const [y, m] = startMonth.split("-").map(Number) as [number, number];
    return Array.from({ length: n }, (_, i) => {
      const idx = m - 1 + i;
      return { month: `${y + Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`, total: 0 };
    });
  }
  function tpFor(lang: Lang) {
    return (message: Message, n: number, params?: Record<string, string | number>) => translatePlural(lang, message, n, params);
  }

  test("empty series returns null — nothing to range over", () => {
    expect(netWorthRangeLabel([], "en", tpFor("en"))).toBeNull();
  });

  test("a single point: english singular 'month', start and end are the same month", () => {
    expect(netWorthRangeLabel(points(1, "2025-08"), "en", tpFor("en"))).toBe("last 1 month · Aug 2025 – Aug 2025");
  });

  test("12 points spanning Aug 2025 – Jul 2026, the design's own worked example (v3:3195)", () => {
    expect(netWorthRangeLabel(points(12, "2025-08"), "en", tpFor("en"))).toBe("last 12 months · Aug 2025 – Jul 2026");
  });

  test("pl one/few/many/other boundary: n=1 -> one, n=2 -> few, n=5 -> many, n=12 -> many", async () => {
    await loadLocale("pl");
    const tp = tpFor("pl");
    expect(netWorthRangeLabel(points(1, "2025-08"), "pl", tp)).toBe("ostatni 1 miesiąc · Sie 2025 – Sie 2025");
    expect(netWorthRangeLabel(points(2, "2025-08"), "pl", tp)).toBe("ostatnie 2 miesiące · Sie 2025 – Wrz 2025");
    expect(netWorthRangeLabel(points(5, "2025-08"), "pl", tp)).toBe("ostatnie 5 miesięcy · Sie 2025 – Gru 2025");
    expect(netWorthRangeLabel(points(12, "2025-08"), "pl", tp)).toBe("ostatnie 12 miesięcy · Sie 2025 – Lip 2026");
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

/**
 * Owner round 7 item 29 put the Trends REPORT's row grammar on the wide home board's trends tile.
 * The point of the requirement was that the two must READ IDENTICALLY — his side-by-side showed a
 * tile that had drifted into its own grammar — so the fix was to give both hosts ONE component,
 * `TrendRow`. Nothing about the types stops a future edit from re-inlining a lookalike row in
 * either place (that is exactly how the drift happened the first time: the tile grew its own
 * `<TrendSpark>` + name + amount block beside the report's), and no rendering test would fail —
 * both would still render "a trends row", just different ones.
 *
 * So this scans both hosts' own source for the shared row: each must IMPORT `TrendRow` and RENDER
 * it, and neither may reach for the row's own ingredients (`TrendSpark`/`DeltaTag`) inside a
 * hand-built trends row again. `widgetsBoard.tsx` legitimately still uses `TrendSpark` for the
 * PHONE trends body (a different, deliberately compact grammar owner round 7 did not touch) and
 * `ReportsHub`'s mini uses it too, so the check is not "never mentions TrendSpark" — it is
 * "renders <TrendRow>", the one fact that makes the two grammars the same object.
 */
describe("the Trends report and the wide trends tile render ONE shared row", () => {
  const HOSTS = [
    { file: "../screens/reports/TrendsReport.tsx", what: "the Trends report subscreen" },
    { file: "./widgetsBoard.tsx", what: "the wide home board's trends tile" },
  ];

  for (const { file, what } of HOSTS) {
    test(`${what} renders reportKit's <TrendRow>`, () => {
      const src = readFileSync(join(import.meta.dir, file), "utf8");
      const imports = src.match(/import\s*{([^}]*)}\s*from\s*["'][^"']*reportKit["']/);
      const named = (imports?.[1] ?? "").split(",").map((s) => s.trim().split(/\s+as\s+/)[0]);
      expect(named).toContain("TrendRow");
      // `[\s/>]` matters: a bare `toContain("<TrendRow")` also passes for `<TrendRowSomethingElse`,
      // so an ablation that renames the element sails straight through it (it did, once).
      expect(src).toMatch(/<TrendRow[\s/>]/);
    });
  }
});

/**
 * `TrendRow`'s two opposite overflow rules, pinned because they look like an inconsistency and a
 * future tidy-up would "fix" them into one: the NAME ellipsizes (unbounded label, identity already
 * carried by the colour dot), the SUB-LINE wraps (two amounts — truncating it eats the median digit
 * by digit, which is exactly what the wide 2×2 trends tile did in Polish before owner round 7).
 * Also pins that BOTH sub-line figures go through the caller's mask: formatting either one directly
 * would print a real amount to someone who turned discreet mode on, and the row's own types would
 * not notice.
 *
 * Rendered with `renderToStaticMarkup` and no providers on purpose — `useTheme`/`useSettings` both
 * have real defaults (light theme, English), so the row is renderable in isolation, and asserting
 * the emitted `style` attribute is stronger than asserting the source text of a style object.
 */
describe("TrendRow overflow rules", () => {
  const TR = { id: "e1", name: "Groceries", color: "#abcdef", series: [10, 20, 30], last: 120, baseline: 100, deltaPct: 0.2 };
  const html = renderToStaticMarkup(createElement(TrendRow, { tr: TR, M: (n: number) => `«${n}»`, onClick: () => {} }));

  test("the envelope name ellipsizes on one line", () => {
    expect(html).toMatch(/text-overflow:ellipsis;white-space:nowrap">Groceries<\/span>/);
  });

  test("the sub-line wraps instead — no nowrap anywhere else in the row", () => {
    expect(html.match(/white-space:nowrap/g)).toHaveLength(1);
    expect(html).toMatch(/text-wrap:balance">«120» · median «100»<\/span>/);
  });

  test("every amount in the row goes through the caller's mask", () => {
    // sub-line: this month + median; right column: the signed delta (120 − 100).
    expect(html).toContain("«120» · median «100»");
    expect(html).toContain("+«20»");
    expect(html).not.toContain("120.00");
  });
});
