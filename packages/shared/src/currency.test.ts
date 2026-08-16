import { describe, expect, it } from "bun:test";
import { CURRENCY_DIGITS, isSupportedCurrency, SUPPORTED_CURRENCIES } from "./currency";

describe("shared supported currencies", () => {
  it("offers only currencies the integer-minor-unit ledger can represent", () => {
    expect(SUPPORTED_CURRENCIES).toContain("PLN");
    expect(isSupportedCurrency("USD")).toBe(true);
    expect(isSupportedCurrency("JPY")).toBe(false);
    expect(SUPPORTED_CURRENCIES.every((currency) => CURRENCY_DIGITS[currency] === 2)).toBe(true);
  });
});
