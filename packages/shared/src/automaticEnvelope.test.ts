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

  it("treats a pre-3.8 replica row (no automaticEnvelopeId key) as UNLINKED, not as a link to undefined", () => {
    // The field arrived in 3.8; account rows written by an older client simply lack it. Raw
    // `undefined` passed every `!== null` check downstream — the transfer card showed its envelope
    // switch and the preview claimed "no envelope change" for accounts that have no link at all.
    const legacy = acc({ id: "A-legacy" });
    delete (legacy as { automaticEnvelopeId?: string | null }).automaticEnvelopeId;
    const legacyPair = [legacy, { ...acc({ id: "A-legacy-2" }), automaticEnvelopeId: undefined } as unknown as (typeof accounts)[number]];

    const flow = captureAllocationFlow(legacyPair, tx({ type: "transfer", accountId: "A-legacy", toAccountId: "A-legacy-2" }));
    expect(flow).toEqual({ allocationFromEnvelopeId: null, allocationToEnvelopeId: null });
    expect(transactionAllocationDeltas({ amount: 1500, ...flow })).toEqual([]);
  });

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

  it("normalises a pre-3.8 transaction's missing allocation keys to null when the route is unchanged", () => {
    const legacy = tx({ type: "transfer", accountId: "A-source", toAccountId: "A-destination" });
    delete (legacy as { allocationFromEnvelopeId?: string | null }).allocationFromEnvelopeId;
    delete (legacy as { allocationToEnvelopeId?: string | null }).allocationToEnvelopeId;

    expect(resolveAllocationFlow(accounts, { type: "transfer", accountId: "A-source", toAccountId: "A-destination" }, legacy)).toEqual({
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: null,
    });
  });

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

  it("subtracts a source allocation in the selected month", () => {
    const sourceAllocation = tx({ date: "2026-08-12", amount: 200_00, allocationFromEnvelopeId: "E-save" });

    expect(automaticAllocatedForEnvelopeMonth([sourceAllocation], "E-save", "2026-08")).toBe(-200_00);
  });

  it("keeps a same-envelope allocation neutral", () => {
    const sameEnvelope = tx({
      date: "2026-08-12",
      amount: 200_00,
      allocationFromEnvelopeId: "E-save",
      allocationToEnvelopeId: "E-save",
    });

    expect(automaticAllocatedForEnvelopeMonth([sameEnvelope], "E-save", "2026-08")).toBe(0);
  });

  it("converts a displayed total back to its manual component", () => {
    expect(manualAllocationForDisplayedTotal(transactions, "E-save", "2026-08", 900_00)).toBe(400_00);
  });
});
