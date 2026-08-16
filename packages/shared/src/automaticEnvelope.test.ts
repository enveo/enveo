import { describe, expect, it } from "bun:test";
import {
  automaticAllocatedForEnvelopeMonth,
  captureAllocationFlow,
  manualAllocationForDisplayedTotal,
  resolveAllocationFlow,
  transactionAllocationDeltas,
} from "./automaticEnvelope";
import { acc, tx } from "./ledger.test-support";

describe("captureAllocationFlow", () => {
  const accounts = [
    acc({ id: "A-checking", automaticEnvelopeId: null }),
    acc({ id: "A-save", automaticEnvelopeId: "E-save" }),
    acc({ id: "A-travel", automaticEnvelopeId: "E-travel" }),
    acc({ id: "A-off-budget", onBudget: false, automaticEnvelopeId: "E-ignored" }),
  ];

  it("captures linked income as a destination allocation", () => {
    expect(captureAllocationFlow(accounts, tx({ type: "income", accountId: "A-save" }))).toEqual({
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: "E-save",
    });
  });

  it("captures source-only and destination-only transfers", () => {
    expect(captureAllocationFlow(accounts, tx({ type: "transfer", accountId: "A-save", toAccountId: "A-checking" }))).toEqual({
      allocationFromEnvelopeId: "E-save",
      allocationToEnvelopeId: null,
    });
    expect(captureAllocationFlow(accounts, tx({ type: "transfer", accountId: "A-checking", toAccountId: "A-save" }))).toEqual({
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: "E-save",
    });
  });

  it("captures both sides of a transfer between different linked envelopes", () => {
    expect(captureAllocationFlow(accounts, tx({ type: "transfer", accountId: "A-save", toAccountId: "A-travel" }))).toEqual({
      allocationFromEnvelopeId: "E-save",
      allocationToEnvelopeId: "E-travel",
    });
  });

  it("ignores expenses and linked off-budget accounts defensively", () => {
    expect(captureAllocationFlow(accounts, tx({ type: "expense", accountId: "A-save" }))).toEqual({
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: null,
    });
    expect(captureAllocationFlow(accounts, tx({ type: "income", accountId: "A-off-budget" }))).toEqual({
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: null,
    });
    expect(captureAllocationFlow(accounts, tx({ type: "transfer", accountId: "A-off-budget", toAccountId: "A-save" }))).toEqual({
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: "E-save",
    });
  });
});

describe("resolveAllocationFlow", () => {
  const accounts = [
    acc({ id: "A-source", automaticEnvelopeId: "E-current-source" }),
    acc({ id: "A-destination", automaticEnvelopeId: "E-current-destination" }),
    acc({ id: "A-other", automaticEnvelopeId: "E-current-other" }),
  ];

  it("preserves recorded history when normalized routing is unchanged", () => {
    const previous = tx({
      type: "income",
      accountId: "A-destination",
      toAccountId: null,
      allocationToEnvelopeId: "E-historical",
    });

    expect(resolveAllocationFlow(accounts, { type: "income", accountId: "A-destination", toAccountId: "ignored" }, previous)).toEqual({
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: "E-historical",
    });
  });

  it("recaptures current links when an account route changes", () => {
    const previous = tx({
      type: "transfer",
      accountId: "A-source",
      toAccountId: "A-destination",
      allocationFromEnvelopeId: "E-historical-source",
      allocationToEnvelopeId: "E-historical-destination",
    });

    expect(resolveAllocationFlow(accounts, { type: "transfer", accountId: "A-source", toAccountId: "A-other" }, previous)).toEqual({
      allocationFromEnvelopeId: "E-current-source",
      allocationToEnvelopeId: "E-current-other",
    });
  });
});

describe("transactionAllocationDeltas", () => {
  it("emits a negative source-only delta and a positive destination-only delta", () => {
    expect(transactionAllocationDeltas(tx({ amount: 200_00, allocationFromEnvelopeId: "E-save" }))).toEqual([["E-save", -200_00]]);
    expect(transactionAllocationDeltas(tx({ amount: 500_00, allocationToEnvelopeId: "E-save" }))).toEqual([["E-save", 500_00]]);
  });

  it("emits signed source and destination deltas", () => {
    expect(transactionAllocationDeltas(tx({ amount: 500_00, allocationFromEnvelopeId: "E-save", allocationToEnvelopeId: "E-travel" }))).toEqual([
      ["E-save", -500_00],
      ["E-travel", 500_00],
    ]);
  });

  it("cancels a same-envelope transfer exactly", () => {
    expect(transactionAllocationDeltas(tx({ amount: 500_00, allocationFromEnvelopeId: "E-save", allocationToEnvelopeId: "E-save" }))).toEqual([]);
  });
});

describe("automatic monthly allocation", () => {
  const transactions = [
    tx({ date: "2026-08-02", amount: 500_00, allocationToEnvelopeId: "E-save" }),
    tx({ date: "2026-07-31", amount: 900_00, allocationToEnvelopeId: "E-save" }),
    tx({ date: "2026-08-21", amount: 200_00, allocationToEnvelopeId: "E-other" }),
  ];

  it("sums only the selected envelope and month", () => {
    expect(automaticAllocatedForEnvelopeMonth(transactions, "E-save", "2026-08")).toBe(500_00);
  });

  it("converts a displayed total back to its manual component", () => {
    expect(manualAllocationForDisplayedTotal(transactions, "E-save", "2026-08", 900_00)).toBe(400_00);
  });
});
