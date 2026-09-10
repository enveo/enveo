import { describe, expect, it } from "bun:test";
import {
  type ClientLedger,
  createDefaultBudgetPreferences,
  IMPORT_REVIEW_REASONS,
  type ImportExtractRow,
  type ReconciledImportProposal,
  type ReconciledImportRecognitionResult,
  reconcileImportProposals,
  type Transaction,
  validateImportExtraction,
} from "@enveo/shared";
import type { EditedImportItem, ImportApplyItem, ImportApplyResponse } from "./api";
import {
  applyBalanceMatchToReview,
  balanceMatchCandidatesForReview,
  bankBalanceHint,
  buildImportReviewRows,
  type ImportReviewRow,
  importBalanceDiagnosis,
  importBalanceEffect,
  importPeriodStart,
  importReviewDoneStats,
  importReviewReasonMessage,
  reviewBadges,
  reviewedImportRowsForApply,
  reviewRowControlLabels,
  reviewSelectionAfterRefresh,
  visibleImportReviewRows,
} from "./importReview";
import { type LocalImportReviewItem, recognitionCandidatesForDryRun } from "./localImport";

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
  it("keeps incomplete rows editable and unchecked, and applies a completed edit after rebuilding review", () => {
    // given: a synthetic cropped entry with no date or transaction type
    const result = recognition(
      [row("cropped", { date: null })],
      [proposal("cropped", { date: null, type: null, disposition: "unresolved", selected: true, reviewReasons: ["missing_fact", "unknown_kind"] })],
    );
    const build = () => buildImportReviewRows({ recognition: result, ledger: ledger(), dryRunResults: [], automaticEnvelopeId: null, budgetCurrency: "EUR" });
    const review = build();
    expect(review[0]).toMatchObject({ include: false, editable: true, item: null });
    expect(reviewRowControlLabels(review[0]!, 0).edit).not.toBeNull();
    expect(reviewBadges(review[0]!, editedItem())).toEqual([]);
    // when: the human completes the row and apply re-reads the original result
    review[0]!.include = true;
    const refreshed = build();
    refreshed[0]!.include = reviewSelectionAfterRefresh(refreshed[0]!, review[0]);
    const chosen = reviewedImportRowsForApply({ rows: refreshed, edited: { 0: editedItem() }, editedAutomaticDefaults: {} });
    // then: the edit is included once, with original evidence and a matching balance preview
    expect(chosen).toHaveLength(1);
    refreshed[0]!.include = false;
    expect(balanceMatchCandidatesForReview({ rows: refreshed, edited: { 0: editedItem() }, defaultAccountId: U(2) })).toMatchObject([
      { id: "cropped", effect: -2500 },
    ]);
    expect(chosen[0]).toMatchObject({ importRowId: "cropped", date: "2026-08-02", amount: 2500, rawPlace: "raw cropped\n25.00 EUR" });
    expect(importBalanceEffect({ items: chosen, defaultAccountId: U(2), accounts: [{ id: U(2), name: "Main", balance: 5000 }] })[0]?.after).toBe(2500);
  });

  it("requires correcting an impossible calendar date before an incomplete row can be added", () => {
    const rows = buildImportReviewRows({
      recognition: recognition(
        [row("invalid-date", { date: "2026-02-31" })],
        [proposal("invalid-date", { date: "2026-02-31", disposition: "unresolved", selected: false, reviewReasons: ["missing_fact"] })],
      ),
      ledger: ledger(),
      dryRunResults: [],
      automaticEnvelopeId: null,
      budgetCurrency: "EUR",
    });
    expect(rows[0]?.draftItem?.date).toBeNull();
    rows[0]!.include = true;
    expect(() => reviewedImportRowsForApply({ rows, edited: { 0: editedItem({ date: "2026-02-31" }) }, editedAutomaticDefaults: {} })).toThrow(
      "import_review_incomplete",
    );
    expect(reviewedImportRowsForApply({ rows, edited: { 0: editedItem({ date: "2026-02-28" }) }, editedAutomaticDefaults: {} })[0]?.date).toBe("2026-02-28");
  });

  it("rejects malformed edited money and transaction types at the apply boundary", () => {
    const rows = buildImportReviewRows({
      recognition: recognition([row("entry")], [proposal("entry")]),
      ledger: ledger(),
      dryRunResults: [dryResult()],
      automaticEnvelopeId: null,
      budgetCurrency: "EUR",
    });
    for (const patch of [{ amount: 0 }, { amount: -1 }, { amount: 1.5 }, { amount: Number.MAX_SAFE_INTEGER + 1 }, { type: "unknown" }]) {
      expect(() => reviewedImportRowsForApply({ rows, edited: { 0: editedItem(patch as Partial<EditedImportItem>) }, editedAutomaticDefaults: {} })).toThrow(
        "import_review_incomplete",
      );
    }
  });

  it("refuses a selected incomplete row instead of silently omitting it", () => {
    const rows = buildImportReviewRows({
      recognition: recognition([row("missing")], [proposal("missing", { disposition: "unresolved", type: null })]),
      ledger: ledger(),
      dryRunResults: [],
      automaticEnvelopeId: null,
      budgetCurrency: "EUR",
    });
    rows[0]!.include = true;
    expect(() => reviewedImportRowsForApply({ rows, edited: {}, editedAutomaticDefaults: {} })).toThrow("import_review_incomplete");
  });

  it("lets the user apply a complete warned transaction without opening the editor", () => {
    // The warning is guidance. The user's checked selection remains authoritative.
    const review = buildImportReviewRows({
      recognition: recognition(
        [row("warning", { reviewReasons: ["possible_ocr_error"] })],
        [proposal("warning", { selected: true, reviewReasons: ["possible_ocr_error"] })],
      ),
      ledger: ledger(),
      dryRunResults: [dryResult()],
      automaticEnvelopeId: null,
      budgetCurrency: "EUR",
    });

    expect(review[0]).toMatchObject({ include: true, requiresReview: true });
    expect(reviewedImportRowsForApply({ rows: review, edited: {}, editedAutomaticDefaults: {} })).toHaveLength(1);
  });

  it("separates inclusion from guidance and leaves incomplete financial rows unchecked", () => {
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
    expect(review[1]).toMatchObject({ include: false, requiresReview: true, blockingIssues: ["missing_fact"] });
    expect(reviewRowControlLabels(review[1]!, 1).select).toEqual({ message: "Select recognized row {n}", values: { n: 2 } });
    expect(reviewedImportRowsForApply({ rows: review, edited: {}, editedAutomaticDefaults: {} })).toHaveLength(1);
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

  it("shows a financial exchange entry as an ordinary expense with the FX badge", () => {
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

    expect(review[0]).toMatchObject({ include: true, blockingIssues: [] });
    expect(review[0]!.item).toMatchObject({ type: "expense", amount: 2500 });
    expect(reviewRowControlLabels(review[0]!, 0).select).not.toBeNull();
    expect(reviewedImportRowsForApply({ rows: review, edited: {}, editedAutomaticDefaults: {} })).toHaveLength(1);
  });

  it("keeps every extracted row visible while complete new financial events start selected", () => {
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
      { rowId: "unresolved", disposition: "unresolved", include: false, editable: true },
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

  it("leaves an explicitly unselected complete proposal unchecked", () => {
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

    // then: recognition requires an explicit choice even though all facts are complete
    expect(review[0]).toMatchObject({ duplicateStatus: "new", include: false, editable: true });
  });

  it("warns about an unavailable saved assignment without requiring edit confirmation", () => {
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

    // then: selection stays authoritative while the warning remains visible
    expect(review[0]).toMatchObject({ include: true, requiresReview: true, blockingIssues: ["assignment_unavailable"] });
    expect(reviewBadges(review[0]!).map(({ label }) => label)).toContain("Saved assignment is unavailable");
    expect(reviewedImportRowsForApply({ rows: review, edited: {}, editedAutomaticDefaults: {} })).toHaveLength(1);
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
    expect(reviewBadges(review[0]!).map((badge) => badge.label)).toEqual(["Already exists"]);
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

    expect(review[0]).toMatchObject({ duplicateStatus: "probable", include: false, requiresReview: true, editable: true });
    expect(review[0]!.item).toMatchObject({ status: "probable", include: false });
    expect(reviewBadges(review[0]!).map((badge) => badge.label)).toContain("Probable duplicate");
    expect(reviewRowControlLabels(review[0]!, 0)).toEqual({
      select: { message: "Select recognized row {n}", values: { n: 1 } },
      edit: { message: "Edit item {n}", values: { n: 1 } },
    });
    expect(reviewedImportRowsForApply({ rows: review, edited: {}, editedAutomaticDefaults: {} })).toEqual([]);
    // A new history hit must not inherit the automatic check from when this row was new.
    const previouslyNew = { ...review[0]!, duplicateStatus: "new" as const, include: true };
    expect(reviewSelectionAfterRefresh(review[0]!, previouslyNew)).toBe(false);
    // An explicit choice made with the probable warning visible does survive re-checking.
    expect(reviewSelectionAfterRefresh(review[0]!, { ...review[0]!, include: true })).toBe(true);
    expect(reviewSelectionAfterRefresh(review[0]!, { ...review[0]!, include: false })).toBe(false);
    review[0]!.include = true;
    expect(reviewedImportRowsForApply({ rows: review, edited: {}, editedAutomaticDefaults: {} })).toHaveLength(1);
  });

  it("leaves a cropped probable duplicate unchecked even when its saved proposal was selected", () => {
    // given: only the amount was visible; the old job kept this unresolved row selected
    const review = buildImportReviewRows({
      recognition: recognition(
        [row("cropped", { amount: 6100, rawTextLines: ["61.00 EUR"], semanticKind: "unknown" })],
        [
          proposal("cropped", {
            amount: 6100,
            disposition: "unresolved",
            type: null,
            selected: true,
            duplicateStatus: "probable",
            reviewReasons: ["unknown_kind"],
          }),
        ],
      ),
      ledger: ledger(),
      dryRunResults: [],
      automaticEnvelopeId: null,
      budgetCurrency: "EUR",
    });

    // then: uncertainty stays visible without preselecting the row or inventing multiple matches
    expect(review[0]).toMatchObject({ duplicateStatus: "probable", include: false, item: null, sourceRef: "61.00 EUR" });
    expect(reviewBadges(review[0]!).map((badge) => badge.label)).toEqual(["Unresolved — needs review", "Probable duplicate", "Unknown transaction type"]);
    expect(reviewRowControlLabels(review[0]!, 0).select).not.toBeNull();
    expect(reviewedImportRowsForApply({ rows: review, edited: {}, editedAutomaticDefaults: {} })).toEqual([]);
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
    expect(review[4]!.include).toBe(false);
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

  it("keeps a currency warning advisory at the final apply boundary", () => {
    const review = buildImportReviewRows({
      recognition: recognition([row("currency", { currency: "USD" })], [proposal("currency", { currency: "USD" })]),
      ledger: ledger(),
      dryRunResults: [dryResult({ currency: "USD" })],
      automaticEnvelopeId: null,
      budgetCurrency: "EUR",
    });

    expect(review[0]).toMatchObject({ include: true, blockingIssues: ["currency_mismatch"] });
    expect(reviewedImportRowsForApply({ rows: review, edited: {}, editedAutomaticDefaults: {} })).toHaveLength(1);
  });

  it("keeps edit and uncheck optional for a selected row marked for review", () => {
    const review = buildImportReviewRows({
      recognition: recognition([row("warning", { reviewReasons: ["possible_ocr_error"] })], [proposal("warning", { reviewReasons: ["possible_ocr_error"] })]),
      ledger: ledger(),
      dryRunResults: [dryResult()],
      automaticEnvelopeId: null,
      budgetCurrency: "EUR",
    });
    const edit = editedItem({ name: "confirmed warning" });

    expect(reviewedImportRowsForApply({ rows: review, edited: {}, editedAutomaticDefaults: {} })).toHaveLength(1);
    expect(reviewedImportRowsForApply({ rows: review, edited: { 0: edit }, editedAutomaticDefaults: {} })).toHaveLength(1);

    review[0]!.include = false;
    expect(reviewedImportRowsForApply({ rows: review, edited: {}, editedAutomaticDefaults: {} })).toEqual([]);
  });

  it("has concise copy for every shared reason and a safe fallback for a newer reason", () => {
    // Break caught: a newly added reason renders blank or crashes an older client.
    expect(IMPORT_REVIEW_REASONS.map(importReviewReasonMessage).every((message) => message.length > 0)).toBe(true);
    expect(importReviewReasonMessage("future_reason")).toBe("Needs review");
  });
});

describe("balance after import", () => {
  const accounts = [
    { id: "acc-main", name: "Main", balance: 100_000 },
    { id: "acc-savings", name: "Savings", balance: 500_000 },
    { id: "acc-idle", name: "Idle", balance: 1 },
  ];
  const item = (over: Partial<ImportApplyItem>): ImportApplyItem => ({
    date: "2026-08-02",
    amount: 2_500,
    type: "expense",
    name: "x",
    tag: "",
    envelopeId: null,
    ...over,
  });

  it("nets expenses, refunds, income and both legs of a transfer per touched account, source first", () => {
    // given: selected rows on the import account plus an edited row moved to savings
    const effect = importBalanceEffect({
      items: [
        item({ amount: 2_500 }),
        item({ amount: 1_000, isRefund: true }),
        item({ amount: 10_000, type: "income" }),
        item({ amount: 20_000, type: "transfer", toAccountId: "acc-savings" }),
        item({ amount: 300, accountId: "acc-savings" }),
      ],
      defaultAccountId: "acc-main",
      accounts: [accounts[1]!, accounts[0]!, accounts[2]!],
    });

    // then: main = −2500 +1000 +10000 −20000, savings = +20000 −300; the untouched account is absent
    expect(effect).toEqual([
      { accountId: "acc-main", name: "Main", before: 100_000, after: 88_500, delta: -11_500 },
      { accountId: "acc-savings", name: "Savings", before: 500_000, after: 519_700, delta: 19_700 },
    ]);
  });

  it("lists nothing when the selection cancels out or is empty", () => {
    expect(importBalanceEffect({ items: [], defaultAccountId: "acc-main", accounts })).toEqual([]);
    expect(importBalanceEffect({ items: [item({ amount: 500 }), item({ amount: 500, isRefund: true })], defaultAccountId: "acc-main", accounts })).toEqual([]);
  });
});

describe("matching the selection to the bank balance", () => {
  const reviewRow = (rowId: string, over: Omit<Partial<ImportReviewRow>, "item"> & { item?: Partial<LocalImportReviewItem> | null }): ImportReviewRow => {
    const { item, ...rest } = over;
    return {
      rowId,
      disposition: "candidate",
      semanticKind: "card_purchase",
      relation: null,
      reviewReasons: [],
      requiresReview: false,
      blockingIssues: [],
      duplicateStatus: "new",
      alreadyApplied: false,
      sourceRef: rowId,
      rawTextLines: [rowId],
      date: "2026-08-02",
      amount: 2_500,
      currency: "EUR",
      include: true,
      editable: true,
      item:
        item === null
          ? null
          : {
              date: "2026-08-02",
              amount: 2_500,
              type: "expense",
              name: rowId,
              tag: "",
              envelopeId: null,
              status: "added",
              include: true,
              automaticEnvelopeDefault: false,
              ...item,
            },
      ...rest,
    };
  };

  it("offers only doubtful or left-out rows, with the source-account effect and a flip where the direction was uncertain", () => {
    const rows = [
      reviewRow("sure", {}),
      reviewRow("pending", { requiresReview: true, reviewReasons: ["pending_or_declined"] }),
      reviewRow("left-out", { include: false, item: { amount: 999, type: "income" } }),
      reviewRow("unsure-direction", { requiresReview: true, reviewReasons: ["inconsistent_direction"], item: { type: "income", amount: 700 } }),
      reviewRow("exists", { duplicateStatus: "exists", include: false }),
      reviewRow("no-item", { include: false, item: null }),
      reviewRow("transfer-in", { include: false, item: { type: "transfer", amount: 300, toAccountId: "acc-main" } }),
    ];

    const candidates = balanceMatchCandidatesForReview({
      rows,
      edited: { 6: { ...editedFor(rows[6]!), accountId: "acc-other" } },
      defaultAccountId: "acc-main",
    });

    expect(candidates.map(({ id, effect, included, flippable, doubtful }) => ({ id, effect, included, flippable, doubtful }))).toEqual([
      { id: "pending", effect: -2_500, included: true, flippable: false, doubtful: true },
      { id: "unsure-direction", effect: 700, included: true, flippable: true, doubtful: true },
      { id: "left-out", effect: 999, included: false, flippable: false, doubtful: false },
      { id: "transfer-in", effect: 300, included: false, flippable: false, doubtful: false },
    ]);
  });

  it("applies a change set: selection flips stay selections, a direction flip becomes an edit", () => {
    const rows = [
      reviewRow("pending", { requiresReview: true }),
      reviewRow("left-out", { include: false }),
      reviewRow("flip", { item: { type: "income", amount: 700 } }),
    ];

    const applied = applyBalanceMatchToReview({
      rows,
      edited: {},
      defaultAccountId: "acc-main",
      changes: [
        { id: "pending", action: "exclude", delta: 2_500 },
        { id: "left-out", action: "include", delta: -2_500 },
        { id: "flip", action: "flip", delta: -1_400 },
      ],
    });

    expect(applied.rows.map((row) => row.include)).toEqual([false, true, true]);
    expect(applied.edited[2]).toMatchObject({ type: "expense", amount: 700, accountId: "acc-main", isRefund: false, date: "2026-08-02" });
    expect(rows[0]!.include).toBe(true); // input untouched
  });

  it("reads the bank balance out of a balance line the model kept as interface chrome", () => {
    expect(
      bankBalanceHint([
        { rowRole: "financial_event", rawTextLines: ["Saldo shop 12,00"] },
        { rowRole: "ui_metadata", rawTextLines: ["Historia · Konto osobiste", "Saldo 4 812,37 zł"] },
      ]),
    ).toBe(481_237);
    expect(bankBalanceHint([{ rowRole: "ui_metadata", rawTextLines: ["Available balance: -1,234.50 EUR"] }])).toBe(-123_450);
    // a statement header: labels on one line, the figures under them on the next; closing wins over opening
    expect(
      bankBalanceHint([
        { rowRole: "ui_metadata", rawTextLines: ["[account]  TOTAL INCOME  OPENING BALANCE", "PLN 4 321.00  PLN 1 234.56"] },
        { rowRole: "ui_metadata", rawTextLines: ["Global IBAN: [account]  TOTAL OUTCOME  CLOSING BALANCE", "PLN -3 210.99  PLN 2 344.57"] },
      ]),
    ).toBe(234_457);
    expect(bankBalanceHint([{ rowRole: "ui_metadata", rawTextLines: ["28.08.2026"] }])).toBeNull();
  });
});

function editedFor(row: ImportReviewRow): EditedImportItem {
  return {
    type: row.item!.type,
    accountId: "acc-main",
    toAccountId: row.item!.toAccountId ?? null,
    isRefund: false,
    amount: row.item!.amount,
    date: row.item!.date,
    name: row.item!.name,
    envelopeId: null,
    categoryId: null,
    placeName: null,
    note: "",
  };
}

describe("why nothing matches", () => {
  const txn = (over: Partial<Transaction>): Transaction => ({
    id: over.id ?? "t",
    type: "expense",
    accountId: "zen",
    toAccountId: null,
    amount: 1000,
    date: "2026-08-20",
    isRefund: false,
    envelopeId: null,
    placeId: null,
    categoryId: null,
    name: null,
    note: null,
    tag: null,
    sourceRef: null,
    allocationFromEnvelopeId: null,
    allocationToEnvelopeId: null,
    items: [],
    createdAt: "2026-08-20T00:00:00.000Z",
    ...over,
  });

  it("reports the doubtful rows' reach and the hand-entered rows of the period, newest first", () => {
    const diagnosis = importBalanceDiagnosis({
      candidates: [
        { id: "a", effect: -500, included: true, flippable: false },
        { id: "b", effect: 700, included: false, flippable: true },
      ],
      transactions: [
        txn({ id: "imported", sourceRef: "LIDL", date: "2026-08-25" }),
        txn({ id: "before", date: "2026-08-10", amount: 999 }),
        txn({ id: "in", type: "transfer", accountId: "platinum", toAccountId: "zen", amount: 200000, date: "2026-08-25", name: null }),
        txn({ id: "out", type: "transfer", accountId: "zen", toAccountId: "platinum", amount: 5000, date: "2026-08-22" }),
        txn({ id: "refund", isRefund: true, amount: 2309, date: "2026-08-14", note: "Balance adjustment" }),
        txn({ id: "elsewhere", accountId: "platinum", date: "2026-08-24" }),
      ],
      accountId: "zen",
      since: "2026-08-14",
    });

    expect(diagnosis.reach).toBe(500 + 700);
    expect(diagnosis.manualEntries).toEqual([
      { id: "in", date: "2026-08-25", effect: 200000, name: null, transfer: true },
      { id: "out", date: "2026-08-22", effect: -5000, name: null, transfer: true },
      { id: "refund", date: "2026-08-14", effect: 2309, name: "Balance adjustment", transfer: false },
    ]);
  });

  it("finds the earliest dated row as the period start", () => {
    expect(importPeriodStart([{ date: null }, { date: "2026-08-29" }, { date: "2026-08-27" }])).toBe("2026-08-27");
    expect(importPeriodStart([{ date: null }])).toBeNull();
  });
});
