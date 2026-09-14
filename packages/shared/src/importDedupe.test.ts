import { describe, expect, it } from "bun:test";
import { buildImportDupIndex, classifyImportDup, existingImportRowsForAccount, importCandidateDirection } from "./importDedupe";

describe("shared import duplicate classification", () => {
  const index = buildImportDupIndex([
    { date: "2031-07-09", amount: 7384, sourceRef: "EXAMPLE CORNER STORE" },
    { date: "2031-07-07", amount: 16275, sourceRef: null },
  ]);

  it("classifies strong, weak and new matches exactly like the API contract", () => {
    expect(classifyImportDup({ date: "2031-07-09", amount: 7384, rawPlace: "  example corner store " }, index)).toBe("exists");
    expect(classifyImportDup({ date: "2031-07-09", amount: 7384, rawPlace: "OTHER" }, index)).toBe("probable");
    expect(classifyImportDup({ date: "2031-07-07", amount: 16275 }, index)).toBe("probable");
    expect(classifyImportDup({ date: "2031-07-08", amount: 16275, rawPlace: "OTHER" }, index)).toBe("new");
  });

  it("recognizes an existing source reference when the current OCR row preserves it as one complete line", () => {
    const existing = buildImportDupIndex([{ date: "2031-07-09", amount: 7384, sourceRef: "EXAMPLE CORNER STORE" }]);

    expect(classifyImportDup({ date: "2031-07-09", amount: 7384, rawPlace: "73.84 USD\nEXAMPLE CORNER STORE\nCARD 8642" }, existing)).toBe("exists");
    expect(classifyImportDup({ date: "2031-07-09", amount: 7384, rawPlace: "EXAMPLE CORNER STORE MARKET" }, existing)).toBe("probable");
  });

  it("deduplicates a repeated raw row inside one batch without blocking equal-value rows from different places", () => {
    const empty = buildImportDupIndex([]);
    empty.markSeen({ date: "2031-07-01", amount: 4186, rawPlace: "EXAMPLE MARKET 123" });
    expect(classifyImportDup({ date: "2031-07-01", amount: 4186, rawPlace: "EXAMPLE MARKET 123" }, empty)).toBe("exists");
    expect(classifyImportDup({ date: "2031-07-01", amount: 4186, rawPlace: "EXAMPLE FUEL 77" }, empty)).toBe("new");
  });

  it.each(["◷", "🕒"])("ignores the %s status clock when matching a repeated payment", (clock) => {
     
    const payment = { date: "2031-09-06", amount: 3187, rawPlace: "31.87 EUR\nCEDAR TABLE CAFE\n8642" };
    const withClock = `${clock} ${payment.rawPlace}`;
    const existing = buildImportDupIndex([{ ...payment, sourceRef: withClock }]);

     
    expect(classifyImportDup(payment, existing)).toBe("exists");
    const batch = buildImportDupIndex([]);
    batch.markSeen(payment);
    expect(classifyImportDup({ ...payment, rawPlace: withClock }, batch)).toBe("exists");

    // and: a clock never substitutes for the date, amount or full merchant evidence
    expect(classifyImportDup({ ...payment, date: "2031-09-07" }, existing)).toBe("new");
    expect(classifyImportDup({ ...payment, amount: 3298 }, existing)).toBe("new");
    expect(classifyImportDup({ ...payment, rawPlace: "31.87 EUR" }, existing)).toBe("probable");
    expect(classifyImportDup({ ...payment, rawPlace: payment.rawPlace.replace("CEDAR", "MAPLE") }, existing)).toBe("probable");
    expect(classifyImportDup({ ...payment, rawPlace: `+${payment.rawPlace}` }, existing)).toBe("probable");
  });
});

describe("transfers as duplicate evidence", () => {
  const ledger = [
    { accountId: "checking-west", toAccountId: "checking-east", type: "transfer", date: "2031-09-02", amount: 184275, sourceRef: "EXAMPLE TRANSFER SERVICE" },
    { accountId: "checking-east", toAccountId: "checking-west", type: "transfer", date: "2031-09-03", amount: 6729, sourceRef: null },
    { accountId: "checking-east", toAccountId: null, type: "expense", date: "2031-09-02", amount: 2348, sourceRef: "EXAMPLE MARKET" },
    { accountId: "checking-west", toAccountId: null, type: "expense", date: "2031-09-02", amount: 184275, sourceRef: "AUTO REPAIR" },
  ];

  it("collects the account's own rows plus transfers into it, with the direction the account saw", () => {
    expect(existingImportRowsForAccount(ledger, "checking-east")).toEqual([
      { date: "2031-09-02", amount: 184275, sourceRef: "EXAMPLE TRANSFER SERVICE", transferDirection: "in" },
      { date: "2031-09-03", amount: 6729, sourceRef: null, transferDirection: "out" },
      { date: "2031-09-02", amount: 2348, sourceRef: "EXAMPLE MARKET" },
    ]);
  });

  it("treats a same-day top-up as the transfer already recorded from the sending account", () => {
    const index = buildImportDupIndex(existingImportRowsForAccount(ledger, "checking-east"));
    const topUp = { date: "2031-09-02", amount: 184275, rawPlace: "$1,842.75 +\nEXAMPLE TRANSFER SERVICE\nChecking account top-up" };

    expect(classifyImportDup({ ...topUp, direction: "in" }, index)).toBe("exists");
    // the same amount leaving the account that day is not that transfer, and an incoming
    // transfer never makes an unrelated same-day amount "probable"
    expect(classifyImportDup({ ...topUp, direction: "out" }, index)).toBe("new");
    expect(classifyImportDup(topUp, index)).toBe("new");
     
    expect(classifyImportDup({ date: "2031-09-03", amount: 6729, rawPlace: "TRANSFER", direction: "out" }, index)).toBe("exists");
    expect(classifyImportDup({ date: "2031-09-03", amount: 6729, rawPlace: "TRANSFER" }, index)).toBe("probable");
  });

  it("derives the candidate's direction from its type, refund flag and transfer endpoints", () => {
    expect(importCandidateDirection({ type: "income" }, "checking-east")).toBe("in");
    expect(importCandidateDirection({ type: "expense" }, "checking-east")).toBe("out");
    expect(importCandidateDirection({ type: "expense", isRefund: true }, "checking-east")).toBe("in");
    expect(importCandidateDirection({ type: "transfer", accountId: "checking-east", toAccountId: "checking-west" }, "checking-east")).toBe("out");
    expect(importCandidateDirection({ type: "transfer", accountId: "checking-west", toAccountId: "checking-east" }, "checking-east")).toBe("in");
  });
});
