/**
 * Pure bits of the wide Home board's edit mode (pr5-task-6-brief.md Step 1) — span clamp,
 * draft-commit shapes the patch schema accepts, and add/remove toggles that never touch spans.
 * Pointer gestures themselves (the resize/reorder handlers that call these) are exercised in the
 * Step 5 browser pass, not here.
 */
import { describe, expect, test } from "bun:test";
import { budgetPreferencesPatchSchema, createDefaultWideWidgets, type WideWidgetConfig } from "@enveo/shared";
import { applyResize, clampRow, clampSpan, commitResetLayout, reorderEnabled, resolveWidgetScroll, toggleEnabled } from "./wideBoard";

describe("clampSpan", () => {
  test("a desktop-authored w:3 clamps to the fold's 2 columns at render", () => {
    expect(clampSpan(3, 2)).toBe(2);
  });
  test("a span already within the mode's columns is unchanged", () => {
    expect(clampSpan(1, 4)).toBe(1);
    expect(clampSpan(4, 4)).toBe(4);
  });
  test("floors at 1 regardless of a smaller/zero/negative input", () => {
    expect(clampSpan(0, 4)).toBe(1);
    expect(clampSpan(-2, 4)).toBe(1);
  });
});

describe("clampRow", () => {
  test("clamps to the 1..8 row range", () => {
    expect(clampRow(0)).toBe(1);
    expect(clampRow(9)).toBe(8);
    expect(clampRow(4)).toBe(4);
  });
});

describe("applyResize (draft-commit)", () => {
  test("rewrites only the target widget's span; every other entry is untouched", () => {
    const defaults = createDefaultWideWidgets();
    const next = applyResize(defaults, "reportCashflow", 2, 3);
    const cashflow = next.find((w) => w.id === "reportCashflow")!;
    expect(cashflow.w).toBe(2);
    expect(cashflow.h).toBe(3);
    // every other widget's config is reference-different (mapped) but value-identical
    for (const before of defaults) {
      if (before.id === "reportCashflow") continue;
      const after = next.find((w) => w.id === before.id);
      expect(after).toEqual(before);
    }
  });

  test("the committed list is exactly what a single `update({ wideWidgets })` op needs, and the shared patch schema accepts it", () => {
    const defaults = createDefaultWideWidgets();
    const next = applyResize(defaults, "envelopes", 4, 8);
    const parsed = budgetPreferencesPatchSchema.safeParse({ wideWidgets: next });
    expect(parsed.success).toBe(true);
  });

  test("defensively re-clamps an out-of-range row so a caller bug can never produce an invalid patch", () => {
    const defaults = createDefaultWideWidgets();
    const next = applyResize(defaults, "trends", 2, 99);
    expect(next.find((w) => w.id === "trends")!.h).toBe(8);
    expect(budgetPreferencesPatchSchema.safeParse({ wideWidgets: next }).success).toBe(true);
  });
});

describe("toggleEnabled (add/remove)", () => {
  test("flips only `enabled` — spans and opts are untouched (disabling never forgets sizing/config)", () => {
    const defaults = createDefaultWideWidgets();
    const before = defaults.find((w) => w.id === "envelopes")!;
    const next = toggleEnabled(defaults, "envelopes", false);
    const after = next.find((w) => w.id === "envelopes")!;
    expect(after.enabled).toBe(false);
    expect(after.w).toBe(before.w);
    expect(after.h).toBe(before.h);
    expect(after.opts).toEqual(before.opts);
  });

  test("re-adding a previously removed widget restores it with its prior span (round trip)", () => {
    const defaults = createDefaultWideWidgets();
    const removed = toggleEnabled(defaults, "goals", false);
    const restored = toggleEnabled(removed, "goals", true);
    expect(restored).toEqual(defaults);
  });

  test("produces a list the shared patch schema accepts", () => {
    const defaults = createDefaultWideWidgets();
    const next = toggleEnabled(defaults, "envelopesSavings", true);
    expect(budgetPreferencesPatchSchema.safeParse({ wideWidgets: next }).success).toBe(true);
  });
});

describe("reorderEnabled", () => {
  const ids = (widgets: WideWidgetConfig[]) => widgets.filter((w) => w.enabled).map((w) => w.id);

  test("moves an enabled tile to a new position among the other enabled tiles", () => {
    const defaults = createDefaultWideWidgets();
    const before = ids(defaults);
    const next = reorderEnabled(defaults, 0, 2);
    const after = ids(next);
    expect(after).not.toEqual(before);
    // the moved id (first enabled entry) now sits at index 2
    expect(after[2]).toBe(before[0]);
    expect(after).toHaveLength(before.length);
    expect(new Set(after)).toEqual(new Set(before));
  });

  test("the single disabled default (envelopesSavings) is preserved and never appears among the rendered order", () => {
    const defaults = createDefaultWideWidgets();
    const next = reorderEnabled(defaults, 1, 4);
    const disabled = next.filter((w) => !w.enabled);
    expect(disabled.map((w) => w.id)).toEqual(["envelopesSavings"]);
    expect(ids(next)).not.toContain("envelopesSavings");
  });

  test("a no-op move (from === to) and an out-of-range index both return the input unchanged", () => {
    const defaults = createDefaultWideWidgets();
    expect(reorderEnabled(defaults, 2, 2)).toBe(defaults);
    expect(reorderEnabled(defaults, -1, 2)).toBe(defaults);
    expect(reorderEnabled(defaults, 2, 999)).toBe(defaults);
  });

  test("produces a list the shared patch schema accepts", () => {
    const defaults = createDefaultWideWidgets();
    const next = reorderEnabled(defaults, 3, 0);
    expect(budgetPreferencesPatchSchema.safeParse({ wideWidgets: next }).success).toBe(true);
  });
});

describe("resolveWidgetScroll (the gear panel's 'Scroll inside the tile' toggle default)", () => {
  test("an absent `scroll` key resolves per the design's own default: net worth and cashflow clip, everything else scrolls", () => {
    expect(resolveWidgetScroll({ id: "reportNetWorth" })).toBe(false);
    expect(resolveWidgetScroll({ id: "reportCashflow" })).toBe(false);
    for (const id of ["envelopes", "envelopesSavings", "attention", "recent", "spending", "goals", "trends", "heatmap"] as const) {
      expect(resolveWidgetScroll({ id })).toBe(true);
    }
  });

  test("delete-the-key: a fixture with `scroll` deleted (not `undefined`-valued) resolves the same as never-had-one", () => {
    const widget: { id: "reportCashflow"; scroll?: boolean } = { id: "reportCashflow", scroll: true };
    delete widget.scroll;
    expect(resolveWidgetScroll(widget)).toBe(false);
  });

  test("an explicit value always wins over the id default, either direction", () => {
    expect(resolveWidgetScroll({ id: "reportNetWorth", scroll: true })).toBe(true);
    expect(resolveWidgetScroll({ id: "recent", scroll: false })).toBe(false);
  });
});

describe("commitResetLayout (the edit-mode 'Reset layout' escape hatch)", () => {
  test("commits exactly ONE patch, and its value is exactly the canonical default board", () => {
    const calls: { wideWidgets: WideWidgetConfig[] }[] = [];
    commitResetLayout((patch) => calls.push(patch));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.wideWidgets).toEqual(createDefaultWideWidgets());
  });

  test("nothing of the previous board survives: the committed value is defaults regardless of any stored shape", () => {
    // The whole point of the hatch: a board stored BEFORE a defaults change (old spans, old
    // order, extra disabled entries) never re-adopts the new row map via reconciliation, so the
    // committed patch must be a function of NOTHING — same result no matter what is on screen.
    const first: { wideWidgets: WideWidgetConfig[] }[] = [];
    const second: { wideWidgets: WideWidgetConfig[] }[] = [];
    commitResetLayout((patch) => first.push(patch));
    commitResetLayout((patch) => second.push(patch));
    expect(first[0]!.wideWidgets).toEqual(second[0]!.wideWidgets);
    // fresh arrays each call — a shared mutable singleton would let one board's later edits
    // corrupt what the next reset commits
    expect(first[0]!.wideWidgets).not.toBe(second[0]!.wideWidgets);
  });

  test("the committed patch is accepted by the shared preferences patch schema", () => {
    let committed: unknown;
    commitResetLayout((patch) => {
      committed = patch;
    });
    expect(budgetPreferencesPatchSchema.safeParse(committed).success).toBe(true);
  });
});
