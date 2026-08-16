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
  },
  ...overrides,
});

describe("scoreImportRecognition", () => {
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

  test("a wrong automatically selected type is harmful", () => {
    const metrics = scoreImportRecognition([expectedRow()], [actualRow({ proposal: { ...actualRow().proposal!, selected: true, type: "income" } })]);

    expect(metrics.harmfulSelected).toBe(1);
    expect(metrics.reviewRequired).toBe(0);
  });

  test("an unselected unresolved wrong proposal requires review but is not harmful automation", () => {
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

    expect(metrics.harmfulSelected).toBe(0);
    expect(metrics.reviewRequired).toBe(1);
  });

  test("unselected non-ledger evidence is reported separately without entering release review denominators", () => {
    const expected = expectedRow({ rowRole: "ui_metadata", safetyClass: "non_ledger", expectedProposal: null });
    const metrics = scoreImportRecognition([expected], [actualRow({ proposal: { ...actualRow().proposal!, selected: false } })]);

    expect(metrics.harmfulSelected).toBe(0);
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
    expect(metrics.harmfulSelected).toBe(0);
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
  test("passes only when a baseline harmful selection becomes a required candidate safety review", () => {
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
          selected: false,
          disposition: "unresolved",
          reviewReasons: ["possible_transfer"],
        },
      }),
    ] as unknown as ActualImportRecognitionRow[];

    const gate = gateImportRecognition(expected, baseline, candidate);

    expect(gate.passed).toBe(true);
    expect(gate.transitions).toMatchObject({ attributableSafety: 1, unexplainedNewReviews: 0 });
  });

  test("uses fail-closed no-regression when baseline harmfulSelected is zero", () => {
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
      "harmful_selected_regression_from_zero",
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
      actualRow({ proposal: { ...actualRow().proposal!, selected: false, reviewReasons: ["possible_transfer"] } }),
      actualRow({ id: "unexpected", proposal: { ...actualRow().proposal!, selected: false, reviewReasons: ["unknown_kind"] } }),
    ] as unknown as ActualImportRecognitionRow[];

    const gate = gateImportRecognition(expected, baseline, candidate);

    expect(gate.transitions.attributableSafety).toBe(1);
    expect(gate.candidate.reviewBreakdown.unexpected).toBe(1);
  });

  test("actual row relabeling cannot hide a harmful selected proposal", () => {
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

    expect(scoreImportRecognition(expected, [relabelled]).harmfulSelected).toBe(1);
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

  test("gates every immutable fact independently and rejects unexplained new reviews", () => {
    const safe = expectedRow();
    expect(gateImportRecognition([safe], [actualRow()], [actualRow({ amount: 1300 })]).reasons).toContain("amount_accuracy_regression");

    const review = expectedRow({ safetyClass: "review_only", requiredSafetyReasons: ["possible_ocr_error"] });
    const decision = gateImportRecognition(
      [review],
      [actualRow()],
      [actualRow({ proposal: { ...actualRow().proposal!, selected: false, reviewReasons: ["possible_ocr_error"] } })],
    );
    expect(decision.transitions.unexplainedNewReviews).toBe(1);
    expect(decision.reasons).toContain("unexplained_review_transition");
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

describe("recognition evaluator adapters", () => {
  test("only a real OpenAI comparison can receive the release-success status", async () => {
    const evaluator = (await import("../evaluate-import-recognition")) as unknown as {
      comparisonReleaseStatus?: (
        transport: "openai" | "injected-test",
        criteriaPassed: boolean,
        reasons: string[],
      ) => { releaseEligible: boolean; passed: boolean; reasons: string[]; exitCode: number };
    };
    expect(typeof evaluator.comparisonReleaseStatus).toBe("function");

    expect(evaluator.comparisonReleaseStatus!("openai", true, [])).toEqual({ releaseEligible: true, passed: true, reasons: [], exitCode: 0 });
    expect(evaluator.comparisonReleaseStatus!("openai", false, ["unsafe_row_constraint_failed"])).toEqual({
      releaseEligible: false,
      passed: false,
      reasons: ["unsafe_row_constraint_failed"],
      exitCode: 1,
    });
    expect(evaluator.comparisonReleaseStatus!("injected-test", true, [])).toEqual({
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
      ]),
    ).toEqual({
      manifestPath: "/private/manifest.json",
      mode: "compare",
      baselineSourceTree: "/repo/main",
      candidateSourceTree: "/repo/worktree",
    });
    expect(() => parseEvalArgs(["--manifest", "/private/manifest.json", "--mode", "compare", "--baseline-source-tree", "/repo/main"])).toThrow(
      "--candidate-source-tree",
    );
  });

  test("CLI requires an explicit manifest, mode, and source tree", () => {
    expect(parseEvalArgs(["--manifest", "/private/manifest.json", "--mode", "baseline", "--source-tree", "/repo/main"])).toEqual({
      manifestPath: "/private/manifest.json",
      mode: "baseline",
      sourceTree: "/repo/main",
    });
    expect(() => parseEvalArgs(["--manifest", "/private/manifest.json", "--mode", "candidate"])).toThrow("--source-tree");
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
    const rows = [manifestRow({ id: "pending", candidatePosition: { imageIndex: 1, visualOrder: 3 }, baselineIndex: null })];

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
          postingStatus: "pending",
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
          disposition: "pending",
          reviewReasons: ["pending_or_declined"],
          type: "expense",
          isRefund: false,
          toAccountId: null,
          envelopeId: null,
          categoryId: null,
        },
      ],
    });

    expect(actual[0]).toEqual({
      id: "fixture:pending",
      date: "2026-08-15",
      amount: 1299,
      currency: "EUR",
      direction: "debit",
      semanticKind: "fee",
      relation: { kind: "fee_for", rowId: "fixture:pending" },
      proposal: {
        selected: false,
        disposition: "pending",
        reviewReasons: ["pending_or_declined"],
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
            sourceRef: "MARKET",
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
        safetyClass: "review_only",
        requiredSafetyReasons: ["pending_or_declined"],
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
        safetyClass: "review_only",
        requiredSafetyReasons: ["pending_or_declined"],
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
      rows: [manifestRow({ id: "desktop-purchase", currency: "USD", baselineIndex: null })],
    };

    expect(parseRecognitionManifest({ version: 1, fixtures: [mobile, desktop] }).fixtures).toHaveLength(2);
    expect(() =>
      parseRecognitionManifest({
        version: 1,
        fixtures: [{ ...mobile, rows: mobile.rows.filter((row) => row.semanticKind !== "salary") }, desktop],
      }),
    ).toThrow("coverage");
  });
});
