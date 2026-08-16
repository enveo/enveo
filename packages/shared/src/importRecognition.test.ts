import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { parseImportExtractResponse } from "./aiPrompts";
import {
  type ImportDirection,
  type ImportExtractRow,
  type ImportProposal,
  type ImportSemanticKind,
  reconcileImportProposals,
  validateImportExtraction,
} from "./importRecognition";
import type { Account, Category, Envelope, Transaction } from "./types";

const extractRow = (over: Partial<ImportExtractRow> = {}): ImportExtractRow => ({
  rowId: "r1",
  imageIndex: 0,
  visualOrder: 0,
  rawTextLines: ["visible row"],
  date: "2026-08-07",
  amount: 1000,
  currency: "PLN",
  direction: "debit",
  postingStatus: "posted",
  rowRole: "financial_event",
  semanticKind: "card_purchase",
  relation: null,
  confidence: "medium",
  reviewReasons: [],
  ...over,
});

const proposalFor = (semanticKind: ImportSemanticKind, direction: ImportDirection): ImportProposal =>
  validateImportExtraction({
    batch: { rows: [extractRow({ semanticKind, direction })] },
    budgetCurrency: "PLN",
  }).proposals[0]!;

const account = (over: Partial<Account> = {}): Account => ({
  id: "account-1",
  name: "Current",
  color: "#000",
  icon: "wallet",
  type: "checking",
  onBudget: true,
  initialBalance: 0,
  archived: false,
  sort: 0,
  automaticEnvelopeId: null,
  ...over,
});

const transaction = (over: Partial<Transaction> = {}): Transaction => ({
  id: "transaction-1",
  type: "expense",
  accountId: "account-1",
  toAccountId: null,
  amount: 1000,
  date: "2026-08-07",
  isRefund: false,
  envelopeId: null,
  placeId: null,
  categoryId: null,
  name: null,
  note: null,
  tag: null,
  sourceRef: "visible row",
  allocationFromEnvelopeId: null,
  allocationToEnvelopeId: null,
  items: [],
  createdAt: "2026-08-07T00:00:00.000Z",
  ...over,
});

const envelope = (over: Partial<Envelope> = {}): Envelope => ({
  id: "envelope-1",
  groupId: "group-1",
  name: "Everyday",
  color: "#000",
  icon: "tag",
  note: null,
  monthlyTarget: null,
  isSavings: false,
  sort: 0,
  archived: false,
  ...over,
});

const category = (over: Partial<Category> = {}): Category => ({ id: "category-1", name: "Other", ...over });

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
    expect(Array.isArray(batch)).toBe(true);
    expect(batch[0]!.rawPlace).toBe("180.00 EUR < 776.95 PLN\n1.00 PLN = 0.231677 EUR");
    expect([...batch].map((item) => item.currency)).toEqual(["PLN", "EUR", "PLN"]);
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

describe("screenshot import proposal validation", () => {
  it("maps clear semantic facts to conservative ledger directions", () => {
    expect(proposalFor("cashback_or_reward", "credit")).toMatchObject({ type: "income", selected: true });
    expect(proposalFor("incoming_transfer", "credit")).toMatchObject({ type: "income", reviewReasons: ["possible_transfer"] });
    expect(proposalFor("merchant_refund", "credit")).toMatchObject({ type: "expense", isRefund: true });
    expect(proposalFor("internal_transfer", "credit")).toMatchObject({
      type: "income",
      reviewReasons: ["unknown_transfer_endpoint"],
      selected: true,
    });
    expect(proposalFor("unknown", "unknown")).toMatchObject({ disposition: "unresolved", selected: false });
  });

  it("keeps incomplete, supporting, pending, and declined source facts visible without selecting them", () => {
    const result = validateImportExtraction({
      batch: {
        rows: [
          extractRow({ rowId: "missing", amount: null, rawTextLines: ["unreadable amount"] }),
          extractRow({ rowId: "support", rowRole: "supporting_detail", semanticKind: "fx_conversion" }),
          extractRow({ rowId: "pending", postingStatus: "pending" }),
          extractRow({ rowId: "declined", postingStatus: "declined" }),
          extractRow({ rowId: "pending-missing", postingStatus: "pending", amount: null }),
        ],
      },
      budgetCurrency: "PLN",
    });

    expect(result.rows.map((row) => row.rowId)).toEqual(["missing", "support", "pending", "declined", "pending-missing"]);
    expect(result.proposals).toMatchObject([
      { rowId: "missing", disposition: "unresolved", selected: false, rawPlace: "unreadable amount", reviewReasons: ["missing_fact"] },
      { rowId: "support", disposition: "supporting", selected: false },
      { rowId: "pending", disposition: "pending", selected: false, reviewReasons: ["pending_or_declined"] },
      { rowId: "declined", disposition: "declined", selected: false, reviewReasons: ["pending_or_declined"] },
      { rowId: "pending-missing", disposition: "unresolved", selected: false, reviewReasons: ["missing_fact"] },
    ]);
  });

  it("rejects duplicate row identities and invalidates dangling or self relations", () => {
    expect(() =>
      validateImportExtraction({
        batch: { rows: [extractRow(), extractRow()] },
        budgetCurrency: "PLN",
      }),
    ).toThrow("duplicate rowId");

    const result = validateImportExtraction({
      batch: {
        rows: [
          extractRow({ rowId: "dangling", relation: { kind: "fee_for", rowId: "absent" } }),
          extractRow({ rowId: "self", relation: { kind: "refund_of", rowId: "self" } }),
        ],
      },
      budgetCurrency: "PLN",
    });

    expect(result.proposals).toMatchObject([
      { rowId: "dangling", disposition: "unresolved", selected: false, reviewReasons: ["invalid_relation"] },
      { rowId: "self", disposition: "unresolved", selected: false, reviewReasons: ["invalid_relation"] },
    ]);
  });

  it("marks relation-driven ledger-shape changes and impossible FX evidence for review", () => {
    const result = validateImportExtraction({
      batch: {
        rows: [
          extractRow({ rowId: "purchase", relation: { kind: "fx_for", rowId: "fx" } }),
          extractRow({ rowId: "fx", rowRole: "supporting_detail", semanticKind: "fx_conversion", currency: "PLN" }),
        ],
      },
      budgetCurrency: "PLN",
    });

    expect(result.proposals).toMatchObject([
      { rowId: "purchase", selected: false, reviewReasons: ["relation_changes_ledger_shape", "impossible_fx"] },
      { rowId: "fx", selected: false, reviewReasons: ["relation_changes_ledger_shape", "impossible_fx"] },
    ]);
  });

  it("rejects impossible dates, non-positive amounts, and non-two-decimal currencies", () => {
    const result = validateImportExtraction({
      batch: {
        rows: [
          extractRow({ rowId: "date", date: "2026-02-29" }),
          extractRow({ rowId: "amount", amount: 0 }),
          extractRow({ rowId: "currency", currency: "JPY" }),
        ],
      },
      budgetCurrency: "PLN",
    });

    expect(result.proposals).toMatchObject([
      { rowId: "date", disposition: "unresolved", selected: false, reviewReasons: ["missing_fact"] },
      { rowId: "amount", disposition: "unresolved", selected: false, reviewReasons: ["missing_fact"] },
      { rowId: "currency", disposition: "unresolved", selected: false, reviewReasons: ["unsupported_currency"] },
    ]);
  });
});

describe("screenshot import proposal reconciliation", () => {
  const proposal = (): ImportProposal => validateImportExtraction({ batch: { rows: [extractRow()] }, budgetCurrency: "PLN" }).proposals[0]!;
  const input = (over: Partial<Parameters<typeof reconcileImportProposals>[0]> = {}) => ({
    proposals: [proposal()],
    transactions: [],
    accounts: [account()],
    envelopes: [envelope()],
    categories: [category()],
    selectedAccountId: "account-1",
    ...over,
  });

  it("clears stale assignments and uses exact and probable duplicate evidence", () => {
    const stale = { ...proposal(), envelopeId: "missing-envelope", categoryId: "missing-category" };
    const exact = reconcileImportProposals(input({ proposals: [stale], transactions: [transaction()] }))[0]!;
    const probable = reconcileImportProposals(input({ transactions: [transaction({ sourceRef: null })] }))[0]!;

    expect(exact).toMatchObject({
      envelopeId: null,
      categoryId: null,
      duplicateStatus: "exists",
      disposition: "declined",
      selected: false,
      reviewReasons: ["history_conflict"],
    });
    expect(probable).toMatchObject({
      duplicateStatus: "probable",
      disposition: "candidate",
      selected: false,
      reviewReasons: ["multiple_history_candidates"],
    });
  });

  it("invalidates a missing or archived selected source account", () => {
    const missing = reconcileImportProposals(input({ accounts: [], selectedAccountId: "gone" }))[0]!;
    const archived = reconcileImportProposals(input({ accounts: [account({ archived: true })] }))[0]!;

    expect(missing).toMatchObject({ sourceAccountInvalid: true, disposition: "unresolved", selected: false });
    expect(archived).toMatchObject({ sourceAccountInvalid: true, disposition: "unresolved", selected: false });
  });

  it("property: reconciliation is byte-identical when repeated against the same ledger", () => {
    fc.assert(
      fc.property(fc.array(fc.record({ amount: fc.integer({ min: 1, max: 100_000 }), sameSource: fc.boolean() }), { maxLength: 8 }), (existing) => {
        const proposals = [proposal(), { ...proposal(), rowId: "r2", sourceRows: ["r2"], rawPlace: "other visible row" }];
        const transactions = existing.map((item, index) =>
          transaction({ id: `existing-${index}`, amount: item.amount, sourceRef: item.sameSource ? "visible row" : null }),
        );
        const reconciliationInput = input({ proposals, transactions });
        expect(reconcileImportProposals(reconciliationInput)).toEqual(reconcileImportProposals(reconciliationInput));
      }),
      { numRuns: 100 },
    );
  });
});
