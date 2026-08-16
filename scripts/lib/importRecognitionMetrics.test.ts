import { describe, expect, test } from "bun:test";
import {
  classifySourceAdapter,
  normalizeBaselineRecognition,
  normalizeCandidateRecognition,
  parseEvalArgs,
  parseRecognitionManifest,
  type RecognitionManifestRow,
} from "../evaluate-import-recognition";
import { type ActualImportRecognitionRow, type ExpectedImportRecognitionRow, scoreImportRecognition } from "./importRecognitionMetrics";

const expectedRow = (overrides: Partial<ExpectedImportRecognitionRow> = {}): ExpectedImportRecognitionRow => ({
  id: "purchase",
  material: true,
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
  },
  ...overrides,
});

describe("scoreImportRecognition", () => {
  test("row recall counts every labelled visible row, including omitted non-material evidence", () => {
    const expected = [expectedRow(), expectedRow({ id: "balance", material: false, expectedProposal: null })];

    const metrics = scoreImportRecognition(expected, [actualRow()]);

    expect(metrics.rowRecall).toEqual({ correct: 1, total: 2, rate: 0.5 });
    expect(metrics.materialRowRecall).toEqual({ correct: 1, total: 1, rate: 1 });
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

  test("missing material rows stay in fact and semantic denominators", () => {
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

  test("a wrong automatically selected type is harmful", () => {
    const metrics = scoreImportRecognition([expectedRow()], [actualRow({ proposal: { ...actualRow().proposal!, selected: true, type: "income" } })]);

    expect(metrics.harmfulSelected).toBe(1);
    expect(metrics.reviewRequired).toBe(0);
  });

  test("an unselected unresolved wrong proposal requires review but is not harmful automation", () => {
    const metrics = scoreImportRecognition(
      [expectedRow()],
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

  test("materiality prevents harmless presentation evidence from inflating safety counts", () => {
    const expected = expectedRow({ material: false, expectedProposal: null });
    const metrics = scoreImportRecognition([expected], [actualRow()]);

    expect(metrics.harmfulSelected).toBe(0);
    expect(metrics.factAccuracy.overall).toEqual({ correct: 0, total: 0, rate: null });
    expect(metrics.semanticKindAccuracy).toEqual({ correct: 0, total: 0, rate: null });
  });

  test("an empty corpus exposes zero denominators instead of reporting perfect accuracy", () => {
    const metrics = scoreImportRecognition([], []);

    expect(metrics.rowRecall).toEqual({ correct: 0, total: 0, rate: null });
    expect(metrics.materialRowRecall).toEqual({ correct: 0, total: 0, rate: null });
    expect(metrics.factAccuracy.overall).toEqual({ correct: 0, total: 0, rate: null });
    expect(metrics.semanticKindAccuracy).toEqual({ correct: 0, total: 0, rate: null });
    expect(metrics.relationPrecision).toEqual({ correct: 0, total: 0, rate: null });
    expect(metrics.harmfulSelected).toBe(0);
    expect(metrics.reviewRequired).toBe(0);
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
          semanticKind: "card_purchase",
          relation: null,
        },
      ],
      proposals: [
        {
          rowId: "model-chosen-id",
          selected: false,
          disposition: "pending",
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
      semanticKind: "card_purchase",
      relation: null,
      proposal: {
        selected: false,
        disposition: "pending",
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
          semanticKind: "merchant_refund",
          relation: null,
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
        { ...actualRow(), rowId: "one", imageIndex: 0, visualOrder: 0, rawTextLines: ["Moneyback"] },
        { ...actualRow(), rowId: "two", imageIndex: 0, visualOrder: 1, rawTextLines: ["Moneyback"] },
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
      rows: [manifestRow()],
    };

    expect(() =>
      parseRecognitionManifest({
        version: 1,
        fixtures: [{ ...fixture, rows: [manifestRow({ candidatePosition: { imageIndex: 1, visualOrder: 0 } })] }],
      }),
    ).toThrow("imageIndex");
    expect(() =>
      parseRecognitionManifest({
        version: 1,
        fixtures: [{ ...fixture, rows: [manifestRow({ relation: { kind: "fx_for", rowId: "missing" } })] }],
      }),
    ).toThrow("relation target");
    expect(() =>
      parseRecognitionManifest({
        version: 1,
        fixtures: [{ ...fixture, rows: [manifestRow({ baselineIndex: 1 })] }],
      }),
    ).toThrow("baseline indexes");
  });
});
