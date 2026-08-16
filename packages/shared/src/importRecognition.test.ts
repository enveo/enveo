import { describe, expect, it } from "bun:test";
import { parseImportExtractResponse } from "./aiPrompts";

describe("screenshot import recognition contract", () => {
  it("preserves every visual row as ordered, normalized extraction facts", () => {
    const batch = parseImportExtractResponse(
      JSON.stringify({
        rows: [
          {
            rowId: "r1",
            imageIndex: 0,
            visualOrder: 0,
            rawTextLines: [" 180.00 EUR < 776.95 PLN ", " 1.00 PLN = 0.231677 EUR "],
            date: "2026-08-07",
            amount: 77695,
            currency: "pln",
            direction: "debit",
            postingStatus: "posted",
            rowRole: "supporting_detail",
            semanticKind: "fx_conversion",
            relation: { kind: "fx_for", rowId: "r2" },
            confidence: "high",
            reviewReasons: ["relation_changes_ledger_shape"],
          },
          {
            rowId: "r2",
            imageIndex: 0,
            visualOrder: 1,
            rawTextLines: [" - 180.00 EUR ", " ANTHROPIC* CLAUDE "],
            date: "2026-08-07",
            amount: 18000,
            currency: "eur",
            direction: "debit",
            postingStatus: "posted",
            rowRole: "financial_event",
            semanticKind: "card_purchase",
            relation: null,
            confidence: "high",
            reviewReasons: [],
          },
          {
            rowId: "r3",
            imageIndex: 0,
            visualOrder: 2,
            rawTextLines: [" Pending card payment ", " - 25.00 PLN "],
            date: null,
            amount: 2500,
            currency: " pln ",
            direction: "debit",
            postingStatus: "pending",
            rowRole: "financial_event",
            semanticKind: "unknown",
            relation: null,
            confidence: "medium",
            reviewReasons: ["pending_or_declined", "unknown_kind"],
          },
          {
            rowId: "r4",
            imageIndex: 0,
            visualOrder: 3,
            rawTextLines: [" Cash top up ", " + 1,000.00 PLN "],
            date: "2026-08-08",
            amount: 100000,
            currency: "PLN",
            direction: "credit",
            postingStatus: "posted",
            rowRole: "financial_event",
            semanticKind: "account_topup",
            relation: null,
            confidence: "high",
            reviewReasons: [],
          },
        ],
      }),
    );

    expect(batch.rows.map((row) => row.rowId)).toEqual(["r1", "r2", "r3", "r4"]);
    expect(batch.rows.map((row) => [row.imageIndex, row.visualOrder])).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
    ]);
    expect(batch.rows.map((row) => row.currency)).toEqual(["PLN", "EUR", "PLN", "PLN"]);
    expect(batch.rows[0]!.rawTextLines).toEqual(["180.00 EUR < 776.95 PLN", "1.00 PLN = 0.231677 EUR"]);
    expect(batch.rows.map((row) => row.rowId)).toHaveLength(new Set(batch.rows.map((row) => row.rowId)).size);
  });
});
