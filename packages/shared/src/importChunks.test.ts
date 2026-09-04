import { describe, expect, it } from "bun:test";
import {
  applyImportSeamVerdicts,
  findImportSeamDatelessRepeats,
  findImportSeamPairs,
  IMPORT_JOB_CHUNK_SIZE,
  IMPORT_JOB_MAX_IMAGES,
  IMPORT_SEAM_MAX_MODEL_PAIRS,
  importEnrichmentBatches,
  importImageChunks,
  isChunkRowId,
  mergeChunkBatches,
  partitionImportSeamPairs,
  rebaseChunkBatch,
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
  it("cuts a job into fixed windows and keeps the last one short", () => {
    expect(importImageChunks(0)).toEqual([]);
    expect(importImageChunks(6)).toEqual([{ index: 0, start: 0, end: 6 }]);
    expect(importImageChunks(13)).toEqual([
      { index: 0, start: 0, end: 6 },
      { index: 1, start: 6, end: 12 },
      { index: 2, start: 12, end: 13 },
    ]);
    expect(importImageChunks(IMPORT_JOB_MAX_IMAGES)).toHaveLength(IMPORT_JOB_MAX_IMAGES / IMPORT_JOB_CHUNK_SIZE);
  });

  it("keeps a single-window job byte-identical to the pre-chunking contract", () => {
    // given: the model's own rowIds for a job of at most one window
    const batch = { rows: [row("r1", 0, { relation: { kind: "duplicate_of", rowId: "r0" } }), row("r0", 0)] };

    // when: rebased as the only chunk
    const rebased = rebaseChunkBatch(batch, { index: 0, start: 0, end: 2 }, 1);

    // then: nothing changes, so existing callers and the evaluation baseline see the same ids
    expect(rebased).toBe(batch);
    expect(isChunkRowId("r1")).toBe(false);
  });

  it("namespaces rowIds, rewrites in-chunk relations and offsets imageIndex for a later window", () => {
    const batch = { rows: [row("r1", 0, { relation: { kind: "fx_for", rowId: "r0" } }), row("r0", 1, { relation: { kind: "fee_for", rowId: "elsewhere" } })] };

    const rebased = rebaseChunkBatch(batch, { index: 2, start: 12, end: 14 }, 3);

    expect(rebased.rows.map((entry) => [entry.rowId, entry.imageIndex, entry.relation])).toEqual([
      ["c2:r1", 12, { kind: "fx_for", rowId: "c2:r0" }],
      ["c2:r0", 13, { kind: "fee_for", rowId: "elsewhere" }],
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
      row("c2:f", 13, { amount: 999 }), // different facts
    ];

    // c1:d repeats c1:c inside its own window (never deduplicated within a window), so it is
    // judged against the same earlier candidate; c2:e matches c1:d's text exactly and needs no model.
    expect(findImportSeamPairs(rows)).toEqual([
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

    expect(findImportSeamPairs(rows)).toEqual([]);
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

    expect(findImportSeamDatelessRepeats(rows)).toEqual([{ pairId: "d1", earlierRowId: "c0:a", laterRowId: "c1:b" }]);
  });
});

describe("enrichment batches", () => {
  it("splits rows into bounded requests and rejects a zero batch size", () => {
    expect(importEnrichmentBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(importEnrichmentBatches([], 2)).toEqual([]);
    expect(() => importEnrichmentBatches([1], 0)).toThrow();
  });
});
