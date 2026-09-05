import { describe, expect, it } from "bun:test";
import { buildImportDupIndex, classifyImportDup, existingImportRowsForAccount, importCandidateDirection } from "./importDedupe";

describe("shared import duplicate classification", () => {
  const index = buildImportDupIndex([
    { date: "2026-07-09", amount: 9600, sourceRef: "UM HALINOW" },
    { date: "2026-07-07", amount: 20000, sourceRef: null },
  ]);

  it("classifies strong, weak and new matches exactly like the API contract", () => {
    expect(classifyImportDup({ date: "2026-07-09", amount: 9600, rawPlace: "  um halinow " }, index)).toBe("exists");
    expect(classifyImportDup({ date: "2026-07-09", amount: 9600, rawPlace: "OTHER" }, index)).toBe("probable");
    expect(classifyImportDup({ date: "2026-07-07", amount: 20000 }, index)).toBe("probable");
    expect(classifyImportDup({ date: "2026-07-08", amount: 20000, rawPlace: "OTHER" }, index)).toBe("new");
  });

  it("recognizes an existing source reference when the current OCR row preserves it as one complete line", () => {
    const existing = buildImportDupIndex([{ date: "2026-07-09", amount: 9600, sourceRef: "UM HALINOW" }]);

    expect(classifyImportDup({ date: "2026-07-09", amount: 9600, rawPlace: "96.00 PLN\nUM HALINOW\nCARD 1234" }, existing)).toBe("exists");
    expect(classifyImportDup({ date: "2026-07-09", amount: 9600, rawPlace: "UM HALINOW MARKET" }, existing)).toBe("probable");
  });

  it("deduplicates a repeated raw row inside one batch without blocking equal-value rows from different places", () => {
    const empty = buildImportDupIndex([]);
    empty.markSeen({ date: "2026-07-01", amount: 5000, rawPlace: "LIDL 123" });
    expect(classifyImportDup({ date: "2026-07-01", amount: 5000, rawPlace: "LIDL 123" }, empty)).toBe("exists");
    expect(classifyImportDup({ date: "2026-07-01", amount: 5000, rawPlace: "ORLEN 77" }, empty)).toBe("new");
  });
});

describe("transfers as duplicate evidence", () => {
  const ledger = [
    { accountId: "platinum", toAccountId: "zen", type: "transfer", date: "2026-09-02", amount: 300000, sourceRef: "BLIK ZEN" },
    { accountId: "zen", toAccountId: "platinum", type: "transfer", date: "2026-09-03", amount: 5000, sourceRef: null },
    { accountId: "zen", toAccountId: null, type: "expense", date: "2026-09-02", amount: 1500, sourceRef: "LIDL" },
    { accountId: "platinum", toAccountId: null, type: "expense", date: "2026-09-02", amount: 300000, sourceRef: "CAR" },
  ];

  it("collects the account's own rows plus transfers into it, with the direction the account saw", () => {
    expect(existingImportRowsForAccount(ledger, "zen")).toEqual([
      { date: "2026-09-02", amount: 300000, sourceRef: "BLIK ZEN", transferDirection: "in" },
      { date: "2026-09-03", amount: 5000, sourceRef: null, transferDirection: "out" },
      { date: "2026-09-02", amount: 1500, sourceRef: "LIDL" },
    ]);
  });

  it("treats a same-day top-up as the transfer already recorded from the sending account", () => {
    const index = buildImportDupIndex(existingImportRowsForAccount(ledger, "zen"));
    const topUp = { date: "2026-09-02", amount: 300000, rawPlace: "3 000.00 PLN +\nUAB ZEN.COM\nZEN account top-up" };

    expect(classifyImportDup({ ...topUp, direction: "in" }, index)).toBe("exists");
    // the same amount leaving the account that day is not that transfer, and an incoming
    // transfer never makes an unrelated same-day amount "probable"
    expect(classifyImportDup({ ...topUp, direction: "out" }, index)).toBe("new");
    expect(classifyImportDup(topUp, index)).toBe("new");
    // an outgoing transfer keeps today's weak evidence
    expect(classifyImportDup({ date: "2026-09-03", amount: 5000, rawPlace: "PRZELEW", direction: "out" }, index)).toBe("exists");
    expect(classifyImportDup({ date: "2026-09-03", amount: 5000, rawPlace: "PRZELEW" }, index)).toBe("probable");
  });

  it("derives the candidate's direction from its type, refund flag and transfer endpoints", () => {
    expect(importCandidateDirection({ type: "income" }, "zen")).toBe("in");
    expect(importCandidateDirection({ type: "expense" }, "zen")).toBe("out");
    expect(importCandidateDirection({ type: "expense", isRefund: true }, "zen")).toBe("in");
    expect(importCandidateDirection({ type: "transfer", accountId: "zen", toAccountId: "platinum" }, "zen")).toBe("out");
    expect(importCandidateDirection({ type: "transfer", accountId: "platinum", toAccountId: "zen" }, "zen")).toBe("in");
  });
});
