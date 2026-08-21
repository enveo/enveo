/**
 * Viewport-derived layout modes (viewMode.ts).
 *
 * The height clause is load-bearing: a landscape phone (844x390) clears the 900px
 * width test but cannot host a rail plus two panes, so it must stay "phone".
 */
import { describe, expect, test } from "bun:test";
import { DESKTOP_MIN, FOLD_MIN, MIN_WIDE_HEIGHT, PHONE_COL, viewModeFor } from "./viewMode";

describe("viewModeFor", () => {
  test("narrow viewports are phone", () => {
    expect(viewModeFor(390, 844)).toBe("phone");
    expect(viewModeFor(768, 1024)).toBe("phone");
    expect(viewModeFor(899, 1200)).toBe("phone");
  });

  test("fold band starts exactly at FOLD_MIN and ends below DESKTOP_MIN", () => {
    expect(viewModeFor(900, 1200)).toBe("fold");
    expect(viewModeFor(1104, 992)).toBe("fold"); // the design bundle's foldable
    expect(viewModeFor(1279, 1200)).toBe("fold");
  });

  test("desktop starts exactly at DESKTOP_MIN", () => {
    expect(viewModeFor(1280, 800)).toBe("desktop");
    expect(viewModeFor(1440, 900)).toBe("desktop"); // the design bundle's desktop
    expect(viewModeFor(2560, 1440)).toBe("desktop");
  });

  test("a short viewport is phone however wide it is", () => {
    expect(viewModeFor(844, 390)).toBe("phone"); // landscape phone
    expect(viewModeFor(1440, 499)).toBe("phone");
    expect(viewModeFor(2560, 300)).toBe("phone");
  });

  test("the height clause applies exactly at MIN_WIDE_HEIGHT", () => {
    expect(viewModeFor(1440, MIN_WIDE_HEIGHT - 1)).toBe("phone");
    expect(viewModeFor(1440, MIN_WIDE_HEIGHT)).toBe("desktop");
  });

  test("degenerate viewports never throw and never widen", () => {
    expect(viewModeFor(0, 0)).toBe("phone");
    expect(viewModeFor(-1, -1)).toBe("phone");
    expect(viewModeFor(Number.NaN, Number.NaN)).toBe("phone");
  });

  test("constants hold the documented values", () => {
    expect(PHONE_COL).toBe(420);
    expect(FOLD_MIN).toBe(900);
    expect(DESKTOP_MIN).toBe(1280);
    expect(MIN_WIDE_HEIGHT).toBe(500);
  });
});
