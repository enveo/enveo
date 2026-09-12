import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  classifySourceAdapter,
  normalizeBaselineRecognition,
  normalizeCandidateRecognition,
  parseEvalArgs,
  parseRecognitionManifest,
  type RecognitionManifestRow,
} from "../evaluate-import-recognition";
import { type ActualImportRecognitionRow, type ExpectedImportRecognitionRow, gateImportRecognition, scoreImportRecognition } from "./importRecognitionMetrics";

const expectedRow = (overrides: Partial<ExpectedImportRecognitionRow> = {}): ExpectedImportRecognitionRow => ({
  id: "purchase",
  rowRole: "financial_event",
  postingStatus: "posted",
  safetyClass: "safe_auto",
  requiredSafetyReasons: [],
  expectedDuplicateStatus: "new",
  date: "2026-08-15",
  amount: 1299,
  currency: "EUR",
  direction: "debit",
  semanticKind: "card_purchase",
  relation: null,
  expectedProposal: {
    type: "expense",
    isRefund: false,
    toAccountId: null,
    envelopeId: "groceries",
    categoryId: "daily",
  },
  ...overrides,
});

const actualRow = (overrides: Partial<ActualImportRecognitionRow> = {}): ActualImportRecognitionRow => ({
  id: "purchase",
  postingStatus: "posted",
  date: "2026-08-15",
  amount: 1299,
  currency: "EUR",
  direction: "debit",
  semanticKind: "card_purchase",
  relation: null,
  proposal: {
    selected: true,
    disposition: "candidate",
    type: "expense",
    isRefund: false,
    toAccountId: null,
    envelopeId: "groceries",
    categoryId: "daily",
    reviewReasons: [],
    duplicateStatus: "new",
  },
  ...overrides,
});

describe("scoreImportRecognition", () => {
  test("scores optional name and place expectations without changing older manifests", () => {
    const truth = expectedRow({ expectedProposal: { ...expectedRow().expectedProposal!, name: "Groceries", placeName: null } });
    const correct = actualRow({ proposal: { ...actualRow().proposal!, name: "Groceries", placeName: null } });

    expect(scoreImportRecognition([truth], [correct]).interpretationErrors).toBe(0);
    expect(scoreImportRecognition([truth], [actualRow({ proposal: { ...correct.proposal!, name: "Fuel" } })]).interpretationErrors).toBe(1);
    expect(scoreImportRecognition([truth], [actualRow({ proposal: { ...correct.proposal!, placeName: "Invented place" } })]).interpretationErrors).toBe(1);
    expect(scoreImportRecognition([expectedRow()], [correct]).interpretationErrors).toBe(0);
  });

  test("pending purchases are included and reviewed by the same rules as posted purchases", () => {
    const truth = expectedRow({ postingStatus: "pending" });
    const selected = actualRow({ postingStatus: "pending" });
    const metrics = scoreImportRecognition([truth], [selected]);

    expect(metrics.inclusion).toEqual({ missingFinancial: 0, nonLedgerIncluded: 0, exactDuplicateSelected: 0 });
    expect(metrics.reviewCoverage.total).toBe(0);
    expect(gateImportRecognition([truth], [selected], [selected]).passed).toBe(true);
    const omitted = scoreImportRecognition([truth], [actualRow({ proposal: { ...selected.proposal!, selected: false } })]);
    expect(omitted.inclusion.missingFinancial).toBe(1);
    expect(omitted.reviewRequired).toBe(1);
  });

  test("scores inclusion independently from interpretation and review coverage", () => {
    const expected = [
      expectedRow({ id: "review", safetyClass: "unsafe_auto", requiredSafetyReasons: ["possible_ocr_error"] }),
      expectedRow({ id: "support", rowRole: "supporting_detail", safetyClass: "non_ledger", expectedProposal: null }),
    ];
    const actual = [
      actualRow({ id: "review", proposal: { ...actualRow().proposal!, selected: true, type: "income", reviewReasons: ["possible_ocr_error"] } }),
      actualRow({ id: "support", proposal: { ...actualRow().proposal!, selected: false } }),
    ];
    const metrics = scoreImportRecognition(expected, actual);
    expect(metrics.inclusion).toEqual({ missingFinancial: 0, nonLedgerIncluded: 0, exactDuplicateSelected: 0 });
    expect(metrics.interpretationErrors).toBe(1);
    expect(metrics.reviewCoverage).toEqual({ correct: 1, total: 1, rate: 1 });
  });

  test("derives mandatory missing-fact review from financial truth instead of optional manifest prose", () => {
    const expected = expectedRow({ date: null, requiredSafetyReasons: [] });
    const actual = actualRow({
      date: null,
      proposal: { ...actualRow().proposal!, disposition: "unresolved", reviewReasons: ["missing_fact"] },
    });

    const metrics = scoreImportRecognition([expected], [actual]);

    expect(metrics.reviewCoverage).toEqual({ correct: 1, total: 1, rate: 1 });
    expect(metrics.unexpectedReviewReasons).toBe(0);
  });

  test("row recall counts every labelled row while financial recall excludes UI evidence", () => {
    const expected = [expectedRow(), expectedRow({ id: "balance", rowRole: "ui_metadata", safetyClass: "non_ledger", expectedProposal: null })];

    const metrics = scoreImportRecognition(expected, [actualRow()]);

    expect(metrics.rowRecall).toEqual({ correct: 1, total: 2, rate: 0.5 });
    expect(metrics.financialRowRecall).toEqual({ correct: 1, total: 1, rate: 1 });
  });

  test("immutable fact accuracy scores amount, date, currency, and direction independently", () => {
    const metrics = scoreImportRecognition([expectedRow()], [actualRow({ date: "2026-08-14", amount: 1300, currency: "USD", direction: "credit" })]);

    expect(metrics.factAccuracy).toEqual({
      amount: { correct: 0, total: 1, rate: 0 },
      date: { correct: 0, total: 1, rate: 0 },
      currency: { correct: 0, total: 1, rate: 0 },
      direction: { correct: 0, total: 1, rate: 0 },
      overall: { correct: 0, total: 4, rate: 0 },
    });
  });

  test("missing financial rows stay in fact and semantic denominators", () => {
    const metrics = scoreImportRecognition([expectedRow()], []);

    expect(metrics.factAccuracy.overall).toEqual({ correct: 0, total: 4, rate: 0 });
    expect(metrics.semanticKindAccuracy).toEqual({ correct: 0, total: 1, rate: 0 });
  });

  test("semantic kind accuracy is independent of correct immutable facts", () => {
    const metrics = scoreImportRecognition([expectedRow()], [actualRow({ semanticKind: "cashback_or_reward" })]);

    expect(metrics.factAccuracy.overall).toEqual({ correct: 4, total: 4, rate: 1 });
    expect(metrics.semanticKindAccuracy).toEqual({ correct: 0, total: 1, rate: 0 });
  });

  test("relation precision penalizes a wrong or unexpected actual relation without inventing a zero-case score", () => {
    const expected = [expectedRow({ id: "purchase" }), expectedRow({ id: "fx", relation: { kind: "fx_for", rowId: "purchase" }, expectedProposal: null })];
    const actual = [actualRow(), actualRow({ id: "fx", relation: { kind: "refund_of", rowId: "purchase" }, proposal: null })];

    expect(scoreImportRecognition(expected, actual).relationPrecision).toEqual({ correct: 0, total: 1, rate: 0 });
    expect(scoreImportRecognition([expectedRow()], [actualRow()]).relationPrecision).toEqual({ correct: 0, total: 0, rate: null });
  });

  test("relation recall keeps the truth-derived denominator when the model omits every relation", () => {
    // Break caught: deleting all candidate relations used to turn precision into a null
    // denominator, allowing a materially incomplete result to evade the paired gate.
    const expected = [expectedRow(), expectedRow({ id: "fx", relation: { kind: "fx_for", rowId: "purchase" }, expectedProposal: null })];
    const actual = [actualRow(), actualRow({ id: "fx", relation: null, proposal: null })];

    const metrics = scoreImportRecognition(expected, actual);

    expect(metrics.relationRecall).toEqual({ correct: 0, total: 1, rate: 0 });
    expect(metrics.relationF1).toBe(0);
  });

  test("a wrong selected type is an interpretation error without becoming an inclusion error", () => {
    const metrics = scoreImportRecognition([expectedRow()], [actualRow({ proposal: { ...actualRow().proposal!, selected: true, type: "income" } })]);

    expect(metrics.interpretationErrors).toBe(1);
    expect(metrics.inclusion).toEqual({ missingFinancial: 0, nonLedgerIncluded: 0, exactDuplicateSelected: 0 });
  });

  test("a blocking unknown-kind proposal is review work, not an applied interpretation error", () => {
    const metrics = scoreImportRecognition(
      [expectedRow()],
      [
        actualRow({
          semanticKind: "unknown",
          proposal: { ...actualRow().proposal!, type: null, disposition: "unresolved", reviewReasons: ["unknown_kind"] },
        }),
      ],
    );

    expect(metrics.interpretationErrors).toBe(0);
    expect(metrics.inclusion.missingFinancial).toBe(0);
  });

  test("an unselected financial proposal is an inclusion miss even when its interpretation is wrong", () => {
    const metrics = scoreImportRecognition(
      [expectedRow({ safetyClass: "review_only" })],
      [
        actualRow({
          proposal: {
            ...actualRow().proposal!,
            selected: false,
            disposition: "unresolved",
            type: "income",
          },
        }),
      ],
    );

    expect(metrics.inclusion.missingFinancial).toBe(1);
    expect(metrics.interpretationErrors).toBe(1);
  });

  test("unselected non-ledger evidence is reported separately without entering release review denominators", () => {
    const expected = expectedRow({ rowRole: "ui_metadata", safetyClass: "non_ledger", expectedProposal: null });
    const metrics = scoreImportRecognition([expected], [actualRow({ proposal: { ...actualRow().proposal!, selected: false } })]);

    expect(metrics.inclusion.nonLedgerIncluded).toBe(0);
    expect(metrics.factAccuracy.overall).toEqual({ correct: 0, total: 0, rate: null });
    expect(metrics.semanticKindAccuracy).toEqual({ correct: 1, total: 1, rate: 1 });
    expect(metrics.reviewBreakdown.supportingOrUi).toBe(1);
  });

  test("an empty corpus exposes zero denominators instead of reporting perfect accuracy", () => {
    const metrics = scoreImportRecognition([], []);

    expect(metrics.rowRecall).toEqual({ correct: 0, total: 0, rate: null });
    expect(metrics.financialRowRecall).toEqual({ correct: 0, total: 0, rate: null });
    expect(metrics.factAccuracy.overall).toEqual({ correct: 0, total: 0, rate: null });
    expect(metrics.semanticKindAccuracy).toEqual({ correct: 0, total: 0, rate: null });
    expect(metrics.relationPrecision).toEqual({ correct: 0, total: 0, rate: null });
    expect(metrics.relationRecall).toEqual({ correct: 0, total: 0, rate: null });
    expect(metrics.relationF1).toBeNull();
    expect(metrics.inclusion).toEqual({ missingFinancial: 0, nonLedgerIncluded: 0, exactDuplicateSelected: 0 });
    expect(metrics.reviewRequired).toBe(0);
  });

  test("missing rows, missing proposals, and unexpected outputs have independent counters", () => {
    const missingRow = scoreImportRecognition([expectedRow()], []);
    const missingProposal = scoreImportRecognition([expectedRow()], [actualRow({ proposal: null })]);
    const unexpected = scoreImportRecognition(
      [],
      [
        actualRow({ id: "selected-unexpected" }),
        actualRow({ id: "review-unexpected", proposal: { ...actualRow().proposal!, selected: false } }),
        actualRow({ id: "proposal-less-unexpected", proposal: null }),
      ],
    );

    expect(missingRow).toMatchObject({ missingRows: 1, missingProposals: 0 });
    expect(missingProposal).toMatchObject({ missingRows: 0, missingProposals: 1 });
    expect(unexpected.unexpectedRows).toEqual({ total: 3, selected: 1, unselected: 1, withoutProposal: 1 });
    expect(unexpected.reviewRequired).toBe(0);
  });
});

describe("gateImportRecognition", () => {
  test("rejects an incorrect posting status even when the baseline makes the same mistake", () => {
    const truth = expectedRow({ postingStatus: "pending" });
    const wrong = actualRow({ postingStatus: "posted" });

    const decision = gateImportRecognition([truth], [wrong], [wrong]);

    expect(decision.passed).toBe(false);
    expect(decision.reasons).toContain("posting_status_incorrect");
    expect(decision.candidate.postingStatusAccuracy).toEqual({ correct: 0, total: 1, rate: 0 });
  });

  test("requires candidate posting status while allowing a legacy baseline to omit it", () => {
    const truth = expectedRow();
    const legacy = actualRow({ postingStatus: undefined });
    const correct = actualRow({ postingStatus: "posted" });

    expect(gateImportRecognition([truth], [legacy], [correct]).passed).toBe(true);
    expect(gateImportRecognition([truth], [legacy], [legacy]).reasons).toContain("posting_status_incorrect");
  });

  test("cannot offset a newly broken protected field with improvements in other cases", () => {
    const truth = expectedRow({ expectedProposal: { ...expectedRow().expectedProposal!, name: "Groceries", placeName: "Market" } });
    const correct = actualRow({ proposal: { ...actualRow().proposal!, name: "Groceries", placeName: "Market" } });
    const expected = [truth, { ...truth, id: "second" }, { ...truth, id: "third" }];
    const financialChanges = [{ amount: 1300 }, { date: "2026-08-14" }, { currency: "USD" }, { direction: "credit" }, { semanticKind: "salary" }] as const;
    const metadataChanges = [
      { name: "Fuel" },
      { placeName: null },
      { envelopeId: null },
      { categoryId: null },
      { type: "income" },
      { isRefund: true },
      { toAccountId: "other" },
    ] as const;
    const wrongRows = [
      ...financialChanges.map((change) => ({ ...correct, ...change })),
      ...metadataChanges.map((change) => ({ ...correct, proposal: { ...correct.proposal!, ...change } })),
    ];
    for (const wrong of wrongRows) {
      const baseline = [correct, { ...wrong, id: "second" }, { ...wrong, id: "third" }];
      const candidate = [wrong, { ...correct, id: "second" }, { ...correct, id: "third" }];
      const decision = gateImportRecognition(expected, baseline, candidate);
      expect(decision.passed).toBe(false);
      expect(decision.reasons).toContain("protected_field_regression");
    }
  });

  test("protects correct fields even when another field of the same proposal was already wrong", () => {
    const truth = expectedRow();
    const baseline = actualRow({ proposal: { ...actualRow().proposal!, categoryId: null } });
    const candidate = actualRow({ proposal: { ...actualRow().proposal!, envelopeId: null } });

    expect(gateImportRecognition([truth], [baseline], [candidate]).reasons).toContain("protected_field_regression");
  });

  test("rejects a selected row that has no labelled screenshot event", () => {
    const decision = gateImportRecognition(
      [expectedRow()],
      [actualRow()],
      [actualRow(), actualRow({ id: "hallucinated", proposal: { ...actualRow().proposal!, selected: true } })],
    );

    expect(decision.reasons).toContain("unexpected_row_selected");
  });

  test("enforces exact and probable duplicate inclusion semantics", () => {
    const expected = [expectedRow({ id: "exact", expectedDuplicateStatus: "exists" }), expectedRow({ id: "probable", expectedDuplicateStatus: "probable" })];
    const baseline = [actualRow({ id: "exact" }), actualRow({ id: "probable" })];
    const correct = [
      actualRow({ id: "exact", proposal: { ...actualRow().proposal!, selected: false, duplicateStatus: "exists" } }),
      actualRow({ id: "probable", proposal: { ...actualRow().proposal!, selected: true, duplicateStatus: "probable" } }),
    ];

    expect(gateImportRecognition(expected, baseline, correct).passed).toBe(true);
    expect(
      gateImportRecognition(expected, baseline, [
        actualRow({ id: "exact", proposal: { ...actualRow().proposal!, selected: true, duplicateStatus: "new" } }),
        actualRow({ id: "probable", proposal: { ...actualRow().proposal!, selected: false, duplicateStatus: "probable" } }),
      ]).reasons,
    ).toEqual(expect.arrayContaining(["financial_event_not_selected", "duplicate_status_incorrect"]));

    const conservativeExact = [
      actualRow({
        id: "exact",
        proposal: { ...actualRow().proposal!, selected: true, duplicateStatus: "probable", reviewReasons: ["multiple_history_candidates"] },
      }),
      correct[1]!,
    ];
    expect(gateImportRecognition(expected, baseline, conservativeExact).reasons).toEqual(
      expect.arrayContaining(["exact_duplicate_selected", "duplicate_status_incorrect"]),
    );
  });

  test("rejects review-reason noise that is not supported by labelled truth", () => {
    const expected = [expectedRow()];
    const candidate = [actualRow({ proposal: { ...actualRow().proposal!, reviewReasons: ["possible_ocr_error"] } })];
    const decision = gateImportRecognition(expected, [actualRow()], candidate);

    expect(decision.reasons).toContain("unexpected_review_reason");
    expect(scoreImportRecognition(expected, candidate).unexpectedReviewReasonCounts).toEqual({ possible_ocr_error: 1 });
  });

  test("does not call a validator-derived warning noise when the candidate facts require it", () => {
    const metrics = scoreImportRecognition(
      [expectedRow({ semanticKind: "outgoing_transfer", direction: "debit" })],
      [
        actualRow({
          direction: "credit",
          semanticKind: "outgoing_transfer",
          rowRole: "financial_event",
          postingStatus: "posted",
          proposal: { ...actualRow().proposal!, reviewReasons: ["inconsistent_direction"] },
        }),
      ],
    );

    expect(metrics.unexpectedReviewReasons).toBe(0);
  });

  test("allows the deterministic ledger-shape warning on both ends of an accepted relation", () => {
    const expected = [
      expectedRow({ id: "purchase" }),
      expectedRow({ id: "fx", rowRole: "supporting_detail", safetyClass: "non_ledger", expectedProposal: null }),
    ];
    const candidate = [
      actualRow({ proposal: { ...actualRow().proposal!, reviewReasons: ["relation_changes_ledger_shape"] } }),
      actualRow({ id: "fx", rowRole: "supporting_detail", relation: { kind: "fx_for", rowId: "purchase" }, proposal: null }),
    ];

    expect(scoreImportRecognition(expected, candidate).unexpectedReviewReasons).toBe(0);
  });

  test("allows only the deterministic review reason implied by each duplicate status", () => {
    const expected = [expectedRow({ id: "exact", expectedDuplicateStatus: "exists" }), expectedRow({ id: "probable", expectedDuplicateStatus: "probable" })];
    const candidate = [
      actualRow({
        id: "exact",
        proposal: { ...actualRow().proposal!, selected: false, duplicateStatus: "exists", reviewReasons: ["history_conflict"] },
      }),
      actualRow({
        id: "probable",
        proposal: { ...actualRow().proposal!, duplicateStatus: "probable", reviewReasons: ["multiple_history_candidates"] },
      }),
    ];

    expect(gateImportRecognition(expected, [actualRow({ id: "exact" }), actualRow({ id: "probable" })], candidate).passed).toBe(true);
  });

  test("rejects missing financial inclusion and selected non-ledger evidence independently", () => {
    const expected = [
      expectedRow(),
      expectedRow({ id: "ui", rowRole: "ui_metadata", safetyClass: "non_ledger", semanticKind: "unknown", expectedProposal: null }),
    ];
    const baseline = [actualRow(), actualRow({ id: "ui", semanticKind: "unknown", proposal: null })];
    const candidate = [
      actualRow({ proposal: { ...actualRow().proposal!, selected: false } }),
      actualRow({ id: "ui", semanticKind: "unknown", proposal: { ...actualRow().proposal!, selected: true } }),
    ];

    const decision = gateImportRecognition(expected, baseline, candidate);

    expect(decision.reasons).toContain("financial_event_not_selected");
    expect(decision.reasons).toContain("non_ledger_selected");
  });

  test("requires complete review coverage without forcing the financial event to be unchecked", () => {
    const expected = [expectedRow({ safetyClass: "unsafe_auto", requiredSafetyReasons: ["possible_transfer"] })];
    const baseline = [actualRow({ proposal: { ...actualRow().proposal!, reviewReasons: [] } })];
    const missingReview = [actualRow({ proposal: { ...actualRow().proposal!, selected: true, reviewReasons: [] } })];
    const reviewed = [actualRow({ proposal: { ...actualRow().proposal!, selected: true, reviewReasons: ["possible_transfer"] } })];

    expect(gateImportRecognition(expected, baseline, missingReview).reasons).toContain("review_coverage_incomplete");
    expect(gateImportRecognition(expected, baseline, reviewed).passed).toBe(true);
  });

  test("keeps a risky financial event selected while requiring its review reason", () => {
    const expected = [
      {
        ...expectedRow(),
        rowRole: "financial_event",
        postingStatus: "posted",
        safetyClass: "unsafe_auto",
        requiredSafetyReasons: ["possible_transfer"],
      },
    ] as unknown as ExpectedImportRecognitionRow[];
    const baseline = [actualRow({ proposal: { ...actualRow().proposal!, type: "income", selected: true } })];
    const candidate = [
      actualRow({
        proposal: {
          ...actualRow().proposal!,
          selected: true,
          reviewReasons: ["possible_transfer"],
        },
      }),
    ] as unknown as ActualImportRecognitionRow[];

    const gate = gateImportRecognition(expected, baseline, candidate);

    expect(gate.passed).toBe(true);
    expect(gate.transitions).toMatchObject({ attributableSafety: 1, unexplainedNewReviews: 0 });
  });

  test("uses fail-closed no-regression for interpretation errors", () => {
    const expected = [
      {
        ...expectedRow(),
        rowRole: "financial_event",
        postingStatus: "posted",
        safetyClass: "safe_auto",
        requiredSafetyReasons: [],
      },
    ] as unknown as ExpectedImportRecognitionRow[];

    expect(gateImportRecognition(expected, [actualRow()], [actualRow()]).passed).toBe(true);
    expect(gateImportRecognition(expected, [actualRow()], [actualRow({ proposal: { ...actualRow().proposal!, type: "income" } })]).reasons).toContain(
      "interpretation_error_regression_from_zero",
    );
  });

  test("an unrelated unexpected unselected row cannot improve safety attribution", () => {
    const expected = [
      {
        ...expectedRow(),
        rowRole: "financial_event",
        postingStatus: "posted",
        safetyClass: "unsafe_auto",
        requiredSafetyReasons: ["possible_transfer"],
      },
    ] as unknown as ExpectedImportRecognitionRow[];
    const baseline = [actualRow({ proposal: { ...actualRow().proposal!, type: "income" } })];
    const candidate = [
      actualRow({ proposal: { ...actualRow().proposal!, selected: true, reviewReasons: ["possible_transfer"] } }),
      actualRow({ id: "unexpected", proposal: { ...actualRow().proposal!, selected: false, reviewReasons: ["unknown_kind"] } }),
    ] as unknown as ActualImportRecognitionRow[];

    const gate = gateImportRecognition(expected, baseline, candidate);

    expect(gate.transitions.attributableSafety).toBe(1);
    expect(gate.candidate.reviewBreakdown.unexpected).toBe(1);
  });

  test("actual row relabeling cannot hide an interpretation error", () => {
    const expected = [
      {
        ...expectedRow(),
        rowRole: "financial_event",
        postingStatus: "posted",
        safetyClass: "safe_auto",
        requiredSafetyReasons: [],
      },
    ] as unknown as ExpectedImportRecognitionRow[];
    const relabelled = actualRow({ proposal: { ...actualRow().proposal!, type: "income" } }) as ActualImportRecognitionRow & { rowRole: string };
    relabelled.rowRole = "ui_metadata";

    expect(scoreImportRecognition(expected, [relabelled]).interpretationErrors).toBe(1);
  });

  test("a duplicate unselected copy cannot hide a selected unsafe output", () => {
    const expected = [expectedRow({ safetyClass: "unsafe_auto", requiredSafetyReasons: ["possible_transfer"] })];
    const baseline = [actualRow({ proposal: { ...actualRow().proposal!, type: "income" } })];
    const candidate = [
      actualRow({ proposal: { ...actualRow().proposal!, type: "income" } }),
      actualRow({ proposal: { ...actualRow().proposal!, selected: false, reviewReasons: ["possible_transfer"] } }),
    ];

    const gate = gateImportRecognition(expected, baseline, candidate);

    expect(gate.passed).toBe(false);
    expect(gate.candidate.unexpectedRows).toMatchObject({ total: 1, unselected: 1 });
    expect(gate.transitions.attributableSafety).toBe(0);
    expect(gate.transitions.unsafeConstraintFailures).toBe(1);
  });

  test("gates every immutable fact independently and accepts a truth-labelled review reason", () => {
    const safe = expectedRow();
    expect(gateImportRecognition([safe], [actualRow()], [actualRow({ amount: 1300 })]).reasons).toContain("amount_accuracy_regression");

    const review = expectedRow({ safetyClass: "review_only", requiredSafetyReasons: ["possible_ocr_error"] });
    const decision = gateImportRecognition(
      [review],
      [actualRow()],
      [actualRow({ proposal: { ...actualRow().proposal!, selected: true, reviewReasons: ["possible_ocr_error"] } })],
    );
    expect(decision.passed).toBe(true);
    expect(decision.reasons).not.toContain("unexplained_review_transition");
  });

  test("rejects a row-recall regression", () => {
    const expected = [expectedRow(), expectedRow({ id: "second" })];
    const baseline = [actualRow(), actualRow({ id: "second" })];

    const decision = gateImportRecognition(expected, baseline, [actualRow()]);

    expect(decision.reasons).toContain("row_recall_regression");
  });

  test("rejects a financial-row-recall regression", () => {
    const expected = [expectedRow(), expectedRow({ id: "label", rowRole: "ui_metadata", safetyClass: "non_ledger", expectedProposal: null })];
    const baseline = [actualRow(), actualRow({ id: "label", proposal: null })];
    const candidate = [actualRow({ id: "label", proposal: null })];

    const decision = gateImportRecognition(expected, baseline, candidate);

    expect(decision.reasons).toContain("financial_row_recall_regression");
  });

  test("rejects a semantic-kind accuracy regression even when facts and proposal shape stay correct", () => {
    const decision = gateImportRecognition([expectedRow()], [actualRow()], [actualRow({ semanticKind: "cashback_or_reward" })]);

    expect(decision.reasons).toContain("semantic_kind_accuracy_regression");
  });

  test("rejects relation precision and truth-denominator recall regressions independently", () => {
    const expected = [expectedRow(), expectedRow({ id: "fx", relation: { kind: "fx_for", rowId: "purchase" }, expectedProposal: null })];
    const baseline = [actualRow(), actualRow({ id: "fx", relation: { kind: "fx_for", rowId: "purchase" }, proposal: null })];
    const wrongExtra = [
      actualRow({ relation: { kind: "refund_of", rowId: "fx" } }),
      actualRow({ id: "fx", relation: { kind: "fx_for", rowId: "purchase" }, proposal: null }),
    ];
    const omitted = [actualRow(), actualRow({ id: "fx", relation: null, proposal: null })];

    expect(gateImportRecognition(expected, baseline, wrongExtra).reasons).toContain("relation_precision_regression");
    expect(gateImportRecognition(expected, baseline, omitted).reasons).toContain("relation_recall_regression");
  });

  test("rejects candidate relation deletion when the legacy-normalized baseline has zero relation capability", () => {
    // Break caught: legacy normalization always emits relation=null, so paired-only
    // no-regression let a candidate omit every truth-labelled relation and tie at zero.
    const expected = [
      expectedRow({ id: "purchase" }),
      expectedRow({
        id: "fx",
        rowRole: "supporting_detail",
        safetyClass: "non_ledger",
        semanticKind: "fx_conversion",
        relation: { kind: "fx_for", rowId: "purchase" },
        expectedProposal: null,
      }),
    ];
    const baseline = normalizeBaselineRecognition(
      "fixture",
      [
        manifestRow({ id: "purchase", baselineIndex: 0 }),
        manifestRow({
          id: "fx",
          rowRole: "supporting_detail",
          safetyClass: "non_ledger",
          semanticKind: "fx_conversion",
          relation: { kind: "fx_for", rowId: "purchase" },
          expectedProposal: null,
          baselineIndex: null,
          candidatePosition: { imageIndex: 0, visualOrder: 1 },
        }),
      ],
      [{ date: "2026-08-15", amount: 1299, currency: "EUR", type: "expense", isRefund: false }],
    );
    const candidate = [actualRow({ id: "fixture:purchase" }), actualRow({ id: "fixture:fx", semanticKind: "fx_conversion", relation: null, proposal: null })];
    const prefixedExpected = expected.map((row) => ({
      ...row,
      id: `fixture:${row.id}`,
      relation: row.relation ? { ...row.relation, rowId: `fixture:${row.relation.rowId}` } : null,
    }));

    const decision = gateImportRecognition(prefixedExpected, baseline, candidate);

    expect(decision.baseline.relationRecall).toEqual({ correct: 0, total: 1, rate: 0 });
    expect(decision.candidate.relationRecall).toEqual({ correct: 0, total: 1, rate: 0 });
    expect(decision.passed).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining(["relation_recall_not_improved_from_zero", "relation_f1_not_improved_from_zero"]));
  });

  test("rejects a relation F1 regression once the baseline has nonzero relation capability", () => {
    const expected = [
      expectedRow(),
      expectedRow({ id: "fx", relation: { kind: "fx_for", rowId: "purchase" }, expectedProposal: null }),
      expectedRow({ id: "fee", relation: { kind: "fee_for", rowId: "purchase" }, expectedProposal: null }),
    ];
    const baseline = [
      actualRow(),
      actualRow({ id: "fx", relation: { kind: "fx_for", rowId: "purchase" }, proposal: null }),
      actualRow({ id: "fee", relation: null, proposal: null }),
    ];
    const candidate = [
      actualRow(),
      actualRow({ id: "fx", relation: { kind: "fx_for", rowId: "purchase" }, proposal: null }),
      actualRow({ id: "fee", relation: { kind: "refund_of", rowId: "purchase" }, proposal: null }),
    ];

    const decision = gateImportRecognition(expected, baseline, candidate);

    expect(decision.candidate.relationRecall).toEqual(decision.baseline.relationRecall);
    expect(decision.candidate.relationF1).toBeLessThan(decision.baseline.relationF1!);
    expect(decision.reasons).toContain("relation_f1_regression");
  });

  test("legacy-zero relation gate rejects false-positive inflation and accepts its exact floor", () => {
    const expected = [
      expectedRow(),
      expectedRow({ id: "fx", relation: { kind: "fx_for", rowId: "purchase" }, expectedProposal: null }),
      expectedRow({ id: "fee", relation: { kind: "fee_for", rowId: "purchase" }, expectedProposal: null }),
    ];
    const baseline = [actualRow(), actualRow({ id: "fx", proposal: null }), actualRow({ id: "fee", proposal: null })];
    const exactFloor = [
      actualRow(),
      actualRow({ id: "fx", relation: { kind: "fx_for", rowId: "purchase" }, proposal: null }),
      actualRow({ id: "fee", proposal: null }),
    ];
    const inflated = [
      ...exactFloor,
      ...Array.from({ length: 9 }, (_, index) => actualRow({ id: `noise-${index}`, relation: { kind: "refund_of", rowId: "purchase" }, proposal: null })),
    ];

    const inflatedDecision = gateImportRecognition(expected, baseline, inflated);
    expect(inflatedDecision.candidate.relationPrecision.rate).toBe(0.1);
    expect(inflatedDecision.reasons).toContain("relation_precision_below_absolute_floor");
    expect(gateImportRecognition(expected, baseline, exactFloor).reasons).not.toEqual(
      expect.arrayContaining(["relation_precision_below_absolute_floor", "relation_recall_below_absolute_floor", "relation_f1_below_absolute_floor"]),
    );
  });

  test("absolute relation floors do not apply when truth has no relations", () => {
    const decision = gateImportRecognition([expectedRow()], [actualRow()], [actualRow()]);
    expect(decision.reasons).not.toEqual(expect.arrayContaining([expect.stringContaining("relation_")]));
  });

  test("combined omissions and relabeling cannot game the paired gate", () => {
    const expected = [
      expectedRow(),
      expectedRow({ id: "refund", semanticKind: "merchant_refund" }),
      expectedRow({
        id: "fx",
        rowRole: "supporting_detail",
        safetyClass: "non_ledger",
        expectedProposal: null,
        relation: { kind: "fx_for", rowId: "purchase" },
      }),
    ];
    const baseline = [
      actualRow(),
      actualRow({ id: "refund", semanticKind: "merchant_refund" }),
      actualRow({ id: "fx", semanticKind: "fx_conversion", relation: { kind: "fx_for", rowId: "purchase" }, proposal: null }),
    ];
    const candidate = [actualRow({ semanticKind: "salary" }), actualRow({ id: "refund", semanticKind: "salary" })];

    const decision = gateImportRecognition(expected, baseline, candidate);

    expect(decision.passed).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining(["row_recall_regression", "semantic_kind_accuracy_regression", "relation_recall_regression"]));
  });
});

const manifestRow = (overrides: Partial<RecognitionManifestRow> = {}): RecognitionManifestRow => ({
  ...expectedRow(),
  candidatePosition: { imageIndex: 0, visualOrder: 0 },
  baselineIndex: 0,
  matchText: "GREEN MARKET",
  ...overrides,
});

const dynamicCandidateResult = () => ({
  rows: [
    {
      rowId: "row-a",
      imageIndex: 0,
      visualOrder: 0,
      date: "2026-08-15",
      amount: 1299,
      currency: "EUR",
      direction: "debit",
      postingStatus: "posted",
      rowRole: "financial_event",
      semanticKind: "card_purchase",
      relation: null,
      rawTextLines: ["MARKET"],
      confidence: "high",
      reviewReasons: [],
    },
  ],
  proposals: [
    {
      rowId: "row-a",
      sourceRows: ["row-a"],
      disposition: "candidate",
      date: "2026-08-15",
      amount: 1299,
      currency: "EUR",
      type: "expense",
      isRefund: false,
      toAccountId: null,
      semanticKind: "card_purchase",
      relation: null,
      name: "Groceries",
      tag: "MARKET",
      rawPlace: "MARKET",
      envelopeId: null,
      categoryId: null,
      placeName: null,
      reviewReasons: [],
      selected: true,
      duplicateStatus: "new",
      sourceAccountInvalid: false,
    },
  ],
});

describe("recognition evaluator adapters", () => {
  test("adapters preserve optional proposal names and places for scoring", () => {
    const metadata = { name: "Groceries", placeName: "Market" };
    const baseline = normalizeBaselineRecognition(
      "fixture",
      [manifestRow()],
      [{ date: "2026-08-15", amount: 1299, currency: "EUR", type: "expense", isRefund: false, ...metadata }],
    );
    const result = dynamicCandidateResult();
    Object.assign(result.proposals[0]!, metadata);
    const candidate = normalizeCandidateRecognition("fixture", [manifestRow()], result as Parameters<typeof normalizeCandidateRecognition>[2]);

    expect(baseline[0]!.proposal).toMatchObject(metadata);
    expect(candidate[0]!.proposal).toMatchObject(metadata);
  });

  test("manifest accepts optional metadata expectations and ordinary pending purchases", () => {
    const fixture = {
      id: "fixture",
      images: ["images/fixture.png"],
      locale: "en",
      today: "2026-08-16",
      budgetCurrency: "EUR",
      formFactor: "mobile",
      overlap: false,
      rows: [manifestRow({ postingStatus: "pending", expectedProposal: { ...expectedRow().expectedProposal!, name: "Groceries", placeName: null } })],
    };
    const parsed = parseRecognitionManifest({ version: 1, fixtures: [fixture] }, false);
    expect(parsed.fixtures[0]!.rows[0]!.expectedProposal).toMatchObject({ name: "Groceries", placeName: null });
    fixture.rows[0]!.expectedProposal!.name = "";
    const emptyName = parseRecognitionManifest({ version: 1, fixtures: [fixture] }, false).fixtures[0]!.rows[0]!;
    expect(emptyName.expectedProposal!.name).toBe("");
    expect(scoreImportRecognition([emptyName], [actualRow({ proposal: { ...actualRow().proposal!, name: "", placeName: null } })]).interpretationErrors).toBe(
      0,
    );
    expect(
      scoreImportRecognition([emptyName], [actualRow({ proposal: { ...actualRow().proposal!, name: "Invented", placeName: null } })]).interpretationErrors,
    ).toBe(1);
    for (const invalidName of [1, null]) {
      fixture.rows[0]!.expectedProposal!.name = invalidName as never;
      expect(() => parseRecognitionManifest({ version: 1, fixtures: [fixture] }, false)).toThrow("name");
    }
  });

  test("candidate result validation fails closed before scoring malformed dynamic output", async () => {
    // Break caught: validating only metric-consumed fields lets a dynamically loaded
    // reconciled wire drift while the evaluator still publishes plausible scores.
    const evaluator = (await import("../evaluate-import-recognition")) as Record<string, unknown>;
    expect(typeof evaluator.parseCandidateResult).toBe("function");
    const parseCandidateResult = evaluator.parseCandidateResult as (value: unknown, imageCount: number) => unknown;
    const malformed = dynamicCandidateResult();
    malformed.proposals[0]!.sourceAccountInvalid = "no" as never;

    expect(() => parseCandidateResult(malformed, 1)).toThrow("candidate production result");
  });

  test("candidate result validation rejects out-of-bounds and duplicate visual positions", async () => {
    const evaluator = (await import("../evaluate-import-recognition")) as Record<string, unknown>;
    const parseCandidateResult = evaluator.parseCandidateResult as (value: unknown, imageCount: number) => unknown;
    const outOfBounds = dynamicCandidateResult();
    outOfBounds.rows[0]!.imageIndex = 1;
    const duplicate = dynamicCandidateResult();
    duplicate.rows.push({ ...duplicate.rows[0]!, rowId: "row-b" });
    duplicate.proposals.push({ ...duplicate.proposals[0]!, rowId: "row-b", sourceRows: ["row-b"] });

    expect(() => parseCandidateResult(outOfBounds, 1)).toThrow("imageIndex");
    expect(() => parseCandidateResult(duplicate, 1)).toThrow("duplicate visual position");
  });

  test("only a real OpenAI comparison can receive the release-success status", async () => {
    const evaluator = (await import("../evaluate-import-recognition")) as unknown as {
      comparisonReleaseStatus?: (
        transport: "openai" | "injected-test",
        criteriaPassed: boolean,
        reasons: string[],
        identityBound: boolean,
      ) => { releaseEligible: boolean; passed: boolean; reasons: string[]; exitCode: number };
    };
    expect(typeof evaluator.comparisonReleaseStatus).toBe("function");

    expect(evaluator.comparisonReleaseStatus!("openai", true, [], true)).toEqual({ releaseEligible: true, passed: true, reasons: [], exitCode: 0 });
    expect(evaluator.comparisonReleaseStatus!("openai", true, [], false)).toEqual({
      releaseEligible: false,
      passed: false,
      reasons: ["source_identity_unbound"],
      exitCode: 1,
    });
    expect(evaluator.comparisonReleaseStatus!("openai", false, ["unsafe_row_constraint_failed"], true)).toEqual({
      releaseEligible: false,
      passed: false,
      reasons: ["unsafe_row_constraint_failed"],
      exitCode: 1,
    });
    expect(evaluator.comparisonReleaseStatus!("injected-test", true, [], true)).toEqual({
      releaseEligible: false,
      passed: false,
      reasons: ["non_live_transport"],
      exitCode: 2,
    });
  });

  test("history safety binds the exact production pipeline and API/E2EE parity tests", async () => {
    const evaluator = (await import("../evaluate-import-recognition")) as unknown as {
      runHistorySafetyGate?: (root: string) => Promise<{
        passed: boolean;
        reasons: string[];
        sourceHashes: Record<string, string | null>;
        testHashes: Record<string, string | null>;
      }>;
    };
    expect(typeof evaluator.runHistorySafetyGate).toBe("function");
    const identity = await evaluator.runHistorySafetyGate!(resolve(import.meta.dir, "../.."));

    expect(identity.passed).toBe(true);
    expect(identity.reasons).toEqual([]);
    expect(identity.sourceHashes).toEqual({
      sharedPipeline: expect.stringMatching(/^[0-9a-f]{64}$/),
      sharedHistory: expect.stringMatching(/^[0-9a-f]{64}$/),
      sharedRecognition: expect.stringMatching(/^[0-9a-f]{64}$/),
      apiAdapter: expect.stringMatching(/^[0-9a-f]{64}$/),
      e2eeAdapter: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(identity.testHashes).toEqual({
      sharedPipeline: expect.stringMatching(/^[0-9a-f]{64}$/),
      sharedHistory: expect.stringMatching(/^[0-9a-f]{64}$/),
      apiE2eeParity: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  }, 30_000);

  test("paired mode requires distinct explicit baseline and candidate source trees", () => {
    expect(
      parseEvalArgs([
        "--manifest",
        "/private/manifest.json",
        "--mode",
        "compare",
        "--baseline-source-tree",
        "/repo/main",
        "--candidate-source-tree",
        "/repo/worktree",
        "--expected-candidate-revision",
        "0123456789abcdef0123456789abcdef01234567",
      ]),
    ).toEqual({
      manifestPath: "/private/manifest.json",
      mode: "compare",
      baselineSourceTree: "/repo/main",
      candidateSourceTree: "/repo/worktree",
      expectedCandidateRevision: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(() => parseEvalArgs(["--manifest", "/private/manifest.json", "--mode", "compare", "--baseline-source-tree", "/repo/main"])).toThrow(
      "--candidate-source-tree",
    );
    expect(() =>
      parseEvalArgs([
        "--manifest",
        "/private/manifest.json",
        "--mode",
        "compare",
        "--baseline-source-tree",
        "/repo/main",
        "--candidate-source-tree",
        "/repo/worktree",
      ]),
    ).toThrow("--expected-candidate-revision");
  });

  test("CLI requires an explicit manifest, mode, and source tree", () => {
    expect(
      parseEvalArgs([
        "--manifest",
        "/private/manifest.json",
        "--mode",
        "baseline",
        "--source-tree",
        "/repo/main",
        "--expected-revision",
        "0123456789abcdef0123456789abcdef01234567",
      ]),
    ).toEqual({
      manifestPath: "/private/manifest.json",
      mode: "baseline",
      sourceTree: "/repo/main",
      expectedRevision: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(() => parseEvalArgs(["--manifest", "/private/manifest.json", "--mode", "candidate"])).toThrow("--source-tree");
    expect(() => parseEvalArgs(["--manifest", "/private/manifest.json", "--mode", "baseline", "--source-tree", "/repo/main"])).toThrow("--expected-revision");
  });

  test("mode rejects the other source contract instead of relabelling one implementation", () => {
    const baselineSchema = { schema: { properties: { transactions: {} } } };
    const candidateSchema = { schema: { properties: { rows: {} } } };

    expect(classifySourceAdapter("baseline", baselineSchema)).toBe("legacy-transactions");
    expect(classifySourceAdapter("candidate", candidateSchema)).toBe("recognition-rows");
    expect(() => classifySourceAdapter("baseline", candidateSchema)).toThrow("baseline source tree");
    expect(() => classifySourceAdapter("candidate", baselineSchema)).toThrow("candidate source tree");
  });

  test("baseline adapter normalizes the legacy transactions contract deterministically", () => {
    const rows = [manifestRow({ id: "refund", semanticKind: "merchant_refund", expectedProposal: { ...expectedRow().expectedProposal!, isRefund: true } })];

    const actual = normalizeBaselineRecognition("fixture", rows, [
      {
        date: "2026-08-15",
        amount: 1299,
        currency: "eur",
        type: "expense",
        isRefund: true,
      },
    ]);

    expect(actual).toEqual([
      {
        id: "fixture:refund",
        rowRole: "financial_event",
        postingStatus: "posted",
        date: "2026-08-15",
        amount: 1299,
        currency: "EUR",
        direction: "credit",
        semanticKind: "merchant_refund",
        relation: null,
        proposal: {
          selected: true,
          disposition: "candidate",
          reviewReasons: [],
          duplicateStatus: "new",
          type: "expense",
          isRefund: true,
          toAccountId: null,
          envelopeId: null,
          categoryId: null,
        },
      },
    ]);
  });

  test("candidate adapter aligns rows by image and visual position and preserves conservative proposals", () => {
    const rows = [manifestRow({ id: "declined", candidatePosition: { imageIndex: 1, visualOrder: 3 }, baselineIndex: null })];

    const actual = normalizeCandidateRecognition("fixture", rows, {
      rows: [
        {
          rowId: "model-chosen-id",
          imageIndex: 1,
          visualOrder: 3,
          date: "2026-08-15",
          amount: 1299,
          currency: "EUR",
          direction: "debit",
          postingStatus: "declined",
          rowRole: "financial_event",
          semanticKind: "card_purchase",
          relation: null,
          reviewReasons: ["pending_or_declined"],
        },
      ],
      proposals: [
        {
          rowId: "model-chosen-id",
          ...({ semanticKind: "fee", relation: { kind: "fee_for", rowId: "model-chosen-id" } } as Record<string, unknown>),
          selected: false,
          disposition: "declined",
          reviewReasons: ["pending_or_declined"],
          duplicateStatus: "new",
          type: "expense",
          isRefund: false,
          toAccountId: null,
          envelopeId: null,
          categoryId: null,
        },
      ],
    });

    expect(actual[0]).toEqual({
      id: "fixture:declined",
      rowRole: "financial_event",
      postingStatus: "declined",
      date: "2026-08-15",
      amount: 1299,
      currency: "EUR",
      direction: "debit",
      semanticKind: "fee",
      relation: { kind: "fee_for", rowId: "fixture:declined" },
      proposal: {
        selected: false,
        disposition: "declined",
        reviewReasons: ["pending_or_declined"],
        duplicateStatus: "new",
        type: "expense",
        isRefund: false,
        toAccountId: null,
        envelopeId: null,
        categoryId: null,
      },
    });
  });

  test("adapters align by private match text when omissions or UI rows shift model order", () => {
    const rows = [
      manifestRow({ id: "purchase", baselineIndex: 0, matchText: "GREEN MARKET" }),
      manifestRow({ id: "refund", baselineIndex: 1, matchText: "BOOK NOOK" }),
    ];

    const baseline = normalizeBaselineRecognition("fixture", rows, [
      { date: "2026-08-15", amount: 1299, currency: "EUR", type: "expense", isRefund: true, rawPlace: "Book Nook, old town" },
    ]);
    const candidate = normalizeCandidateRecognition("fixture", rows, {
      rows: [
        {
          rowId: "model-row",
          imageIndex: 0,
          visualOrder: 99,
          rawTextLines: ["Book Nook", "refund"],
          date: "2026-08-15",
          amount: 1299,
          currency: "EUR",
          direction: "credit",
          postingStatus: "posted",
          rowRole: "financial_event",
          semanticKind: "merchant_refund",
          relation: null,
          reviewReasons: [],
        },
      ],
      proposals: [],
    });

    expect(baseline[0]?.id).toBe("fixture:refund");
    expect(candidate[0]?.id).toBe("fixture:refund");
  });

  test("duplicate private anchors fall back to image position instead of collapsing two visible rows", () => {
    const rows = [
      manifestRow({ id: "reward-one", matchText: "MONEYBACK", candidatePosition: { imageIndex: 0, visualOrder: 0 } }),
      manifestRow({ id: "reward-two", matchText: "MONEYBACK", candidatePosition: { imageIndex: 0, visualOrder: 1 } }),
    ];
    const actual = normalizeCandidateRecognition("fixture", rows, {
      rows: [
        {
          ...actualRow(),
          rowId: "one",
          imageIndex: 0,
          visualOrder: 0,
          rawTextLines: ["Moneyback"],
          postingStatus: "posted",
          rowRole: "financial_event",
          reviewReasons: [],
        },
        {
          ...actualRow(),
          rowId: "two",
          imageIndex: 0,
          visualOrder: 1,
          rawTextLines: ["Moneyback"],
          postingStatus: "posted",
          rowRole: "financial_event",
          reviewReasons: [],
        },
      ],
      proposals: [],
    });

    expect(actual.map((row) => row.id)).toEqual(["fixture:reward-one", "fixture:reward-two"]);
  });

  test("duplicate private anchors remain one-to-one when omitted evidence shifts every visible position", () => {
    const rows = [
      manifestRow({ id: "reward-one", matchText: "MONEYBACK", candidatePosition: { imageIndex: 0, visualOrder: 1 } }),
      manifestRow({ id: "reward-two", matchText: "MONEYBACK", candidatePosition: { imageIndex: 0, visualOrder: 2 } }),
      manifestRow({ id: "reward-three", matchText: "MONEYBACK", candidatePosition: { imageIndex: 0, visualOrder: 3 } }),
    ];
    const modelRows = [0, 1, 2].map((visualOrder) => ({
      ...actualRow(),
      rowId: `model-${visualOrder}`,
      imageIndex: 0,
      visualOrder,
      rawTextLines: ["Moneyback"],
      postingStatus: "posted" as const,
      rowRole: "financial_event" as const,
      reviewReasons: [],
    }));

    const actual = normalizeCandidateRecognition("fixture", rows, { rows: modelRows, proposals: [] });

    expect(actual.map((row) => row.id)).toEqual(["fixture:reward-one", "fixture:reward-two", "fixture:reward-three"]);
  });

  test("an extra UI fragment cannot steal a financial row's private anchor", () => {
    const rows = [manifestRow({ id: "purchase", matchText: "METRO TEST", candidatePosition: { imageIndex: 0, visualOrder: 0 } })];
    const actual = normalizeCandidateRecognition("fixture", rows, {
      rows: [
        {
          ...actualRow(),
          rowId: "fragment",
          imageIndex: 0,
          visualOrder: 0,
          rawTextLines: ["METRO TEST"],
          postingStatus: "unknown",
          rowRole: "ui_metadata",
          semanticKind: "unknown",
          reviewReasons: [],
        },
        {
          ...actualRow(),
          rowId: "transaction",
          imageIndex: 0,
          visualOrder: 1,
          rawTextLines: ["METRO TEST", "12.99 EUR"],
          postingStatus: "posted",
          rowRole: "financial_event",
          reviewReasons: [],
        },
      ],
      proposals: [],
    });

    expect(actual.map((row) => row.id)).toEqual(["fixture:unexpected-candidate-0", "fixture:purchase"]);
  });

  test("a financial row cannot steal a supporting anchor when its own private text was grouped into that row", () => {
    const rows = [
      manifestRow({ id: "purchase", matchText: "CLOUD PURCHASE", candidatePosition: { imageIndex: 0, visualOrder: 1 } }),
      manifestRow({
        id: "fx",
        matchText: "FX RATE",
        candidatePosition: { imageIndex: 0, visualOrder: 2 },
        rowRole: "supporting_detail",
        semanticKind: "fx_conversion",
        safetyClass: "non_ledger",
        expectedProposal: null,
      }),
    ];
    const actual = normalizeCandidateRecognition("fixture", rows, {
      rows: [
        {
          ...actualRow(),
          rowId: "grouped-purchase",
          imageIndex: 0,
          visualOrder: 2,
          rawTextLines: ["FX RATE", "CLOUD"],
          postingStatus: "posted",
          rowRole: "financial_event",
          semanticKind: "card_purchase",
          reviewReasons: [],
        },
      ],
      proposals: [],
    });

    expect(actual[0]?.id).toBe("fixture:purchase");
  });

  test("an unanchored repeated financial row aligns to the only remaining same-kind truth", () => {
    const rows = [
      manifestRow({ id: "reward-one", matchText: "8 REWARD", semanticKind: "cashback_or_reward", candidatePosition: { imageIndex: 0, visualOrder: 1 } }),
      manifestRow({ id: "reward-two", matchText: "90 REWARD", semanticKind: "cashback_or_reward", candidatePosition: { imageIndex: 0, visualOrder: 2 } }),
      manifestRow({ id: "reward-three", matchText: "8 REWARD", semanticKind: "cashback_or_reward", candidatePosition: { imageIndex: 0, visualOrder: 3 } }),
    ];
    const actual = normalizeCandidateRecognition("fixture", rows, {
      rows: [
        {
          ...actualRow(),
          rowId: "one",
          imageIndex: 0,
          visualOrder: 1,
          rawTextLines: ["8 REWARD"],
          postingStatus: "posted",
          rowRole: "financial_event",
          semanticKind: "cashback_or_reward",
          reviewReasons: [],
        },
        {
          ...actualRow(),
          rowId: "three",
          imageIndex: 0,
          visualOrder: 2,
          rawTextLines: ["8 REWARD"],
          postingStatus: "posted",
          rowRole: "financial_event",
          semanticKind: "cashback_or_reward",
          reviewReasons: [],
        },
        {
          ...actualRow(),
          rowId: "unanchored-two",
          imageIndex: 0,
          visualOrder: 3,
          rawTextLines: ["REWARD"],
          postingStatus: "posted",
          rowRole: "financial_event",
          semanticKind: "cashback_or_reward",
          reviewReasons: [],
        },
      ],
      proposals: [],
    });

    expect(actual.map((row) => row.id)).toEqual(["fixture:reward-one", "fixture:reward-three", "fixture:reward-two"]);
  });

  test("manifest validation rejects unresolvable positions, relations, and baseline gaps", () => {
    const fixture = {
      id: "fixture",
      images: ["images/fixture.png"],
      locale: "en",
      today: "2026-08-16",
      budgetCurrency: "EUR",
      formFactor: "mobile",
      overlap: false,
      rows: [manifestRow()],
    };

    expect(() =>
      parseRecognitionManifest(
        {
          version: 1,
          fixtures: [{ ...fixture, rows: [manifestRow({ candidatePosition: { imageIndex: 1, visualOrder: 0 } })] }],
        },
        false,
      ),
    ).toThrow("imageIndex");
    expect(() =>
      parseRecognitionManifest(
        {
          version: 1,
          fixtures: [
            {
              ...fixture,
              rows: [
                manifestRow({
                  relation: { kind: "fx_for", rowId: "missing" },
                  safetyClass: "unsafe_auto",
                  requiredSafetyReasons: ["relation_changes_ledger_shape"],
                }),
              ],
            },
          ],
        },
        false,
      ),
    ).toThrow("relation target");
    expect(() =>
      parseRecognitionManifest(
        {
          version: 1,
          fixtures: [{ ...fixture, rows: [manifestRow({ baselineIndex: 1 })] }],
        },
        false,
      ),
    ).toThrow("baseline indexes");
  });

  test("manifest context carries deterministic account, ledger, and history inputs", () => {
    const fixture = {
      id: "fixture",
      images: ["images/fixture.png"],
      locale: "en",
      today: "2026-08-16",
      budgetCurrency: "EUR",
      formFactor: "mobile",
      overlap: false,
      context: {
        accountId: "account-a",
        accounts: [
          { id: "account-a", name: "Checking" },
          { id: "account-b", name: "Savings", archived: true },
        ],
        envelopes: [{ id: "envelope-a", name: "Food" }],
        categories: [{ id: "category-a", name: "Daily" }],
        transactions: [{ accountId: "account-a", date: "2026-08-15", amount: 1299, sourceRef: "MARKET" }],
        historyRecords: [
          {
            accountId: "account-a",
            currency: "EUR",
            sourceRef: "",
            tag: "MARKET",
            place: "Market",
            name: "Groceries",
            envelope: "Food",
            category: "Daily",
            type: "expense",
            isRefund: false,
            toAccountId: null,
          },
        ],
      },
      rows: [manifestRow()],
    };

    const parsed = parseRecognitionManifest({ version: 1, fixtures: [fixture] }, false);
    expect(parsed.fixtures[0]!.context).toMatchObject({ accountId: "account-a" });
    expect(parsed.fixtures[0]!.context.historyRecords).toHaveLength(1);
    expect(parsed.fixtures[0]!.context.historyRecords[0]!.sourceRef).toBe("");
    expect(() => parseRecognitionManifest({ version: 1, fixtures: [{ ...fixture, context: { ...fixture.context, accountId: "missing" } }] }, false)).toThrow(
      "not present in accounts",
    );
  });

  test("manifest validation rejects legacy material labels, invalid facts, and empty fixtures", () => {
    const fixture = {
      id: "fixture",
      images: ["images/fixture.png"],
      locale: "en",
      today: "2026-08-16",
      budgetCurrency: "EUR",
      formFactor: "mobile",
      overlap: false,
      rows: [manifestRow()],
    };

    expect(() => parseRecognitionManifest({ version: 1, fixtures: [{ ...fixture, rows: [{ ...manifestRow(), material: false }] }] }, false)).toThrow(
      "unknown fields",
    );
    expect(() => parseRecognitionManifest({ version: 1, fixtures: [{ ...fixture, today: "2026-02-30" }] }, false)).toThrow("calendar date");
    expect(() => parseRecognitionManifest({ version: 1, fixtures: [{ ...fixture, budgetCurrency: "JPY" }] }, false)).toThrow("two-decimal currency");
    expect(() => parseRecognitionManifest({ version: 1, fixtures: [{ ...fixture, rows: [] }] }, false)).toThrow("must not be empty");
    expect(() => parseRecognitionManifest({ version: 1, fixtures: [{ ...fixture, rows: [manifestRow({ semanticKind: "invented_kind" })] }] }, false)).toThrow(
      "semanticKind",
    );
    expect(() =>
      parseRecognitionManifest(
        { version: 1, fixtures: [{ ...fixture, rows: [manifestRow({ relation: { kind: "invented_relation", rowId: "purchase" } })] }] },
        false,
      ),
    ).toThrow("relation");
  });

  test("known risky semantic and relation classes cannot be relabelled safe", () => {
    const fixture = {
      id: "fixture",
      images: ["images/fixture.png"],
      locale: "en",
      today: "2026-08-16",
      budgetCurrency: "EUR",
      formFactor: "mobile",
      overlap: false,
      rows: [manifestRow()],
    };

    expect(() =>
      parseRecognitionManifest({ version: 1, fixtures: [{ ...fixture, rows: [manifestRow({ semanticKind: "incoming_transfer" })] }] }, false),
    ).toThrow("possible_transfer");
    expect(() =>
      parseRecognitionManifest(
        {
          version: 1,
          fixtures: [
            {
              ...fixture,
              rows: [
                manifestRow({ relation: { kind: "counterpart_of", rowId: "other" } }),
                manifestRow({ id: "other", candidatePosition: { imageIndex: 0, visualOrder: 1 }, baselineIndex: 1 }),
              ],
            },
          ],
        },
        false,
      ),
    ).toThrow("relation_changes_ledger_shape");
  });

  test("transaction semantics cannot be relabelled as supporting or UI evidence", () => {
    const fixture = {
      id: "fixture",
      images: ["images/fixture.png"],
      locale: "en",
      today: "2026-08-16",
      budgetCurrency: "EUR",
      formFactor: "mobile",
      overlap: false,
      rows: [manifestRow()],
    };
    const relabelled = manifestRow({
      semanticKind: "incoming_transfer",
      rowRole: "supporting_detail",
      safetyClass: "non_ledger",
      expectedProposal: null,
    });

    expect(() => parseRecognitionManifest({ version: 1, fixtures: [{ ...fixture, rows: [relabelled] }] }, false)).toThrow(
      "transaction semantic kinds must be financial_event",
    );
  });

  test("representative coverage cannot be supplied by non-ledger transaction labels", () => {
    const requiredKinds = [
      "card_purchase",
      "salary",
      "merchant_refund",
      "cashback_or_reward",
      "incoming_transfer",
      "outgoing_transfer",
      "account_topup",
      "fx_conversion",
    ];
    const nonLedgerRows = requiredKinds.map((semanticKind, index) =>
      manifestRow({
        id: `non-ledger-${index}`,
        semanticKind,
        rowRole: "supporting_detail",
        safetyClass: "non_ledger",
        expectedProposal: null,
        candidatePosition: { imageIndex: 0, visualOrder: index },
        baselineIndex: null,
      }),
    );
    nonLedgerRows.push(
      manifestRow({
        id: "pending",
        postingStatus: "pending",
        candidatePosition: { imageIndex: 0, visualOrder: nonLedgerRows.length },
        baselineIndex: null,
      }),
      manifestRow({
        id: "declined",
        postingStatus: "declined",
        safetyClass: "review_only",
        requiredSafetyReasons: ["pending_or_declined"],
        candidatePosition: { imageIndex: 0, visualOrder: nonLedgerRows.length + 1 },
        baselineIndex: null,
      }),
    );
    const mobile = {
      id: "mobile",
      images: ["images/mobile.png"],
      locale: "en",
      today: "2026-08-16",
      budgetCurrency: "EUR",
      formFactor: "mobile",
      overlap: true,
      rows: nonLedgerRows,
    };
    const desktop = {
      id: "desktop",
      images: ["images/desktop.png"],
      locale: "es",
      today: "2026-08-16",
      budgetCurrency: "USD",
      formFactor: "desktop",
      overlap: false,
      rows: [manifestRow({ id: "desktop", currency: "USD", baselineIndex: null })],
    };

    expect(() => parseRecognitionManifest({ version: 1, fixtures: [mobile, desktop] })).toThrow("transaction semantic kinds must be financial_event");
  });

  test("representative coverage is derived from explicit fixture and row classifications", () => {
    const kinds = [
      "card_purchase",
      "salary",
      "merchant_refund",
      "cashback_or_reward",
      "incoming_transfer",
      "outgoing_transfer",
      "account_topup",
      "fx_conversion",
    ];
    const rows = kinds.map((semanticKind, index) =>
      manifestRow({
        id: `row-${index}`,
        semanticKind,
        candidatePosition: { imageIndex: 0, visualOrder: index },
        baselineIndex: null,
        ...(index === 0 ? { expectedDuplicateStatus: "probable" as const } : {}),
        ...(semanticKind === "incoming_transfer" || semanticKind === "account_topup"
          ? { safetyClass: "unsafe_auto" as const, requiredSafetyReasons: ["possible_transfer"] }
          : {}),
        ...(semanticKind === "fx_conversion" ? { rowRole: "supporting_detail" as const, safetyClass: "non_ledger" as const, expectedProposal: null } : {}),
      }),
    );
    rows.push(
      manifestRow({
        id: "pending",
        postingStatus: "pending",
        candidatePosition: { imageIndex: 0, visualOrder: rows.length },
        baselineIndex: null,
      }),
      manifestRow({
        id: "declined",
        postingStatus: "declined",
        safetyClass: "review_only",
        requiredSafetyReasons: ["pending_or_declined"],
        candidatePosition: { imageIndex: 0, visualOrder: rows.length + 1 },
        baselineIndex: null,
      }),
    );
    const mobile = {
      id: "mobile",
      images: ["images/mobile.png"],
      locale: "en",
      today: "2026-08-16",
      budgetCurrency: "EUR",
      formFactor: "mobile",
      overlap: true,
      rows,
    };
    const desktop = {
      id: "desktop",
      images: ["images/desktop.png"],
      locale: "es",
      today: "2026-08-16",
      budgetCurrency: "USD",
      formFactor: "desktop",
      overlap: false,
      rows: [manifestRow({ id: "desktop-purchase", currency: "USD", baselineIndex: null, expectedDuplicateStatus: "exists" })],
    };

    expect(() =>
      parseRecognitionManifest({
        version: 1,
        fixtures: [mobile, desktop].map((fixture) => ({
          ...fixture,
          rows: fixture.rows.map((row) => ({ ...row, expectedDuplicateStatus: "new" })),
        })),
      }),
    ).toThrow("duplicate coverage");
    expect(parseRecognitionManifest({ version: 1, fixtures: [mobile, desktop] }).fixtures).toHaveLength(2);
    expect(() =>
      parseRecognitionManifest({
        version: 1,
        fixtures: [{ ...mobile, rows: mobile.rows.filter((row) => row.semanticKind !== "salary") }, desktop],
      }),
    ).toThrow("coverage");
  });
});
