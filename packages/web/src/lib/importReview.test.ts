import { describe, expect, it } from "bun:test";
import {
  type ClientLedger,
  createDefaultBudgetPreferences,
  IMPORT_REVIEW_REASONS,
  type ImportExtractRow,
  type ImportProposal,
  type ImportRecognitionResult,
} from "@enveo/shared";
import type { EditedImportItem, ImportApplyResponse } from "./api";
import { buildImportReviewRows, importReviewReasonMessage, reviewBadges, reviewedImportRowsForApply } from "./importReview";
import { recognitionCandidatesForDryRun } from "./localImport";

const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const ledger = (): ClientLedger => ({
  budgets: [{ id: U(1), name: "Budget", currency: "EUR", preferences: createDefaultBudgetPreferences() }],
  accounts: [
    {
      id: U(2),
      name: "Main",
      color: "#fff",
      icon: "bank",
      type: "checking",
      onBudget: true,
      initialBalance: 0,
      archived: false,
      sort: 0,
      automaticEnvelopeId: null,
    },
  ],
  groups: [],
  envelopes: [],
  categories: [],
  places: [],
  allocations: [],
  transactions: [],
});

const row = (rowId: string, over: Partial<ImportExtractRow> = {}): ImportExtractRow => ({
  rowId,
  imageIndex: 0,
  visualOrder: 0,
  rawTextLines: [`raw ${rowId}`, "25.00 EUR"],
  date: "2026-08-02",
  amount: 2500,
  currency: "EUR",
  direction: "debit",
  postingStatus: "posted",
  rowRole: "financial_event",
  semanticKind: "card_purchase",
  relation: null,
  confidence: "high",
  reviewReasons: [],
  ...over,
});

const proposal = (rowId: string, over: Partial<ImportProposal> = {}): ImportProposal => ({
  rowId,
  sourceRows: [rowId],
  disposition: "candidate",
  date: "2026-08-02",
  amount: 2500,
  currency: "EUR",
  type: "expense",
  isRefund: false,
  toAccountId: null,
  semanticKind: "card_purchase",
  relation: null,
  name: `name ${rowId}`,
  tag: "",
  rawPlace: "model text must not replace evidence",
  envelopeId: null,
  categoryId: null,
  placeName: null,
  reviewReasons: [],
  selected: true,
  ...over,
});

const recognition = (rows: ImportExtractRow[], proposals: ImportProposal[]): ImportRecognitionResult => ({ rows, proposals });

const dryResult = (over: Partial<ImportApplyResponse["results"][number]> = {}): ImportApplyResponse["results"][number] => ({
  date: "2026-08-02",
  amount: 2500,
  type: "expense",
  name: "candidate",
  tag: "",
  rawPlace: "raw candidate\n25.00 EUR",
  envelopeId: null,
  status: "added",
  ...over,
});

describe("screenshot import review view model", () => {
  it("keeps every extracted row visible while only safe complete candidates start selected", () => {
    // Break caught: filtering recognition down to transaction-shaped proposals would hide
    // pending, declined, supporting, or unresolved screenshot evidence from review.
    const rows = [
      row("reward", { direction: "credit", semanticKind: "cashback_or_reward" }),
      row("income", { direction: "credit", semanticKind: "salary" }),
      row("pending", { postingStatus: "pending" }),
      row("declined", { postingStatus: "declined" }),
      row("support", { rowRole: "supporting_detail" }),
      row("unresolved", { amount: null, confidence: "low" }),
      row("relation", { relation: { kind: "counterpart_of", rowId: "income" } }),
    ];
    const proposals = [
      proposal("reward", { type: "income", semanticKind: "cashback_or_reward" }),
      proposal("income", { type: "income", semanticKind: "salary" }),
      proposal("pending", { disposition: "pending", selected: false, reviewReasons: ["pending_or_declined"] }),
      proposal("declined", { disposition: "declined", selected: false, reviewReasons: ["pending_or_declined"] }),
      proposal("support", { disposition: "supporting", type: null, selected: false }),
      proposal("unresolved", { disposition: "unresolved", amount: null, type: null, selected: false, reviewReasons: ["missing_fact"] }),
      proposal("relation", {
        relation: { kind: "counterpart_of", rowId: "income" },
        selected: false,
        reviewReasons: ["relation_changes_ledger_shape"],
      }),
    ];
    const result = recognition(rows, proposals);

    const candidates = recognitionCandidatesForDryRun(result, ledger());
    const review = buildImportReviewRows({
      recognition: result,
      ledger: ledger(),
      dryRunResults: candidates.map(() => dryResult()),
      automaticEnvelopeId: null,
      budgetCurrency: "EUR",
    });

    expect(candidates.map((item) => item.rawPlace)).toEqual(["raw reward\n25.00 EUR", "raw income\n25.00 EUR"]);
    expect(review.map(({ rowId, disposition, include, editable }) => ({ rowId, disposition, include, editable }))).toEqual([
      { rowId: "reward", disposition: "candidate", include: true, editable: true },
      { rowId: "income", disposition: "candidate", include: true, editable: true },
      { rowId: "pending", disposition: "pending", include: false, editable: false },
      { rowId: "declined", disposition: "declined", include: false, editable: false },
      { rowId: "support", disposition: "supporting", include: false, editable: false },
      { rowId: "unresolved", disposition: "unresolved", include: false, editable: false },
      { rowId: "relation", disposition: "candidate", include: false, editable: true },
    ]);
    expect(review[6]!.sourceRef).toBe("raw relation\n25.00 EUR");
  });

  it("shows transfer, relation, duplicate, refund, reward, and review-warning badges", () => {
    // Break caught: a generic transaction row would conceal why a proposal needs review.
    const rows = [row("transfer"), row("fx"), row("refund"), row("reward"), row("duplicate")];
    const result = recognition(rows, [
      proposal("transfer", { reviewReasons: ["possible_transfer", "possible_ocr_error"] }),
      proposal("fx", { selected: false, relation: { kind: "fx_for", rowId: "transfer" }, reviewReasons: ["relation_changes_ledger_shape"] }),
      proposal("refund", { isRefund: true, semanticKind: "merchant_refund" }),
      proposal("reward", { type: "income", semanticKind: "cashback_or_reward" }),
      proposal("duplicate"),
    ]);
    const review = buildImportReviewRows({
      recognition: result,
      ledger: ledger(),
      dryRunResults: [dryResult(), dryResult(), dryResult({ type: "income" }), dryResult({ status: "probable" })],
      automaticEnvelopeId: null,
      budgetCurrency: "EUR",
    });

    expect(reviewBadges(review[0]!).map((badge) => badge.label)).toEqual(["Possible transfer", "Possible recognition error"]);
    expect(reviewBadges(review[1]!).map((badge) => badge.label)).toEqual(["FX relation", "Related rows could change the ledger"]);
    expect(reviewBadges(review[2]!).map((badge) => badge.label)).toContain("Refund");
    expect(reviewBadges(review[3]!).map((badge) => badge.label)).toContain("Reward / income");
    expect(reviewBadges(review[4]!).map((badge) => badge.label)).toContain("Probable duplicate");
    expect(review[4]!.include).toBe(false);
  });

  it("allows apply only for explicitly included complete candidate rows", () => {
    // Break caught: editing or toggling a non-candidate could turn uncertain evidence into a ledger write.
    const result = recognition(
      [row("candidate"), row("pending"), row("missing", { amount: null })],
      [
        proposal("candidate"),
        proposal("pending", { disposition: "pending", selected: false }),
        proposal("missing", { disposition: "unresolved", amount: null, type: null, selected: false, reviewReasons: ["missing_fact"] }),
      ],
    );
    const review = buildImportReviewRows({
      recognition: result,
      ledger: ledger(),
      dryRunResults: [dryResult()],
      automaticEnvelopeId: null,
      budgetCurrency: "EUR",
    });
    review[1]!.include = true;
    review[2]!.include = true;
    const edits: Record<number, EditedImportItem> = {
      1: {
        type: "expense",
        accountId: U(2),
        toAccountId: null,
        isRefund: false,
        amount: 100,
        date: "2026-08-02",
        name: "must be ignored",
        envelopeId: null,
        categoryId: null,
        placeName: null,
        note: "",
      },
    };

    const selected = reviewedImportRowsForApply({ rows: review, edited: edits, editedAutomaticDefaults: {} });

    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ name: "candidate", rawPlace: "raw candidate\n25.00 EUR" });
  });

  it("has concise copy for every shared reason and a safe fallback for a newer reason", () => {
    // Break caught: a newly added reason renders blank or crashes an older client.
    expect(IMPORT_REVIEW_REASONS.map(importReviewReasonMessage).every((message) => message.length > 0)).toBe(true);
    expect(importReviewReasonMessage("future_reason")).toBe("Needs review");
  });
});
