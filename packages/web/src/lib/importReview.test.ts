import { describe, expect, it } from "bun:test";
import {
  type ClientLedger,
  createDefaultBudgetPreferences,
  IMPORT_REVIEW_REASONS,
  type ImportExtractRow,
  type ReconciledImportProposal,
  type ReconciledImportRecognitionResult,
  reconcileImportProposals,
  validateImportExtraction,
} from "@enveo/shared";
import type { EditedImportItem, ImportApplyResponse } from "./api";
import {
  buildImportReviewRows,
  importReviewBlockingCount,
  importReviewDoneStats,
  importReviewReasonMessage,
  reviewBadges,
  reviewedImportRowsForApply,
  reviewRowControlLabels,
  visibleImportReviewRows,
} from "./importReview";
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

const proposal = (rowId: string, over: Partial<ReconciledImportProposal> = {}): ReconciledImportProposal => ({
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
  duplicateStatus: "new",
  sourceAccountInvalid: false,
  ...over,
});

const recognition = (rows: ImportExtractRow[], proposals: ReconciledImportProposal[]): ReconciledImportRecognitionResult => ({ rows, proposals });

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

const editedItem = (over: Partial<EditedImportItem> = {}): EditedImportItem => ({
  type: "expense",
  accountId: U(2),
  toAccountId: null,
  isRefund: false,
  amount: 2500,
  date: "2026-08-02",
  name: "confirmed candidate",
  envelopeId: null,
  categoryId: null,
  placeName: null,
  note: "",
  ...over,
});

describe("screenshot import review view model", () => {
  it("separates inclusion from review and blocks an incomplete selected financial row", () => {
    const result = recognition(
      [row("review", { reviewReasons: ["possible_ocr_error"] }), row("missing", { amount: null })],
      [
        proposal("review", { selected: true, reviewReasons: ["possible_ocr_error"] }),
        proposal("missing", { disposition: "unresolved", amount: null, type: null, selected: true, reviewReasons: ["missing_fact"] }),
      ],
    );
    const review = buildImportReviewRows({
      recognition: result,
      ledger: ledger(),
      dryRunResults: [dryResult()],
      automaticEnvelopeId: null,
      budgetCurrency: "EUR",
    });
    expect(review[0]).toMatchObject({ include: true, requiresReview: true, blockingIssues: [] });
    expect(review[1]).toMatchObject({ include: true, requiresReview: true, blockingIssues: ["missing_fact"] });
    expect(reviewRowControlLabels(review[1]!, 1).select).toEqual({ message: "Select recognized row {n}", values: { n: 2 } });
    expect(importReviewBlockingCount(review, {})).toBe(2);
    expect(importReviewBlockingCount(review, { 0: editedItem() })).toBe(1);
    review[1]!.include = false;
    expect(importReviewBlockingCount(review, { 0: editedItem() })).toBe(0);
  });

  it("keeps validator-mapped internal transfers checked while flagging the unknown endpoint", () => {
    const validated = validateImportExtraction({
      batch: { rows: [row("unknown-transfer", { direction: "credit", semanticKind: "internal_transfer" })] },
      budgetCurrency: "EUR",
    });

    const reconciled = recognition(
      validated.rows,
      reconcileImportProposals({
        proposals: validated.proposals,
        transactions: ledger().transactions,
        accounts: ledger().accounts,
        envelopes: ledger().envelopes,
        categories: ledger().categories,
        selectedAccountId: U(2),
      }),
    );
    const candidates = recognitionCandidatesForDryRun(reconciled, ledger());
    const review = buildImportReviewRows({
      recognition: reconciled,
      ledger: ledger(),
      dryRunResults: [],
      automaticEnvelopeId: null,
      budgetCurrency: "EUR",
    });

    expect(validated.proposals[0]).toMatchObject({
      disposition: "candidate",
      type: "income",
      selected: true,
      reviewReasons: ["unknown_transfer_endpoint"],
    });
    expect(candidates).toHaveLength(1);
    expect(review[0]).toMatchObject({ include: true, requiresReview: true, blockingIssues: [], editable: true });
  });

  it("shows a selected financial FX row as blocking and lets the user uncheck it", () => {
    const validated = validateImportExtraction({
      batch: { rows: [row("financial-fx", { semanticKind: "fx_conversion", rowRole: "financial_event" })] },
      budgetCurrency: "EUR",
    });
    const review = buildImportReviewRows({
      recognition: recognition(
        validated.rows,
        reconcileImportProposals({
          proposals: validated.proposals,
          transactions: [],
          accounts: ledger().accounts,
          envelopes: [],
          categories: [],
          selectedAccountId: U(2),
        }),
      ),
      ledger: ledger(),
      dryRunResults: [],
      automaticEnvelopeId: null,
      budgetCurrency: "EUR",
    });

    expect(review[0]).toMatchObject({ include: true, item: null, blockingIssues: ["unknown_kind"] });
    expect(reviewRowControlLabels(review[0]!, 0).select).not.toBeNull();
    expect(importReviewBlockingCount(review, {})).toBe(1);
  });

  it("keeps every extracted row visible while all new financial events start selected", () => {
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
      proposal("unresolved", { disposition: "unresolved", amount: null, type: null, selected: true, reviewReasons: ["missing_fact"] }),
      proposal("relation", {
        relation: { kind: "counterpart_of", rowId: "income" },
        selected: true,
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

    expect(candidates.map((item) => item.rawPlace)).toEqual(["raw reward\n25.00 EUR", "raw income\n25.00 EUR", "raw relation\n25.00 EUR"]);
    expect(review.map(({ rowId, disposition, include, editable }) => ({ rowId, disposition, include, editable }))).toEqual([
      { rowId: "reward", disposition: "candidate", include: true, editable: true },
      { rowId: "income", disposition: "candidate", include: true, editable: true },
      { rowId: "pending", disposition: "pending", include: false, editable: false },
      { rowId: "declined", disposition: "declined", include: false, editable: false },
      { rowId: "support", disposition: "supporting", include: false, editable: false },
      { rowId: "unresolved", disposition: "unresolved", include: true, editable: false },
      { rowId: "relation", disposition: "candidate", include: true, editable: true },
    ]);
    expect(review[6]!.sourceRef).toBe("raw relation\n25.00 EUR");
    expect(reviewRowControlLabels(review[0]!, 0)).toEqual({
      select: { message: "Select recognized row {n}", values: { n: 1 } },
      edit: { message: "Edit item {n}", values: { n: 1 } },
    });
    expect(reviewRowControlLabels(review[2]!, 2)).toEqual({ select: null, edit: null });
  });

  it("hides supporting evidence from review while preserving original row indexes", () => {
    // given: recognition contains helper text between two rows the user can act on
    const rows = [
      { rowId: "first", disposition: "candidate" },
      { rowId: "heading", disposition: "supporting" },
      { rowId: "second", disposition: "unresolved" },
    ] as Pick<ReturnType<typeof buildImportReviewRows>[number], "rowId" | "disposition">[];

    // when: the review list prepares its visible entries
    const visible = visibleImportReviewRows(rows);

    // then: helper evidence disappears, while edit/include state still addresses source rows
    expect(visible).toEqual([
      { row: rows[0]!, index: 0, position: 0 },
      { row: rows[2]!, index: 2, position: 1 },
    ]);
  });

  it("defaults every non-exact candidate to included even when an old proposal selection was false", () => {
    // given: a durable Stage-A candidate carries a creation-time selection that is no longer authoritative
    const result = recognition([row("new")], [proposal("new", { selected: false, duplicateStatus: "new" })]);

    // when: the current-ledger review is opened
    const review = buildImportReviewRows({
      recognition: result,
      ledger: ledger(),
      dryRunResults: [],
      automaticEnvelopeId: null,
      budgetCurrency: "EUR",
    });

    // then: inclusion is a fresh user decision and the complete row starts checked
    expect(review[0]).toMatchObject({ duplicateStatus: "new", include: true, editable: true });
  });

  it("requires action for an unavailable saved assignment and accepts edit confirmation or uncheck", () => {
    // given: the current ledger cleared an assignment that existed when recognition finished
    const result = recognition(
      [row("assignment")],
      [
        {
          ...proposal("assignment"),
          assignmentUnavailable: true,
        } as ReconciledImportProposal,
      ],
    );
    const review = buildImportReviewRows({
      recognition: result,
      ledger: ledger(),
      dryRunResults: [dryResult()],
      automaticEnvelopeId: null,
      budgetCurrency: "EUR",
    });

    // then: selection is independent of correctness, and one explicit action clears the gate
    expect(review[0]).toMatchObject({ include: true, requiresReview: true, blockingIssues: ["assignment_unavailable"] });
    expect(reviewBadges(review[0]!).map(({ label }) => label)).toContain("Saved assignment is unavailable");
    expect(importReviewBlockingCount(review, {})).toBe(1);
    expect(importReviewBlockingCount(review, { 0: editedItem() })).toBe(0);
    review[0]!.include = false;
    expect(importReviewBlockingCount(review, {})).toBe(0);
  });

  it("keeps a reconciled exact duplicate truthful while leaving it unselectable and noneditable", () => {
    // Break caught: exact duplicates are reconciled to disposition=declined, but dropping
    // duplicateStatus made the UI describe them as bank-declined rows and hid the skip verdict.
    const current = ledger();
    current.transactions.push({
      id: U(9),
      type: "expense",
      accountId: U(2),
      toAccountId: null,
      amount: 2500,
      date: "2026-08-02",
      isRefund: false,
      envelopeId: null,
      placeId: null,
      categoryId: null,
      name: "Existing",
      note: null,
      tag: null,
      sourceRef: "raw exact\n25.00 EUR",
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: null,
      items: [],
      createdAt: "2026-08-02T00:00:00.000Z",
    });
    const validated = validateImportExtraction({ batch: { rows: [row("exact")] }, budgetCurrency: "EUR" });
    const proposals = reconcileImportProposals({
      proposals: validated.proposals,
      transactions: current.transactions,
      accounts: current.accounts,
      envelopes: current.envelopes,
      categories: current.categories,
      selectedAccountId: U(2),
    });
    const review = buildImportReviewRows({
      recognition: { rows: validated.rows, proposals },
      ledger: current,
      dryRunResults: [],
      automaticEnvelopeId: null,
      budgetCurrency: "EUR",
    });

    expect(proposals[0]).toMatchObject({ duplicateStatus: "exists", disposition: "declined", selected: false });
    expect(review[0]).toMatchObject({ duplicateStatus: "exists", include: false, editable: false, item: null });
    expect(reviewBadges(review[0]!).map((badge) => badge.label)).toEqual(["Already exists", "Conflicts with transaction history"]);
    expect(reviewRowControlLabels(review[0]!, 0)).toEqual({ select: null, edit: null });
    expect(importReviewDoneStats(review, { added: 0, skipped: 0 })).toEqual({ added: 0, dup: 1 });
    expect(importReviewDoneStats(review, { added: 0, skipped: 1 })).toEqual({ added: 0, dup: 2 });
  });

  it("treats a durably applied row as already added even without duplicate evidence", () => {
    // given: the first row crossed the local mutation boundary before a reload, but the
    // screenshot carried no raw text and therefore produced no source_ref ledger evidence
    const review = buildImportReviewRows({
      recognition: recognition([row("blank", { rawTextLines: [] })], [proposal("blank")]),
      ledger: ledger(),
      dryRunResults: [dryResult({ rawPlace: null, status: "added" })],
      automaticEnvelopeId: null,
      budgetCurrency: "EUR",
      appliedRowIds: ["blank"],
    });

    // when/then: the durable row identity, rather than source text, makes it non-actionable
    expect(review[0]).toMatchObject({ rowId: "blank", alreadyApplied: true, duplicateStatus: "exists", include: false, editable: false, item: null });
    expect(reviewBadges(review[0]!).map((badge) => badge.label)).toContain("Already added by this import");
    expect(reviewRowControlLabels(review[0]!, 0)).toEqual({ select: null, edit: null });
  });

  it("restores an explicitly skipped row as unchecked while keeping it actionable", () => {
    // given: the user unchecked a candidate before a reload
    const review = buildImportReviewRows({
      recognition: recognition([row("skipped")], [proposal("skipped")]),
      ledger: ledger(),
      dryRunResults: [dryResult()],
      automaticEnvelopeId: null,
      budgetCurrency: "EUR",
      skippedRowIds: ["skipped"],
    });

    // then: reconciliation preserves that decision but still permits changing it
    expect(review[0]).toMatchObject({ rowId: "skipped", alreadyApplied: false, duplicateStatus: "new", include: false, editable: true });
    expect(reviewRowControlLabels(review[0]!, 0)).toEqual({
      select: { message: "Select recognized row {n}", values: { n: 1 } },
      edit: { message: "Edit item {n}", values: { n: 1 } },
    });
  });

  it("promotes a recognition-time new candidate to an exact duplicate from the immediate dry run", () => {
    // Break caught: the item consumed the late dry-run verdict, but the row kept the
    // stale recognition status and therefore stayed editable without an explanation.
    const review = buildImportReviewRows({
      recognition: recognition([row("late-exact")], [proposal("late-exact", { duplicateStatus: "new" })]),
      ledger: ledger(),
      dryRunResults: [dryResult({ status: "exists" })],
      automaticEnvelopeId: null,
      budgetCurrency: "EUR",
    });

    expect(review[0]).toMatchObject({ duplicateStatus: "exists", include: false, editable: false, item: null });
    expect(reviewBadges(review[0]!).map((badge) => badge.label)).toContain("Already exists");
    expect(reviewRowControlLabels(review[0]!, 0)).toEqual({ select: null, edit: null });
    expect(importReviewDoneStats(review, { added: 0, skipped: 0 })).toEqual({ added: 0, dup: 1 });
  });

  it("promotes a recognition-time new candidate to a probable duplicate from the immediate dry run", () => {
    // Break caught: a late probable verdict unchecked the nested item but never reached
    // the row badge or accessibility state that explains why it needs review.
    const review = buildImportReviewRows({
      recognition: recognition([row("late-probable")], [proposal("late-probable", { duplicateStatus: "new" })]),
      ledger: ledger(),
      dryRunResults: [dryResult({ status: "probable" })],
      automaticEnvelopeId: null,
      budgetCurrency: "EUR",
    });

    expect(review[0]).toMatchObject({ duplicateStatus: "probable", include: true, requiresReview: true, editable: true });
    expect(review[0]!.item).toMatchObject({ status: "probable", include: true });
    expect(reviewBadges(review[0]!).map((badge) => badge.label)).toContain("Probable duplicate");
    expect(reviewRowControlLabels(review[0]!, 0)).toEqual({
      select: { message: "Select recognized row {n}", values: { n: 1 } },
      edit: { message: "Edit item {n}", values: { n: 1 } },
    });
  });

  it("shows transfer, relation, duplicate, refund, reward, and review-warning badges", () => {
    // Break caught: a generic transaction row would conceal why a proposal needs review.
    const rows = [row("transfer"), row("fx"), row("refund"), row("reward"), row("duplicate")];
    const result = recognition(rows, [
      proposal("transfer", { reviewReasons: ["possible_transfer", "possible_ocr_error"] }),
      proposal("fx", { selected: true, relation: { kind: "fx_for", rowId: "transfer" }, reviewReasons: ["relation_changes_ledger_shape"] }),
      proposal("refund", { isRefund: true, semanticKind: "merchant_refund" }),
      proposal("reward", { type: "income", semanticKind: "cashback_or_reward" }),
      proposal("duplicate", { duplicateStatus: "probable", selected: true }),
    ]);
    const review = buildImportReviewRows({
      recognition: result,
      ledger: ledger(),
      dryRunResults: [dryResult(), dryResult(), dryResult(), dryResult({ type: "income" }), dryResult({ status: "probable" })],
      automaticEnvelopeId: null,
      budgetCurrency: "EUR",
    });

    expect(reviewBadges(review[0]!).map((badge) => badge.label)).toEqual(["Possible transfer", "Possible recognition error"]);
    expect(reviewBadges(review[1]!).map((badge) => badge.label)).toEqual(["FX relation", "Related rows could change the ledger"]);
    expect(reviewBadges(review[2]!).map((badge) => badge.label)).toContain("Refund");
    expect(reviewBadges(review[3]!).map((badge) => badge.label)).toContain("Reward / income");
    expect(reviewBadges(review[4]!).map((badge) => badge.label)).toContain("Probable duplicate");
    expect(review[4]!.include).toBe(true);
  });

  it("presents history ambiguity separately and never invents duplicate evidence from it", () => {
    const result = recognition([row("ambiguous")], [proposal("ambiguous", { selected: true, reviewReasons: ["multiple_history_candidates"] })]);

    const review = buildImportReviewRows({
      recognition: result,
      ledger: ledger(),
      dryRunResults: [dryResult()],
      automaticEnvelopeId: null,
      budgetCurrency: "EUR",
    });

    expect(review[0]).toMatchObject({ duplicateStatus: "new", include: true, requiresReview: true });
    expect(reviewBadges(review[0]!).map((badge) => badge.label)).toContain("Several history matches");
    expect(reviewBadges(review[0]!).map((badge) => badge.label)).not.toContain("Probable duplicate");
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

  it("fails closed if a selected blocking row reaches the final apply boundary", () => {
    const review = buildImportReviewRows({
      recognition: recognition([row("currency", { currency: "USD" })], [proposal("currency", { currency: "USD" })]),
      ledger: ledger(),
      dryRunResults: [dryResult({ currency: "USD" })],
      automaticEnvelopeId: null,
      budgetCurrency: "EUR",
    });

    expect(review[0]).toMatchObject({ include: true, blockingIssues: ["currency_mismatch"] });
    expect(() => reviewedImportRowsForApply({ rows: review, edited: {}, editedAutomaticDefaults: {} })).toThrow("import_review_blocked");
  });

  it("requires an explicit edit before applying a selected row marked for review", () => {
    // Break caught: a checked warning row could be applied without the user ever
    // opening and confirming its transaction details.
    const review = buildImportReviewRows({
      recognition: recognition([row("warning", { reviewReasons: ["possible_ocr_error"] })], [proposal("warning", { reviewReasons: ["possible_ocr_error"] })]),
      ledger: ledger(),
      dryRunResults: [dryResult()],
      automaticEnvelopeId: null,
      budgetCurrency: "EUR",
    });
    const edit = editedItem({ name: "confirmed warning" });

    expect(importReviewBlockingCount(review, {})).toBe(1);
    expect(() => reviewedImportRowsForApply({ rows: review, edited: {}, editedAutomaticDefaults: {} })).toThrow("import_review_blocked");

    expect(importReviewBlockingCount(review, { 0: edit })).toBe(0);
    expect(reviewedImportRowsForApply({ rows: review, edited: { 0: edit }, editedAutomaticDefaults: {} })).toHaveLength(1);

    review[0]!.include = false;
    expect(importReviewBlockingCount(review, {})).toBe(0);
    expect(reviewedImportRowsForApply({ rows: review, edited: {}, editedAutomaticDefaults: {} })).toEqual([]);
  });

  it("has concise copy for every shared reason and a safe fallback for a newer reason", () => {
    // Break caught: a newly added reason renders blank or crashes an older client.
    expect(IMPORT_REVIEW_REASONS.map(importReviewReasonMessage).every((message) => message.length > 0)).toBe(true);
    expect(importReviewReasonMessage("future_reason")).toBe("Needs review");
  });
});
