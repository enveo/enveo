import { describe, expect, test } from "bun:test";
import { compactMoney, decimalSeparator, fmtTrimLocale, LOCALE_OF, localizePadExpression } from "./format";
import { LOCALES } from "./i18n/registry";

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

describe("decimalSeparator — the numpad key's punctuation comes from Intl, not a dictionary", () => {
  test("every shipped language matches what Intl actually formats with", () => {
    for (const { code } of LOCALES) {
      const fromIntl = new Intl.NumberFormat(LOCALE_OF[code]).formatToParts(1.1).find((p) => p.type === "decimal")?.value;
      expect(decimalSeparator(code)).toBe(fromIntl as "." | ",");
    }
  });

  test("English writes a dot, Polish a comma", () => {
    expect(decimalSeparator("en")).toBe(".");
    expect(decimalSeparator("pl")).toBe(",");
  });

  test("only the two separators a 2-decimal currency UI can use are ever returned", () => {
    for (const { code } of LOCALES) expect([".", ","]).toContain(decimalSeparator(code));
  });
});

describe("localizePadExpression — display substitution, nothing else", () => {
  test("English swaps the canonical comma for a dot; Polish is already canonical", () => {
    expect(localizePadExpression("12,50", "en")).toBe("12.50");
    expect(localizePadExpression("12,50", "pl")).toBe("12,50");
  });

  test("operators, signs and a trailing open operator survive untouched", () => {
    expect(localizePadExpression("12,50+2,70", "en")).toBe("12.50+2.70");
    expect(localizePadExpression("-300,25×2", "en")).toBe("-300.25×2");
    expect(localizePadExpression("705,10+", "en")).toBe("705.10+");
    expect(localizePadExpression("100−7÷2", "en")).toBe("100−7÷2");
  });

  test("empty and whole (comma-free) expressions come back byte-identical in every language", () => {
    for (const { code } of LOCALES) {
      expect(localizePadExpression("", code)).toBe("");
      expect(localizePadExpression("1234", code)).toBe("1234");
      expect(localizePadExpression("-5000+", code)).toBe("-5000+");
    }
  });

  test("a half-typed decimal ('0,') keeps its trailing separator", () => {
    expect(localizePadExpression("0,", "en")).toBe("0.");
    expect(localizePadExpression("0,", "pl")).toBe("0,");
  });

  test("no grouping separator is ever introduced (editable state stays parseable)", () => {
    expect(localizePadExpression("1234567,89", "en")).toBe("1234567.89");
    expect(localizePadExpression("1234567,89", "pl")).toBe("1234567,89");
  });
});

describe("compactMoney", () => {
  test("thousands collapse, and the currency is the budget's, never a hardcoded symbol", () => {
    const en = compactMoney(2_696_290, "USD", "en"); // $26,962.90
    expect(en).toContain("27");
    expect(en).toContain("$");
    expect(en).not.toContain("26,962");
  });

  test("the locale decides grouping and symbol placement, not the code", () => {
    const pl = compactMoney(2_696_290, "PLN", "pl");
    expect(pl).toMatch(/27/);
    expect(pl).not.toContain("$");
  });

  test("small amounts stay legible rather than collapsing to 0", () => {
    expect(compactMoney(4200, "USD", "en")).toContain("42");
  });

  test("zero and negatives format without throwing", () => {
    expect(compactMoney(0, "USD", "en")).toContain("0");
    expect(compactMoney(-2_696_290, "USD", "en")).toContain("27");
    expect(compactMoney(-2_696_290, "USD", "en")).toMatch(/^-|−/);
  });
});
