import { describe, expect, it } from "bun:test";
import {
  applyImportSeamVerdicts,
  findImportSeamDatelessRepeats,
  findImportSeamPairs,
  IMPORT_JOB_CHUNK_SIZE,
  IMPORT_JOB_MAX_IMAGES,
  IMPORT_SEAM_MAX_MODEL_PAIRS,
  importChunkIndexOf,
  importChunkLayout,
  importEnrichmentBatches,
  importImageChunks,
  inferImportDates,
  isChunkRowId,
  mergeChunkBatches,
  partitionImportSeamPairs,
  rebaseChunkBatch,
  repairImportRelations,
} from "./importChunks";
import type { ImportExtractRow } from "./importRecognition";

const row = (rowId: string, imageIndex: number, over: Partial<ImportExtractRow> = {}): ImportExtractRow => ({
  rowId,
  imageIndex,
  visualOrder: 0,
  rawTextLines: [`LIDL ${rowId}`],
  date: "2026-08-07",
  amount: 1234,
  currency: "PLN",
  direction: "debit",
  postingStatus: "posted",
  rowRole: "financial_event",
  semanticKind: "card_purchase",
  relation: null,
  confidence: "high",
  reviewReasons: [],
  ...over,
});

describe("screenshot windows", () => {
  it("cuts a job into windows that share one screenshot with the previous window", () => {
    expect(importImageChunks(0)).toEqual([]);
    expect(importImageChunks(6)).toEqual([{ index: 0, start: 0, end: 6, leadOverlap: 0 }]);
    expect(importImageChunks(7)).toEqual([
      { index: 0, start: 0, end: 6, leadOverlap: 0 },
      { index: 1, start: 5, end: 7, leadOverlap: 1 },
    ]);
    expect(importImageChunks(13)).toEqual([
      { index: 0, start: 0, end: 6, leadOverlap: 0 },
      { index: 1, start: 5, end: 11, leadOverlap: 1 },
      { index: 2, start: 10, end: 13, leadOverlap: 1 },
    ]);
    // A window that would only repeat the shared screenshot is never created.
    expect(importImageChunks(11)).toHaveLength(2);
    expect(importImageChunks(IMPORT_JOB_MAX_IMAGES)).toHaveLength(6);
    expect(importImageChunks(13, IMPORT_JOB_CHUNK_SIZE, 0).map((chunk) => [chunk.start, chunk.end])).toEqual([
      [0, 6],
      [6, 12],
      [12, 13],
    ]);
  });

  it("rebuilds a layout from recorded ranges, legacy non-overlapping ones included", () => {
    expect(
      importChunkLayout([
        { index: 1, start: 5, end: 11 },
        { index: 0, start: 0, end: 6 },
      ]),
    ).toEqual([
      { index: 0, start: 0, end: 6, leadOverlap: 0 },
      { index: 1, start: 5, end: 11, leadOverlap: 1 },
    ]);
    expect(
      importChunkLayout([
        { index: 0, start: 0, end: 6 },
        { index: 1, start: 6, end: 7 },
      ])[1]!.leadOverlap,
    ).toBe(0);
    const chunks = importImageChunks(13);
    expect([0, 5, 6, 10, 11, 12].map((image) => importChunkIndexOf(image, chunks))).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it("keeps a single-window job byte-identical to the pre-chunking contract", () => {
    // given: the model's own rowIds for a job of at most one window
    const batch = { rows: [row("r1", 0, { relation: { kind: "duplicate_of", rowId: "r0" } }), row("r0", 0)] };

    // when: rebased as the only chunk
    const rebased = rebaseChunkBatch(batch, { index: 0, start: 0, end: 2, leadOverlap: 0 }, 1);

    // then: nothing changes, so existing callers and the evaluation baseline see the same ids
    expect(rebased).toBe(batch);
    expect(isChunkRowId("r1")).toBe(false);
  });

  it("namespaces rowIds, offsets imageIndex and drops the shared screenshot's rows for a later window", () => {
    // given: window 2 re-read image 10 (shared with window 1) for context, then read 11 and 12
    const batch = {
      rows: [
        row("ctx", 0),
        row("r1", 1, { relation: { kind: "fx_for", rowId: "r0" } }),
        row("r0", 2, { relation: { kind: "fee_for", rowId: "elsewhere" } }),
        row("rep", 1, { visualOrder: 1, relation: { kind: "duplicate_of", rowId: "ctx" } }),
      ],
    };

    const rebased = rebaseChunkBatch(batch, { index: 2, start: 10, end: 13, leadOverlap: 1 }, 3);

    // then: the context rows are gone and a relation into them is dropped, not dangling
    expect(rebased.rows.map((entry) => [entry.rowId, entry.imageIndex, entry.relation])).toEqual([
      ["c2:r1", 11, { kind: "fx_for", rowId: "c2:r0" }],
      ["c2:r0", 12, null],
      ["c2:rep", 11, null],
    ]);
    expect(isChunkRowId("c2:r1")).toBe(true);
  });

  it("merges windows in screenshot order and refuses colliding ids", () => {
    const merged = mergeChunkBatches([{ rows: [row("c1:a", 7), row("c1:b", 6)] }, { rows: [row("c0:a", 0)] }]);

    expect(merged.rows.map((entry) => entry.rowId)).toEqual(["c0:a", "c1:b", "c1:a"]);
    expect(() => mergeChunkBatches([{ rows: [row("x", 0)] }, { rows: [row("x", 6)] }])).toThrow("duplicate rowId across chunks");
  });
});

describe("seam pairs between windows", () => {
  it("pairs same facts with different text across windows only, nearest earlier row first", () => {
    const rows = [
      row("c0:a", 0, { rawTextLines: ["LIDL 123 Warszawa"] }),
      row("c0:b", 5, { rawTextLines: ["LIDL 123 W-wa"] }), // same window as c0:a — cycle one already compared them
      row("c1:c", 6, { rawTextLines: ["LIDL 123 WARSZAWA PL"] }), // different text → judged
      row("c1:d", 7, { rawTextLines: ["LIDL 123 WARSZAWA PL"] }), // identical to c1:c but same window
      row("c2:e", 12, { rawTextLines: ["LIDL 123 WARSZAWA PL"] }), // identical text to c1:d → reconcile handles it
      row("c2:f", 12, { amount: 999 }), // different facts
    ];

    // c1:d repeats c1:c inside its own window (never deduplicated within a window), so it is
    // judged against the same earlier candidate; c2:e matches c1:d's text exactly and needs no model.
    expect(findImportSeamPairs(rows, importImageChunks(13))).toEqual([
      { pairId: "1", earlierRowId: "c0:b", laterRowId: "c1:c" },
      { pairId: "2", earlierRowId: "c0:b", laterRowId: "c1:d" },
    ]);
  });

  it("ignores rows without comparable posting facts, non-events and pairs the model already linked", () => {
    const rows = [
      row("c0:a", 0),
      row("c1:b", 6, { rawTextLines: ["other"], relation: { kind: "duplicate_of", rowId: "c0:a" } }),
      row("c1:c", 7, { rawTextLines: ["ui"], rowRole: "ui_metadata" }),
      row("c1:d", 8, { rawTextLines: ["no date"], date: null }),
      row("c1:e", 9, { rawTextLines: ["unknown direction"], direction: "unknown" }),
    ];

    expect(findImportSeamPairs(rows, importImageChunks(13))).toEqual([]);
  });

  it("caps the judged window and applies confirmed verdicts as duplicate links", () => {
    const pairs = Array.from({ length: IMPORT_SEAM_MAX_MODEL_PAIRS + 3 }, (_, index) => ({
      pairId: `${index + 1}`,
      earlierRowId: `c0:${index}`,
      laterRowId: `c1:${index}`,
    }));
    const { judged, overflow } = partitionImportSeamPairs(pairs);
    expect(judged).toHaveLength(IMPORT_SEAM_MAX_MODEL_PAIRS);
    expect(overflow).toHaveLength(3);

    const batch = { rows: [row("c0:a", 0), row("c1:b", 6, { rawTextLines: ["x"] }), row("c1:c", 7, { rawTextLines: ["y"] })] };
    const linked = applyImportSeamVerdicts(
      batch,
      [
        { pairId: "1", earlierRowId: "c0:a", laterRowId: "c1:b" },
        { pairId: "2", earlierRowId: "c0:a", laterRowId: "c1:c" },
      ],
      new Map([
        ["1", true],
        ["2", false],
      ]),
    );

    expect(linked.rows.map((entry) => entry.relation)).toEqual([null, { kind: "duplicate_of", rowId: "c0:a" }, null]);
    expect(applyImportSeamVerdicts(batch, [], new Map())).toBe(batch);
  });
});

describe("dateless repeats at a window edge", () => {
  it("flags a dateless first row of the next window that repeats an earlier dated row exactly", () => {
    const rows = [
      row("c0:a", 5, { rawTextLines: ["LIDL SP. Z O.O. 0421", "Karta ·· 4411"] }),
      row("c1:b", 6, { rawTextLines: ["LIDL SP. Z O.O. 0421", "Karta ·· 4411"], date: null }),
      row("c1:c", 6, { rawTextLines: ["LIDL SP. Z O.O. 0421", "Karta ·· 4411"], date: null, amount: 999 }),
      row("c0:d", 4, { rawTextLines: ["same window"], date: null }),
      row("c0:e", 3, { rawTextLines: ["same window"] }),
    ];

    expect(findImportSeamDatelessRepeats(rows, importImageChunks(7))).toEqual([{ pairId: "d1", earlierRowId: "c0:a", laterRowId: "c1:b" }]);
  });
});

describe("enrichment batches", () => {
  it("splits rows into bounded requests and rejects a zero batch size", () => {
    expect(importEnrichmentBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(importEnrichmentBatches([], 2)).toEqual([]);
    expect(() => importEnrichmentBatches([1], 0)).toThrow();
  });
});

describe("repairing the model's duplicate relations", () => {
  const divider = (rowId: string, imageIndex: number, visualOrder: number, date: string): ImportExtractRow =>
    row(rowId, imageIndex, { visualOrder, date, rowRole: "ui_metadata", amount: null, currency: null, direction: "unknown", rawTextLines: [date] });

  it("re-points a duplicate claim that landed on an unrelated row at the one row repeating the same entry", () => {
    // given: the model linked the 1000 top-up to a pending Lidl row (its ids were off by one)
    const rows = [
      row("r23", 8, {
        visualOrder: 1,
        amount: 100000,
        direction: "credit",
        date: "2026-09-05",
        rawTextLines: ["1 000.00 PLN +", "UAB ZEN.COM"],
        relation: { kind: "duplicate_of", rowId: "r37" },
      }),
      row("r37", 10, { visualOrder: 3, amount: 48342, postingStatus: "pending", rawTextLines: ["483.42 PLN", "LIDL"] }),
      row("r38", 10, { visualOrder: 4, amount: 100000, direction: "credit", date: "2026-09-05", rawTextLines: ["1 000.00 PLN +", "UAB ZEN.COM"] }),
    ];

    const repaired = repairImportRelations({ rows });

    expect(repaired.batch.rows[0]!.relation).toEqual({ kind: "duplicate_of", rowId: "r38" });
    expect(repaired.unresolved).toEqual([]);
  });

  it("keeps a plausible claim, drops one without any twin, and surfaces a twin with a different date for review", () => {
    const rows = [
      row("a", 0, { date: "2026-09-02", rawTextLines: ["8.00 PLN", "BAKERY"], amount: 800 }),
      row("b", 1, { date: "2026-09-02", rawTextLines: ["8.00 PLN", "BAKERY"], amount: 800, relation: { kind: "duplicate_of", rowId: "a" } }),
      row("c", 2, { date: "2026-09-04", rawTextLines: ["9.00 PLN", "NOBODY"], amount: 900, relation: { kind: "duplicate_of", rowId: "zz" } }),
      row("d", 3, { date: "2026-09-04", rawTextLines: ["8.00 PLN", "BAKERY"], amount: 800, relation: { kind: "duplicate_of", rowId: "c" } }),
    ];

    const repaired = repairImportRelations({ rows });

    expect(repaired.batch.rows.map((r) => r.relation)).toEqual([null, { kind: "duplicate_of", rowId: "a" }, null, null]);
    expect(repaired.unresolved).toEqual([]);
    // "d" repeats "a"/"b" but on another date — two twins, so it is not re-pointed; a single
    // twin on another date becomes a review pair instead:
    const single = repairImportRelations({ rows: [rows[0]!, rows[3]!] });
    expect(single.batch.rows[1]!.relation).toBeNull();
    expect(single.unresolved).toEqual([{ earlierRowId: "a", laterRowId: "d" }]);
  });

  it("never links a repeat inside one screenshot: repeated entries on one screen are separate transactions", () => {
    const rows = [
      row("a", 0, { visualOrder: 0, rawTextLines: ["5.00 PLN", "COFFEE"] }),
      row("b", 0, { visualOrder: 1, rawTextLines: ["5.00 PLN", "COFFEE"], relation: { kind: "duplicate_of", rowId: "nope" } }),
    ];
    expect(repairImportRelations({ rows }).batch.rows[1]!.relation).toBeNull();
  });

  describe("filling dates from overlapping screenshots", () => {
    it("dates a row from its twin in the adjacent screenshot and links the later one as the duplicate", () => {
      const rows = [
        row("i3-t1", 3, { visualOrder: 0, date: null, amount: 100000, direction: "credit", rawTextLines: ["1 000.00 PLN +", "UAB ZEN.COM"] }),
        row("i3-t2", 3, { visualOrder: 1, date: null, amount: 133907, direction: "unknown", rawTextLines: ["1 339.07 PLN", "UAB ZEN.COM"] }),
        row("i4-t1", 4, { visualOrder: 0, date: null, amount: 30850, rawTextLines: ["308.50 PLN", "notino"] }),
        divider("i4-m1", 4, 1, "2026-08-30"),
        row("i4-t5", 4, { visualOrder: 2, date: "2026-08-30", amount: 100000, direction: "credit", rawTextLines: ["1 000.00 PLN +", "UAB ZEN.COM"] }),
      ];

      const dated = inferImportDates({ rows });
      const byId = new Map(dated.rows.map((r) => [r.rowId, r]));

      expect(byId.get("i3-t1")).toMatchObject({ date: "2026-08-30", dateInferred: true });
      expect(byId.get("i4-t5")!.relation).toEqual({ kind: "duplicate_of", rowId: "i3-t1" });
      expect(byId.get("i4-t5")!.dateInferred).toBeUndefined();
    });

    it("gives every dateless row above a screenshot's first divider the date one of them already has", () => {
      const rows = [
        row("a", 0, { visualOrder: 0, date: "2026-08-30", rawTextLines: ["known"] }),
        row("b", 0, { visualOrder: 1, date: null, rawTextLines: ["unknown"] }),
        divider("m", 0, 2, "2026-08-29"),
        row("c", 0, { visualOrder: 3, date: null, rawTextLines: ["below the divider stays as the model left it"] }),
      ];
      const dated = inferImportDates({ rows }).rows;
      expect(dated[1]).toMatchObject({ date: "2026-08-30", dateInferred: true });
      expect(dated[3]!.date).toBeNull();
    });

    it("walks to the neighbour above when the overlap proves which way the screenshots go", () => {
      // given: screenshots ordered oldest-first (k+1 shows the segment above k); image 2 has
      // no divider at all, image 3 ends with the divider whose rows were cut off
      const rows = [
        row("i1-t1", 1, { visualOrder: 0, date: null, amount: 20000, rawTextLines: ["200.00 PLN", "KWIACIARNIA"] }),
        divider("i1-m1", 1, 1, "2026-08-28"),
        row("i1-t3", 1, { visualOrder: 2, date: "2026-08-28", amount: 3000, rawTextLines: ["30.00 PLN", "VET"] }),
        row("i2-t1", 2, { visualOrder: 0, date: null, amount: 3943, rawTextLines: ["39.43 PLN", "LIDL"] }),
        row("i2-t5", 2, { visualOrder: 1, date: null, amount: 20000, rawTextLines: ["200.00 PLN", "KWIACIARNIA"] }),
        row("i3-t3", 3, { visualOrder: 0, date: "2026-08-29", amount: 699, rawTextLines: ["6.99 PLN", "BIEDRONKA"] }),
        divider("i3-m1", 3, 1, "2026-08-29"),
        row("i4-t1", 4, { visualOrder: 0, date: null, amount: 30850, rawTextLines: ["308.50 PLN", "notino"] }),
        divider("i4-m1", 4, 1, "2026-08-30"),
        row("i4-t5", 4, { visualOrder: 2, date: "2026-08-30", amount: 46654, rawTextLines: ["466.54 PLN", "ORLEN"] }),
        divider("i5-m2", 5, 0, "2026-08-31"),
        row("i5-t4", 5, { visualOrder: 1, date: "2026-08-31", amount: 30850, rawTextLines: ["308.50 PLN", "notino"] }),
      ];

      const byId = new Map(inferImportDates({ rows }).rows.map((r) => [r.rowId, r]));

      // the notino overlap (top of 4, bottom of 5) votes "5 is above 4"
      expect(byId.get("i4-t1")).toMatchObject({ date: "2026-08-31", dateInferred: true });
      // image 2 has no divider: its rows and image 1's leading row take image 3's last divider
      expect(byId.get("i2-t1")).toMatchObject({ date: "2026-08-29", dateInferred: true });
      expect(byId.get("i2-t5")).toMatchObject({ date: "2026-08-29", dateInferred: true });
      expect(byId.get("i1-t1")).toMatchObject({ date: "2026-08-29", dateInferred: true });
      // dated rows are never rewritten
      expect(byId.get("i3-t3")!.dateInferred).toBeUndefined();
    });

    it("fills nothing when the screenshots give no evidence of their order", () => {
      const rows = [
        row("a", 0, { date: null }),
        divider("m", 1, 0, "2026-08-29"),
        row("b", 1, { visualOrder: 1, date: "2026-08-29", rawTextLines: ["other"] }),
      ];
      expect(inferImportDates({ rows }).rows[0]!.date).toBeNull();
    });
  });
});
