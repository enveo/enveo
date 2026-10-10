import { describe, expect, test } from "bun:test";
import { decodePath, encodePath, lastMonths, monthEnd, presetOf, presetRange, singleMonthOf } from "./spendingView";

describe("spending periods", () => {
  test("presets cover whole calendar months ending this month", () => {
    expect(presetRange("month", "2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(presetRange("12m", "2026-02")).toEqual({ from: "2025-03-01", to: "2026-02-28" });
    expect(presetRange("year", "2026-10")).toEqual({ from: "2026-01-01", to: "2026-10-31" });
    expect(monthEnd("2028-02")).toBe("2028-02-29");
  });

  test("a typed range is never shown as a preset or a single month", () => {
    const r = { ...presetRange("month", "2026-10"), custom: false };
    expect(presetOf(r, "2026-10")).toBe("month");
    expect(singleMonthOf(r)).toBe("2026-10");
    expect(presetOf({ ...r, custom: true }, "2026-10")).toBeNull();
    expect(singleMonthOf({ ...r, custom: true })).toBeNull();
    expect(singleMonthOf({ from: "2026-10-01", to: "2026-10-30", custom: false })).toBeNull();
  });

  test("month pills end at this month", () => {
    expect(lastMonths("2026-02", 3)).toEqual(["2025-12", "2026-01", "2026-02"]);
  });
});

describe("path encoding", () => {
  test("round-trips, including the empty bucket", () => {
    const path = [
      { dim: "group" as const, key: "g1" },
      { dim: "place" as const, key: null },
    ];
    expect(decodePath(encodePath(path))).toEqual(path);
  });
});
