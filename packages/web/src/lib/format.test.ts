import { describe, expect, test } from "bun:test";
import { fmtTrimLocale } from "./format";

describe("fmtTrimLocale — locale-aware bare number for read-only captions", () => {
  test("en-US: comma thousands, dot decimal, whole amounts drop the fraction", () => {
    expect(fmtTrimLocale(123456, "en")).toBe("1,234.56");
    expect(fmtTrimLocale(40000, "en")).toBe("400");
  });

  test("pl-PL: comma decimal; grouping separator uses the ACTUAL Intl char (NBSP/narrow-NBSP), not a hand-typed space", () => {
    // pl-PL groups only from 5 integer digits up (CLDR minimumGroupingDigits=2 — a genuine locale
    // rule, not a bun/ICU quirk: 1 234,56 (4 digits) prints WITHOUT a separator, verified below).
    const groupSep = new Intl.NumberFormat("pl-PL").formatToParts(12345).find((p) => p.type === "group")?.value ?? " ";
    expect(fmtTrimLocale(1234567, "pl")).toBe(`12${groupSep}345,67`);
    expect(fmtTrimLocale(123456, "pl")).toBe("1234,56");
    expect(fmtTrimLocale(40000, "pl")).toBe("400");
  });
});
