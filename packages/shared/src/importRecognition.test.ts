import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { parseImportExtractResponse } from "./aiPrompts";
import {
  applyImportEnrichment,
  type ImportDirection,
  type ImportEnrichmentAnswer,
  type ImportExtractRow,
  type ImportProposal,
  type ImportSemanticKind,
  needsImportEnrichment,
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
      1,
    );

    expect(batch.rows.map((row) => row.rowId)).toEqual(["r1", "r2", "r3", "r4"]);
    expect(Array.isArray(batch)).toBe(false);
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

  it("rejects invalid visual positions and sorts valid rows by their screenshot position", () => {
    const modelRow = (rowId: string, imageIndex: number, visualOrder: number) => ({
      ...extractRow({ rowId, imageIndex, visualOrder }),
    });

    expect(() => parseImportExtractResponse(JSON.stringify({ rows: [modelRow("outside", 2, 0)] }), 2)).toThrow("imageIndex");
    expect(() => parseImportExtractResponse(JSON.stringify({ rows: [modelRow("one", 0, 1), modelRow("two", 0, 1)] }), 1)).toThrow("visual position");

    const parsed = parseImportExtractResponse(JSON.stringify({ rows: [modelRow("third", 1, 0), modelRow("second", 0, 2), modelRow("first", 0, 1)] }), 2);
    expect(parsed.rows.map((row) => row.rowId)).toEqual(["first", "second", "third"]);
  });
});

describe("screenshot import proposal validation", () => {
  it("keeps new financial events selected while review warnings stay informational", () => {
    const result = validateImportExtraction({
      batch: {
        rows: [
          extractRow({ rowId: "topup", direction: "credit", semanticKind: "account_topup" }),
          extractRow({ rowId: "uncertain", reviewReasons: ["possible_ocr_error"] }),
          extractRow({ rowId: "related", relation: { kind: "counterpart_of", rowId: "topup" } }),
        ],
      },
      budgetCurrency: "PLN",
    });
    expect(result.proposals).toMatchObject([
      { rowId: "topup", disposition: "candidate", selected: true, reviewReasons: ["possible_transfer", "relation_changes_ledger_shape"] },
      { rowId: "uncertain", disposition: "candidate", selected: true, reviewReasons: ["possible_ocr_error"] },
      { rowId: "related", disposition: "candidate", selected: true, reviewReasons: ["relation_changes_ledger_shape"] },
    ]);
  });

  it("selects an incomplete financial event but keeps it unresolved until the user acts", () => {
    const result = validateImportExtraction({
      batch: { rows: [extractRow({ rowId: "missing", amount: null })] },
      budgetCurrency: "PLN",
    });
    expect(result.proposals[0]).toMatchObject({ rowId: "missing", disposition: "unresolved", selected: true, reviewReasons: ["missing_fact"] });
  });

  it("maps clear semantic facts to conservative ledger directions", () => {
    expect(proposalFor("cashback_or_reward", "credit")).toMatchObject({ type: "income", selected: true });
    expect(proposalFor("incoming_transfer", "credit")).toMatchObject({ type: "income", selected: true, reviewReasons: ["possible_transfer"] });
    expect(proposalFor("account_topup", "credit")).toMatchObject({ type: "income", selected: true, reviewReasons: ["possible_transfer"] });
    expect(proposalFor("merchant_refund", "credit")).toMatchObject({ type: "expense", isRefund: true });
    expect(proposalFor("internal_transfer", "credit")).toMatchObject({
      type: "income",
      reviewReasons: ["unknown_transfer_endpoint"],
      selected: true,
    });
    expect(proposalFor("unknown", "unknown")).toMatchObject({ disposition: "unresolved", selected: true });
  });

  it("keeps an unknown posting status selected but marks it for review", () => {
    const result = validateImportExtraction({ batch: { rows: [extractRow({ postingStatus: "unknown" })] }, budgetCurrency: "PLN" });

    expect(result.proposals[0]).toMatchObject({ type: "expense", disposition: "candidate", selected: true });
    expect(result.proposals[0]!.reviewReasons).toContain("unknown_posting_status");
  });

  it("keeps a financial FX row selected but blocks it until the user reviews it", () => {
    const result = validateImportExtraction({
      batch: { rows: [extractRow({ semanticKind: "fx_conversion", rowRole: "financial_event" })] },
      budgetCurrency: "PLN",
    });

    expect(result.proposals[0]).toMatchObject({
      type: null,
      disposition: "unresolved",
      selected: true,
      reviewReasons: ["unknown_kind"],
    });
  });

  it("selects incomplete financial facts while leaving supporting, pending, and declined rows unselected", () => {
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
      { rowId: "missing", disposition: "unresolved", selected: true, rawPlace: "unreadable amount", reviewReasons: ["missing_fact"] },
      { rowId: "support", disposition: "supporting", selected: false },
      { rowId: "pending", disposition: "pending", selected: false, reviewReasons: ["pending_or_declined"] },
      { rowId: "declined", disposition: "declined", selected: false, reviewReasons: ["pending_or_declined"] },
      { rowId: "pending-missing", disposition: "pending", selected: false, reviewReasons: ["missing_fact", "pending_or_declined"] },
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
      { rowId: "dangling", disposition: "unresolved", selected: true, reviewReasons: ["invalid_relation"] },
      { rowId: "self", disposition: "unresolved", selected: true, reviewReasons: ["invalid_relation"] },
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
      { rowId: "purchase", selected: true, reviewReasons: ["relation_changes_ledger_shape", "impossible_fx"] },
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
      { rowId: "date", disposition: "unresolved", selected: true, reviewReasons: ["missing_fact"] },
      { rowId: "amount", disposition: "unresolved", selected: true, reviewReasons: ["missing_fact"] },
      { rowId: "currency", disposition: "unresolved", selected: true, reviewReasons: ["unsupported_currency"] },
    ]);
  });
});

describe("screenshot import enrichment gate", () => {
  const resultFor = (over: Partial<ImportExtractRow> = {}) => validateImportExtraction({ batch: { rows: [extractRow(over)] }, budgetCurrency: "PLN" });

  it("skips cycle two for straightforward posted purchases and salaries", () => {
    expect(needsImportEnrichment(resultFor())).toBe(false);
    expect(needsImportEnrichment(resultFor({ semanticKind: "salary", direction: "credit" }))).toBe(false);
  });

  it("runs cycle two for uncertainty, history ambiguity, OCR risk, transfer gaps, relations, and invalid facts", () => {
    const risky = [
      resultFor({ semanticKind: "unknown", direction: "unknown" }),
      resultFor({ reviewReasons: ["history_conflict"] }),
      resultFor({ reviewReasons: ["multiple_history_candidates"] }),
      resultFor({ reviewReasons: ["possible_ocr_error"] }),
      resultFor({ semanticKind: "internal_transfer" }),
      validateImportExtraction({
        batch: {
          rows: [extractRow({ rowId: "purchase", relation: { kind: "fee_for", rowId: "fee" } }), extractRow({ rowId: "fee", semanticKind: "fee" })],
        },
        budgetCurrency: "PLN",
      }),
      resultFor({ amount: null }),
    ];

    expect(risky.map(needsImportEnrichment)).toEqual([true, true, true, true, true, true, true]);
  });
});

describe("screenshot import enrichment merge", () => {
  const result = () =>
    validateImportExtraction({
      batch: { rows: [extractRow({ reviewReasons: ["possible_ocr_error"] })] },
      budgetCurrency: "PLN",
    });
  const answer = (rows: ImportEnrichmentAnswer["rows"]): ImportEnrichmentAnswer => ({
    rows,
    allowedEnvelopeIds: ["envelope-1"],
    allowedCategoryIds: ["category-1"],
    allowedAccountIds: ["account-1"],
  });

  it("merges only semantic annotations and known current entity ids", () => {
    const before = result();
    const merged = applyImportEnrichment(
      before,
      answer([
        {
          rowId: "r1",
          name: "Groceries",
          place: "Lidl",
          envelopeId: "envelope-1",
          categoryId: "category-1",
          semanticKind: "card_purchase",
          relation: null,
          reviewReasons: ["unknown_kind"],
        },
      ]),
    );

    expect(merged.rows[0]).toMatchObject(before.rows[0]!);
    expect(merged.proposals[0]).toMatchObject({
      date: "2026-08-07",
      amount: 1000,
      currency: "PLN",
      rawPlace: "visible row",
      name: "Groceries",
      placeName: "Lidl",
      envelopeId: "envelope-1",
      categoryId: "category-1",
      reviewReasons: ["possible_ocr_error"],
    });
  });

  it("ignores fact rewrites and unknown ids, then adds fact_correction without removing deterministic reasons", () => {
    const malicious = {
      rowId: "r1",
      name: "Safe label",
      place: null,
      envelopeId: "invented-envelope",
      categoryId: "invented-category",
      semanticKind: "card_purchase",
      relation: { kind: "counterpart_of", rowId: "invented-row" },
      reviewReasons: [],
      date: "2020-01-01",
      amount: 1,
      currency: "USD",
      direction: "credit",
      postingStatus: "declined",
      rawTextLines: ["fabricated"],
      rawPlace: "fabricated",
    };
    const merged = applyImportEnrichment(result(), answer([malicious as ImportEnrichmentAnswer["rows"][number]]));

    expect(merged.rows[0]).toMatchObject(extractRow({ reviewReasons: ["possible_ocr_error"] }));
    expect(merged.proposals[0]).toMatchObject({
      date: "2026-08-07",
      amount: 1000,
      currency: "PLN",
      rawPlace: "visible row",
      envelopeId: null,
      categoryId: null,
      relation: null,
      reviewReasons: ["possible_ocr_error", "fact_correction"],
      selected: true,
    });
  });

  it("ignores an answer for an unknown row id and surfaces the attempted correction", () => {
    const merged = applyImportEnrichment(
      result(),
      answer([
        {
          rowId: "never-supplied",
          name: "Invented row",
          place: null,
          envelopeId: null,
          categoryId: null,
          semanticKind: "card_purchase",
          relation: null,
          reviewReasons: [],
        },
      ]),
    );

    expect(merged.proposals).toEqual([expect.objectContaining({ rowId: "r1", name: "", reviewReasons: ["possible_ocr_error", "fact_correction"] })]);
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
      selected: true,
      reviewReasons: ["multiple_history_candidates"],
    });
  });

  it("invalidates a missing or archived selected source account", () => {
    const missing = reconcileImportProposals(input({ accounts: [], selectedAccountId: "gone" }))[0]!;
    const archived = reconcileImportProposals(input({ accounts: [account({ archived: true })] }))[0]!;

    expect(missing).toMatchObject({ sourceAccountInvalid: true, disposition: "unresolved", selected: false });
    expect(archived).toMatchObject({ sourceAccountInvalid: true, disposition: "unresolved", selected: false });
  });

  it("keeps exact and probable duplicate evidence when reconciling an already reconciled proposal", () => {
    const exactInput = input({ transactions: [transaction()] });
    const probableInput = input({ transactions: [transaction({ sourceRef: null })] });
    const exact = reconcileImportProposals(exactInput);
    const probable = reconcileImportProposals(probableInput);

    expect(reconcileImportProposals({ ...exactInput, proposals: exact })).toEqual(exact);
    expect(reconcileImportProposals({ ...probableInput, proposals: probable })).toEqual(probable);
  });

  it("does not use a different account's transaction as duplicate evidence", () => {
    const result = reconcileImportProposals(
      input({
        accounts: [account(), account({ id: "other-account" })],
        transactions: [transaction({ accountId: "other-account" })],
      }),
    )[0]!;

    expect(result).toMatchObject({ duplicateStatus: "new", disposition: "candidate", selected: true });
  });

  it("property: reconciliation is byte-identical when applied sequentially against the same ledger", () => {
    fc.assert(
      fc.property(fc.array(fc.record({ amount: fc.integer({ min: 1, max: 100_000 }), sameSource: fc.boolean() }), { maxLength: 8 }), (existing) => {
        const proposals = [proposal(), { ...proposal(), rowId: "r2", sourceRows: ["r2"], rawPlace: "other visible row" }];
        const transactions = existing.map((item, index) =>
          transaction({ id: `existing-${index}`, amount: item.amount, sourceRef: item.sameSource ? "visible row" : null }),
        );
        const reconciliationInput = input({ proposals, transactions });
        const once = reconcileImportProposals(reconciliationInput);
        expect(reconcileImportProposals({ ...reconciliationInput, proposals: once })).toEqual(once);
      }),
      { numRuns: 100 },
    );
  });
});
