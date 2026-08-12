import { describe, expect, test } from "bun:test";
import { ICONS, ICON_CATEGORIES } from "./icons";
import { EXT_PALETTE } from "./theme";

describe("biblioteka ikon (picker)", () => {
  test("every category icon has a drawn glyph", () => {
    for (const cat of ICON_CATEGORIES)
      for (const ic of cat.icons) {
        expect(ICONS[ic], `brak glifu: ${ic}`).toBeDefined();
      }
  });
  test("no duplicates across categories", () => {
    const all = ICON_CATEGORIES.flatMap((c) => c.icons);
    expect(new Set(all).size).toBe(all.length);
  });
  test("EXT_PALETTE: valid #rrggbb, no duplicates", () => {
    for (const c of EXT_PALETTE) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(EXT_PALETTE).size).toBe(EXT_PALETTE.length);
  });
});

import { normHex } from "../components/IconColorPicker";
describe("normHex — a custom color", () => {
  test("akceptuje warianty i normalizuje", () => {
    expect(normHex("#4FA583")).toBe("#4fa583");
    expect(normHex("4fa583")).toBe("#4fa583");
    expect(normHex("#fa5")).toBe("#ffaa55");
    expect(normHex(" #1d2a47 ")).toBe("#1d2a47");
  });
  test("rejects garbage", () => {
    for (const bad of ["", "#12", "zzz", "#12345", "#1234567", "rgb(1,2,3)"]) expect(normHex(bad)).toBe(null);
  });
});
