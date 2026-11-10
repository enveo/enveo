import { describe, expect, it } from "bun:test";
import { printedAmountIn } from "./importAmounts";

describe("the amount printed in a currency", () => {
  it("reads codes and unambiguous symbols on either side of the figure", () => {
    expect(printedAmountIn(["−74,20 zł", "16,50 €"], "PLN")).toBe(7420);
    expect(printedAmountIn(["−74,20 zł", "16,50 €"], "EUR")).toBe(1650);
    expect(printedAmountIn(["€16.50", "PLN 1 274,20"], "PLN")).toBe(127420);
    expect(printedAmountIn(["16.50 EUR < 74.20 PLN"], "PLN")).toBe(7420);
  });

  it("never takes an exchange rate, a shared symbol or an ambiguous figure", () => {
    expect(printedAmountIn(["16.50 EUR < 74.20 PLN", "Exchange", "1.00 PLN =", "0.222372 EUR"], "PLN")).toBe(7420);
    expect(printedAmountIn(["16.50 EUR < 74.20 PLN", "Exchange", "1.00 PLN =", "0.222372 EUR"], "EUR")).toBe(1650);
    expect(printedAmountIn(["1 EUR = 4.50 PLN"], "PLN")).toBeNull();
    expect(printedAmountIn(["$16.50"], "USD")).toBeNull();
    expect(printedAmountIn(["16.50 EUR; fee 2.00 PLN", "74.20 PLN"], "PLN")).toBeNull();
    expect(printedAmountIn(["ZŁOTA RYBKA 12"], "PLN")).toBeNull();
  });
});
