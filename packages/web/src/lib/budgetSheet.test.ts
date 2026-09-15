import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type BudgetSheetEvent, type BudgetSheetState, type BudgetSheetView, budgetSheetAfter, useBudgetSheets } from "./budgetSheet";

const run = (events: BudgetSheetEvent[], from: BudgetSheetState = null): BudgetSheetState => events.reduce(budgetSheetAfter, from);

const openSuggest: BudgetSheetEvent = { kind: "open", sheet: "suggest" };
const openFill: BudgetSheetEvent = { kind: "open", sheet: "fillGoals" };
const close: BudgetSheetEvent = { kind: "close" };
const leave: BudgetSheetEvent = { kind: "leave" };

describe("budgetSheetAfter — the owner's click sequences (round 8 item 32)", () => {
  test("A→B: Suggest, close, Fill by goals — the second pill opens its sheet", () => {
    expect(run([openSuggest, close, openFill])).toBe("fillGoals");
  });

  test("B→A: Fill by goals, close, Suggest — the second pill opens its sheet", () => {
    expect(run([openFill, close, openSuggest])).toBe("suggest");
  });

  test("A→A: the SAME pill twice reopens its sheet (the repeat that used to die on the mounted screen)", () => {
    expect(run([openSuggest, close, openSuggest])).toBe("suggest");
    expect(run([openFill, close, openFill])).toBe("fillGoals");
  });

  test("cancel-then-retry: closing without applying leaves nothing armed, and the retry still works", () => {
    expect(run([openSuggest, close])).toBe(null);
    expect(run([openFill, close])).toBe(null);
    expect(run([openSuggest, close, openFill, close, openSuggest, close, openFill])).toBe("fillGoals");
  });

  test("ten alternating presses keep working — no latch accumulates over repeats", () => {
    const events = Array.from({ length: 10 }, (_, i) => [i % 2 === 0 ? openSuggest : openFill, close]).flat();
    expect(run(events)).toBe(null);
    expect(run([...events, openSuggest])).toBe("suggest");
  });
});

describe("budgetSheetAfter — invariants that make the old failure modes unrepresentable", () => {
  test("pressing the other pill while a sheet is OPEN swaps sheets instead of stacking them", () => {
    expect(run([openSuggest, openFill])).toBe("fillGoals");
    expect(run([openFill, openSuggest])).toBe("suggest");
  });

  test("pressing the SAME pill while its sheet is open leaves it open (never a dead click, never a reopen)", () => {
    expect(run([openSuggest, openSuggest])).toBe("suggest");
  });

  test("an open sheet never depends on what was open before — every entry point is order-insensitive", () => {
    const froms: BudgetSheetState[] = [null, "suggest", "fillGoals"];
    for (const from of froms) {
      expect(budgetSheetAfter(from, openSuggest)).toBe("suggest");
      expect(budgetSheetAfter(from, openFill)).toBe("fillGoals");
    }
  });

  test("navigating away clears the sheet, so returning to Budget never resurrects one", () => {
    expect(run([openSuggest, leave])).toBe(null);
    expect(run([openFill, leave])).toBe(null);
    expect(run([openSuggest, leave, openFill])).toBe("fillGoals");
  });

  test("nav-then-open stays open — the deep links that navigate first still win their batch", () => {
    // `openBudgetFillGoals` is `nav("budget")` followed by the open, and the Start quick action
    // is the same shape. The open is the LAST write, so nav's clear must not survive it.
    expect(run([leave, openFill])).toBe("fillGoals");
    expect(run([openSuggest, leave, openFill])).toBe("fillGoals");
  });

  test("close and leave are both idempotent — a double dismiss cannot arm anything", () => {
    expect(run([openSuggest, close, close, leave, leave])).toBe(null);
  });
});

function renderThrough<P, R>(hook: (prop: P) => R, steps: readonly P[]): R[] {
  const seen: R[] = [];
  function Probe() {
    const [step, setStep] = useState(0);
    seen.push(hook(steps[step] as P));
    if (step < steps.length - 1) setStep(step + 1);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return seen;
}

const showing = (v: BudgetSheetView): string => (v.suggest ? "suggest" : v.fillGoals ? "fillGoals" : "none");

const bothOpen = (v: BudgetSheetView) => v.suggest && v.fillGoals;

describe("useBudgetSheets — the screen reads the open sheet on EVERY render (item 32)", () => {
  test("a sheet asked for while the screen is ALREADY MOUNTED opens — the owner's actual bug", () => {
    const seen = renderThrough(useBudgetSheets, [null, "suggest"]);

    expect(seen.map(showing)).toEqual(["none", "suggest"]);
  });

  test("A→B: pressing Fill by goals with the Suggest sheet up swaps sheets", () => {
    const seen = renderThrough(useBudgetSheets, ["suggest", "fillGoals"]);

    expect(seen.map(showing)).toEqual(["suggest", "fillGoals"]);
    expect(seen.some(bothOpen)).toBe(false);
  });

  test("B→A: and the reverse order, which is the same press the other way round", () => {
    const seen = renderThrough(useBudgetSheets, ["fillGoals", "suggest"]);

    expect(seen.map(showing)).toEqual(["fillGoals", "suggest"]);
    expect(seen.some(bothOpen)).toBe(false);
  });

  test("A→close→A: the same pill twice reopens its sheet", () => {
    const seen = renderThrough(useBudgetSheets, ["suggest", null, "suggest"]);

    expect(seen.map(showing)).toEqual(["suggest", "none", "suggest"]);
  });

  test("the SAME value delivered twice changes nothing and breaks nothing", () => {
    const seen = renderThrough(useBudgetSheets, ["suggest", "suggest", "suggest"]);

    expect(seen.map(showing)).toEqual(["suggest", "suggest", "suggest"]);
  });

  test("A→B→A→B alternating, with a close between each, keeps working", () => {
    const seen = renderThrough(useBudgetSheets, ["suggest", null, "fillGoals", null, "suggest", null, "fillGoals"]);

    expect(seen.map(showing)).toEqual(["suggest", "none", "fillGoals", "none", "suggest", "none", "fillGoals"]);
  });

  test("a sheet that has been shown stays MOUNTED after it closes, so its state survives a reopen", () => {
    // `…Opened` are the lazy-chunk latches: `show` follows the prop, mounting does not un-happen.
    const seen = renderThrough(useBudgetSheets, [null, "suggest", "fillGoals", null]);

    expect(seen.map((v) => v.suggestOpened)).toEqual([false, true, true, true]);
    expect(seen.map((v) => v.fillGoalsOpened)).toEqual([false, false, true, true]);
  });
});

/* ── The screen's end of the contract ─────────────────────────────────────────────────────────
 * `useBudgetSheets` can only protect the screen while the screen actually asks it. This guard is
 * the ablation the reviewer ran, made red: re-latching the prop into `BudgetScreen`'s own state
 * (`const [suggest] = useState(sheet === "suggest")`) restores the bug without touching anything
 * the behavioural test above can observe, because the defect would then live in a component no
 * headless renderer here can update. Source text is what is left to check — the same instrument
 * the repo already uses for rules a runtime test structurally cannot see (see
 * api/src/aiSpend/transport.noUnmeteredPath.test.ts and components/AmountField.test.ts). */

const BUDGET_SCREEN = join(import.meta.dir, "../screens/Budget.tsx");

/** Blank out comments (preserving offsets) — the prose in Budget.tsx discusses the very shape
 *  this scans for, and a docblock must never be able to fail or satisfy the rule. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'])\/\/[^\n]*/gm, (m, prefix: string) => prefix + " ".repeat(m.length - prefix.length));
}

describe("BudgetScreen never latches the open sheet into its own state (item 32)", () => {
  const code = stripComments(readFileSync(BUDGET_SCREEN, "utf8"));

  test("it reads the open sheet through the shared hook", () => {
    expect(code).toContain("useBudgetSheets(sheet)");
  });

  test("no local state is seeded from the `sheet` prop", () => {
    const seeded = [...code.matchAll(/use(?:State|Reducer)\([^)]*\bsheet\b[^)]*\)/g)].map((m) => m[0]);
    expect(seeded).toEqual([]);
  });

  test("`suggest`/`fillGoals` are not declared as local state", () => {
    const declared = [...code.matchAll(/const\s*\[\s*(?:suggest|fillGoals)\b[^\]]*\]/g)].map((m) => m[0]);
    expect(declared).toEqual([]);
  });

  test("the one-shot deep-link props are gone for good", () => {
    for (const dead of ["initialSuggest", "initialFillGoals", "onSuggestConsumed", "onFillGoalsConsumed"]) {
      expect(code).not.toContain(dead);
    }
  });

  test("the guard is honest: it is reading the real screen, with the real sheets in it", () => {
    // A renamed/moved file must fail loudly here rather than silently scan nothing.
    expect(code).toContain("BudgetSuggestSheet");
    expect(code).toContain("FillGoalsSheet");
    expect(code.length).toBeGreaterThan(10_000);
  });
});
