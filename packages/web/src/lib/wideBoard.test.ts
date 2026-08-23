/**
 * Pure bits of the wide Home board's edit mode (pr5-task-6-brief.md Step 1) — span clamp,
 * draft-commit shapes the patch schema accepts, and add/remove toggles that never touch spans.
 * Pointer gestures themselves (the resize/reorder handlers that call these) are exercised in the
 * Step 5 browser pass, not here.
 */
import { describe, expect, test } from "bun:test";
import { budgetPreferencesPatchSchema, createDefaultWideWidgets, type WideWidgetConfig } from "@enveo/shared";
import { applyResize, clampRow, clampSpan, reorderEnabled, toggleEnabled } from "./wideBoard";

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
