/**
 * Panel-width clamp (geometry.ts). The exact table from pr4-context.md §0b item 9 and
 * pr4-task-4-brief.md §4b, plus the two invariants that table is meant to hold everywhere:
 * the panel never drops below 320px, and the primary column never drops below `PRIMARY_MIN`
 * (390px) at any width ≥900 (the narrowest wide layout, `FOLD_MIN`).
 */
import { describe, expect, test } from "bun:test";
import { RAIL_W } from "../../lib/viewMode";
import { PRIMARY_MIN, paneWidthFor } from "./geometry";

describe("paneWidthFor", () => {
  test("desktop at 1440 and 1280 both clamp to the fixed PANE_W (plenty of room)", () => {
    expect(paneWidthFor("desktop", 1440)).toBe(400);
    expect(paneWidthFor("desktop", 1280)).toBe(400);
  });

  test("fold shrinks the pane below its fixed PANE_W once the viewport gets tight", () => {
    expect(paneWidthFor("fold", 1104)).toBe(552);
    expect(paneWidthFor("fold", 960)).toBe(502);
    expect(paneWidthFor("fold", 900)).toBe(442);
  });

  test("never below the 320px floor, however narrow", () => {
    expect(paneWidthFor("fold", 900)).toBeGreaterThanOrEqual(320);
    expect(paneWidthFor("fold", 0)).toBe(320);
    expect(paneWidthFor("desktop", 0)).toBe(320);
  });

  test("the primary column never drops below PRIMARY_MIN at any wide width ≥900", () => {
    for (const w of [900, 960, 1000, 1104, 1200, 1279, 1280, 1440, 1920, 2560]) {
      const mode = w < 1280 ? "fold" : "desktop";
      const primary = w - RAIL_W[mode] - paneWidthFor(mode, w);
      expect(primary).toBeGreaterThanOrEqual(PRIMARY_MIN);
    }
  });

  test("reproduces the mock's own numbers exactly at the two canonical sizes", () => {
    expect(1440 - RAIL_W.desktop - paneWidthFor("desktop", 1440)).toBe(804);
    expect(1104 - RAIL_W.fold - paneWidthFor("fold", 1104)).toBe(484);
  });
});
