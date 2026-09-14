import { describe, expect, it } from "bun:test";
import { decodeImportTextPage, encodeImportTextPage, isImportTextPage, redactStatementPage, statementLinesFromTextItems } from "./importStatement";

describe("statement text pages", () => {
  it("round-trips UTF-8 text through the data URL that stands in for a screenshot", () => {
    const text = "28 Aug 2031  Card payment  USD -18.47  USD 742.16\nExample Market, Żółć";
    const page = encodeImportTextPage(text);
    expect(isImportTextPage(page)).toBe(true);
    expect(decodeImportTextPage(page)).toBe(text);
    expect(isImportTextPage("data:image/jpeg;base64,/9j/")).toBe(false);
    expect(decodeImportTextPage("data:image/jpeg;base64,/9j/")).toBeNull();
  });

  it("rebuilds lines from positioned text items: same baseline left to right, lines top to bottom", () => {
    const lines = statementLinesFromTextItems([
      { str: "USD -27.41", x: 300, y: 700 },
      { str: "1 Aug 2031", x: 20, y: 700.8 },
      { str: "Card payment", x: 120, y: 699.5 },
      { str: "EXAMPLE HARDWARE", x: 20, y: 688 },
      { str: "   ", x: 5, y: 688 },
      { str: "USD 714.75", x: 450, y: 700 },
    ]);
    expect(lines).toEqual(["1 Aug 2031  Card payment  USD -27.41  USD 714.75", "EXAMPLE HARDWARE"]);
  });

  it("replaces account numbers and bank codes in place, keeping the balance columns they share a line with", () => {
    const page = [
      "USD – Account Statement",
      "99887766554433221100998877  TOTAL INCOME  OPENING BALANCE",
      "Local BIC/SWIFT/SORT CODE: TESTUS00  USD 2 684.19  USD 917.42",
      "Global IBAN: GB00 TEST 1234 5678 9012 34  TOTAL OUTCOME  CLOSING BALANCE",
      "Global BIC/SWIFT: TESTUS01  USD -1 438.56  USD 2 163.05",
      "Avery Sample",
      "1 Aug 2031  Card payment  USD -27.41",
    ].join("\n");
    expect(redactStatementPage(page)).toBe(
      [
        "USD – Account Statement",
        "[account]  TOTAL INCOME  OPENING BALANCE",
        "Local BIC/SWIFT/SORT CODE: [bank]  USD 2 684.19  USD 917.42",
        "Global IBAN: [account]  TOTAL OUTCOME  CLOSING BALANCE",
        "Global BIC/SWIFT: [bank]  USD -1 438.56  USD 2 163.05",
        "Avery Sample",
        "1 Aug 2031  Card payment  USD -27.41",
      ].join("\n"),
    );
  });
});
