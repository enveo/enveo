import { describe, expect, test } from "bun:test";
import { type ImportHistoryQuery, type ImportHistoryRecord, normalizeImportHistoryText, selectImportHistoryCandidates } from "./importHistory";

const record = (over: Partial<ImportHistoryRecord> = {}): ImportHistoryRecord => ({
  accountId: "account-a",
  currency: "PLN",
  sourceRef: "BANK*FUEL 123",
  tag: "FUEL",
  place: "Fuel station",
  name: "Fuel",
  envelope: "Car",
  category: "Fuel",
  type: "expense",
  isRefund: false,
  toAccountId: null,
  ...over,
});

const query = (over: Partial<ImportHistoryQuery> = {}): ImportHistoryQuery => ({
  accountId: "account-a",
  ownedAccountIds: ["account-a", "account-b"],
  proposal: {
    rawPlace: "BANK*FUEL 123",
    tag: "FUEL",
    currency: "PLN",
    type: "expense",
    isRefund: false,
    semanticKind: "card_purchase",
    toAccountId: null,
  },
  ...over,
});

describe("selectImportHistoryCandidates", () => {
  test("returns an exact source reference as ranked evidence without a certainty flag", () => {
    const result = selectImportHistoryCandidates(query(), [record()]);

    expect(result).toMatchObject({
      conflict: false,
      candidates: [{ match: "exact_source_ref", envelope: "Car", name: "Fuel" }],
    });
    expect("confident" in result.candidates[0]!).toBe(false);
  });

  test("labels contained and fuzzy source matches as non-exact evidence", () => {
    const contained = selectImportHistoryCandidates(query({ proposal: { ...query().proposal, rawPlace: "BANK*FUEL 123 WARSAW" } }), [record()]);
    const fuzzy = selectImportHistoryCandidates(query({ proposal: { ...query().proposal, rawPlace: "BNK FUEL 123" } }), [record()]);

    expect(contained.candidates[0]?.match).not.toBe("exact_source_ref");
    expect(fuzzy.candidates[0]?.match).not.toBe("exact_source_ref");
  });

  test("excludes history from a different selected source account", () => {
    const result = selectImportHistoryCandidates(query(), [record({ accountId: "account-other" })]);

    expect(result).toEqual({ candidates: [], conflict: false });
  });

  test("excludes incompatible visible direction and refund facts", () => {
    const income = selectImportHistoryCandidates(query(), [record({ type: "income" })]);
    const refund = selectImportHistoryCandidates(query(), [record({ isRefund: true })]);

    expect(income.candidates).toEqual([]);
    expect(refund.candidates).toEqual([]);
  });

  test("does not learn a foreign-currency row from budget-currency history", () => {
    const result = selectImportHistoryCandidates(query({ proposal: { ...query().proposal, currency: "EUR" } }), [record({ currency: "PLN" })]);

    expect(result).toEqual({ candidates: [], conflict: false });
  });

  test("retains conflicting assignment patterns for one source", () => {
    const result = selectImportHistoryCandidates(query(), [record(), record({ envelope: "Eating out", category: "Restaurants", name: "Lunch" })]);

    expect(result.conflict).toBe(true);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((candidate) => candidate.envelope)).toEqual(["Car", "Eating out"]);
  });

  test("counts repeated evidence without collapsing a distinct assignment", () => {
    const result = selectImportHistoryCandidates(query(), [record(), record(), record({ envelope: "Eating out" })]);

    expect(result.candidates).toMatchObject([
      { envelope: "Car", count: 2 },
      { envelope: "Eating out", count: 1 },
    ]);
    expect(result.conflict).toBe(true);
  });

  test("keeps the evidence count when a stronger match represents the same assignment", () => {
    const result = selectImportHistoryCandidates(query(), [record({ sourceRef: "BANK FUEL" }), record()]);

    expect(result.candidates).toMatchObject([{ sourceRef: "BANK*FUEL 123", count: 2 }]);
  });

  test("does not treat a shared numeric card tag as merchant identity", () => {
    const result = selectImportHistoryCandidates(query({ proposal: { ...query().proposal, rawPlace: "OTHER SHOP 9876", tag: "9876" } }), [
      record({ sourceRef: null, tag: "9876", place: null }),
    ]);
    expect(result.metadata).toBeUndefined();
  });

  test("does not auto-assign a merchant whose name is only a prefix of another merchant", () => {
    const result = selectImportHistoryCandidates(query({ proposal: { ...query().proposal, rawPlace: "FUEL EXPRESS", tag: "" } }), [
      record({ sourceRef: "FUEL", tag: "FUEL", place: "Fuel" }),
    ]);
    expect(result.metadata).toBeUndefined();
  });

  test("uses a complete merchant line from manual history without a source reference", () => {
    const result = selectImportHistoryCandidates(query({ proposal: { ...query().proposal, rawPlace: "12.34 PLN\nFUEL STATION\nCARD 9876", tag: "" } }), [
      record({ sourceRef: null, tag: null }),
    ]);
    expect(result.metadata).toMatchObject({ name: "Fuel", place: "Fuel station", envelope: "Car" });
  });

  test("caps an oversized requested limit at five candidates", () => {
    const records = ["A", "B", "C", "D", "E", "F", "G"].map((envelope) => record({ envelope }));

    const result = selectImportHistoryCandidates(query(), records, 99);

    expect(result.candidates).toHaveLength(5);
  });

  test("orders equal evidence by semantic assignment fields, not history order", () => {
    const assignments = [record({ envelope: "A" }), record({ envelope: "B" })];

    expect(selectImportHistoryCandidates(query(), assignments, 1).candidates.map((candidate) => candidate.envelope)).toEqual(["A"]);
    expect(selectImportHistoryCandidates(query(), [...assignments].reverse(), 1).candidates.map((candidate) => candidate.envelope)).toEqual(["A"]);
  });

  test("keeps the complete representative evidence stable when null and empty source references tie", () => {
    const evidence = [record({ sourceRef: null }), record({ sourceRef: "" })];

    expect(selectImportHistoryCandidates(query(), evidence)).toEqual(selectImportHistoryCandidates(query(), [...evidence].reverse()));
  });

  test("preserves a conflict hidden by the display limit", () => {
    const result = selectImportHistoryCandidates(query(), [record({ envelope: "A" }), record({ envelope: "B" })], 1);

    expect(result.candidates).toHaveLength(1);
    expect(result.conflict).toBe(true);
  });

  test("offers an owned transfer target only for matching internal-transfer evidence", () => {
    const transfer = record({ type: "transfer", toAccountId: "account-b" });
    const foreignTarget = record({ type: "transfer", toAccountId: "account-foreign" });
    const internal = selectImportHistoryCandidates(query({ proposal: { ...query().proposal, semanticKind: "internal_transfer" } }), [transfer, foreignTarget]);
    const incomingCredit = selectImportHistoryCandidates(query({ proposal: { ...query().proposal, type: "income", semanticKind: "incoming_transfer" } }), [
      transfer,
    ]);

    expect(internal.candidates).toMatchObject([{ type: "transfer", toAccountId: "account-b" }]);
    expect(incomingCredit).toEqual({ candidates: [], conflict: false });
  });
});

describe("normalizeImportHistoryText", () => {
  test("folds Polish Ł, composed and decomposed accents, case, punctuation, and whitespace", () => {
    expect(normalizeImportHistoryText("  ŁÓDŹ — café / CAFE\u0301  ")).toBe("lodz cafe cafe");
  });
});

describe("history for uncertain bank entries", () => {
  test("offers prior income when the screenshot did not establish a type or direction", () => {
    // given: an unsigned invoice entry, with no established ledger type
    const uncertain = query({ proposal: { ...query().proposal, type: null, semanticKind: "unknown" }, direction: "unknown" });
    // when: the account has previously received money from that source
    const result = selectImportHistoryCandidates(uncertain, [record({ type: "income" })]);
    // then: history remains available as evidence for review
    expect(result.candidates).toMatchObject([{ type: "income" }]);
  });

  test("shows previous reimbursements when an unsigned entry was guessed to be a purchase", () => {
    const result = selectImportHistoryCandidates(query({ direction: "unknown" }), [record({ isRefund: true })]);
    expect(result.candidates).toMatchObject([{ isRefund: true }]);
    expect(result.conflict).toBe(true);
  });

  test("does not offer a refund against a visible debit", () => {
    expect(selectImportHistoryCandidates(query({ direction: "debit" }), [record({ isRefund: true })]).candidates).toEqual([]);
  });

  test("offers refunds for a visible incoming payment without also offering expenses", () => {
    const incoming = query({ direction: "credit", proposal: { ...query().proposal, type: "income", semanticKind: "incoming_transfer" } });
    const result = selectImportHistoryCandidates(incoming, [record(), record({ isRefund: true })]);
    expect(result.candidates).toMatchObject([{ type: "expense", isRefund: true }]);
    expect(result.conflict).toBe(true);
  });

  test("keeps exact evidence without manufacturing a conflict from weaker similar descriptions", () => {
    const result = selectImportHistoryCandidates(query(), [record(), record({ sourceRef: "BANK FUEL SERVICE", tag: null, name: "Other", envelope: "Other" })]);
    expect(result.candidates).toMatchObject([{ match: "exact_source_ref", envelope: "Car" }]);
    expect(result.candidates).toHaveLength(1);
    expect(result.conflict).toBe(false);
  });
});
