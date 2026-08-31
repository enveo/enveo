import { describe, expect, test } from "bun:test";
import { type BudgetSheetEvent, type BudgetSheetState, budgetSheetAfter } from "./budgetSheet";

/**
 * Owner round 8 item 32 — regression suite for "Zasugeruj / Wypełnij wg celów sometimes do
 * nothing, especially when one is clicked after the other".
 *
 * The bug was NOT in what a sheet does once open; it was in whether the entry point reached the
 * Budget screen at all. The two sheets used to be one-shot deep-link booleans consumed by
 * `BudgetScreen` at MOUNT, so any entry point pressed while Budget was already mounted flipped a
 * prop nothing read — and left the flag armed for the next mount. These sequences are the owner's
 * own, replayed against the transition function App now routes every change through, where the
 * open sheet is state rather than an intent waiting for a mount to deliver it.
 */

/** Fold a sequence of user actions the way App does — one `budgetSheetAfter` per event. */
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
    // The rail pills stay hit-testable while a sheet is open (measured live), and both sheets
    // write allocations — two open at once would put two live Assign buttons on the same
    // `readyToAssign`. The state is one value, so the swap is the only possible outcome.
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
    // Pre-lift this came free from unmounting the Budget screen; `nav()` now says it explicitly.
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
