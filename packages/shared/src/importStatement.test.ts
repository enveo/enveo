import { describe, expect, it } from "bun:test";
import { decodeImportTextPage, encodeImportTextPage, isImportTextPage, redactStatementPage, statementLinesFromTextItems } from "./importStatement";

describe("statement text pages", () => {
  it("round-trips UTF-8 text through the data URL that stands in for a screenshot", () => {
    const text = "28 Aug 2026  Card payment  PLN -12.34  PLN 1000.00\nDelikatesy Testowe, Żółć";
    const page = encodeImportTextPage(text);
    expect(isImportTextPage(page)).toBe(true);
    expect(decodeImportTextPage(page)).toBe(text);
    expect(isImportTextPage("data:image/jpeg;base64,/9j/")).toBe(false);
    expect(decodeImportTextPage("data:image/jpeg;base64,/9j/")).toBeNull();
  });

  it("rebuilds lines from positioned text items: same baseline left to right, lines top to bottom", () => {
    const lines = statementLinesFromTextItems([
      { str: "PLN -34.99", x: 300, y: 700 },
      { str: "1 Aug 2026", x: 20, y: 700.8 },
      { str: "Card payment", x: 120, y: 699.5 },
      { str: "FLUGGER POLAND", x: 20, y: 688 },
      { str: "   ", x: 5, y: 688 },
      { str: "PLN 2887.72", x: 450, y: 700 },
    ]);
    expect(lines).toEqual(["1 Aug 2026  Card payment  PLN -34.99  PLN 2887.72", "FLUGGER POLAND"]);
  });

  it("replaces account numbers and bank codes in place, keeping the balance columns they share a line with", () => {
    const page = [
      "PLN – Account Statement",
      "11222333444555666777888999  TOTAL INCOME  OPENING BALANCE",
      "Local BIC/SWIFT/SORT CODE: TESTPLPW  PLN 4 321.00  PLN 1 234.56",
      "Global IBAN: GB00 TEST 1234 5678 9012 34  TOTAL OUTCOME  CLOSING BALANCE",
      "Global BIC/SWIFT: TESTGB2L  PLN -3 210.99  PLN 2 344.57",
      "Jan Testowy",
      "1 Aug 2026  Card payment  PLN -34.99",
    ].join("\n");
    expect(redactStatementPage(page)).toBe(
      [
        "PLN – Account Statement",
        "[account]  TOTAL INCOME  OPENING BALANCE",
        "Local BIC/SWIFT/SORT CODE: [bank]  PLN 4 321.00  PLN 1 234.56",
        "Global IBAN: [account]  TOTAL OUTCOME  CLOSING BALANCE",
        "Global BIC/SWIFT: [bank]  PLN -3 210.99  PLN 2 344.57",
        "Jan Testowy",
        "1 Aug 2026  Card payment  PLN -34.99",
      ].join("\n"),
    );
  });
});
