/**
 * Screenshot-import chunking — PURE helpers shared by the server worker, the device-local
 * E2EE runner and the evaluation harness.
 *
 * WHY CHUNKS: the vision model's cost is dominated by OUTPUT tokens (every visible row with its
 * rawTextLines), so one request over 30 screenshots would need 45–90k completion tokens —
 * several times the vision timeout — and would fail all-or-nothing. A job therefore reads its
 * screenshots in fixed windows of IMPORT_JOB_CHUNK_SIZE, in parallel, and merges the extractions.
 * A job with at most one chunk behaves exactly as before (raw model rowIds, no seam pass).
 *
 * WHAT THE MODEL LOSES: cycle one compares the screenshots it can SEE for overlap. Across chunk
 * boundaries that comparison is rebuilt here: identical entries (date, amount, text) are already
 * caught by `reconcileImportProposals` (strong key), so the only remaining case is the same
 * posting facts with DIFFERENT text — those become "seam pairs" for one cheap text-only model
 * call (see `buildImportSeamPrompt`), bounded by IMPORT_SEAM_MAX_MODEL_PAIRS; the rest, and every
 * pair a failed seam call could not judge, is surfaced as `possible_duplicate` for review.
 */
import type { ImportExtractBatch, ImportExtractRow } from "./importRecognition";

/** Screenshots per job (upload contract, UI counter, E2EE local input). */
export const IMPORT_JOB_MAX_IMAGES = 30;
/** Screenshots per cycle-one request — the only batch size the recognition corpus has evidence for. */
export const IMPORT_JOB_CHUNK_SIZE = 6;
/** Seam pairs judged by the model in one call; pairs beyond this cap go straight to review. */
export const IMPORT_SEAM_MAX_MODEL_PAIRS = 40;
/** Rows per enrichment (cycle two) request; larger results are enriched in sequential batches. */
export const IMPORT_ENRICH_BATCH_SIZE = 80;

export interface ImportImageChunk {
  index: number;
  /** First absolute image position (inclusive). */
  start: number;
  /** Last absolute image position (exclusive). */
  end: number;
}

export function importImageChunks(imageCount: number, chunkSize = IMPORT_JOB_CHUNK_SIZE): ImportImageChunk[] {
  if (!Number.isInteger(imageCount) || imageCount < 0) throw new Error("invalid import image count");
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error("invalid import chunk size");
  const chunks: ImportImageChunk[] = [];
  for (let start = 0; start < imageCount; start += chunkSize) {
    chunks.push({ index: chunks.length, start, end: Math.min(imageCount, start + chunkSize) });
  }
  return chunks;
}

/** Chunk index of an absolute image position under the job's chunk size. */
export function importChunkIndexOf(imageIndex: number, chunkSize = IMPORT_JOB_CHUNK_SIZE): number {
  return Math.floor(imageIndex / chunkSize);
}

const CHUNK_ROW_PREFIX = /^c(\d+):/;

/** Model rowIds are only unique within one request; a multi-chunk job namespaces them. */
export function importChunkRowId(chunkIndex: number, rowId: string): string {
  return `c${chunkIndex}:${rowId}`;
}

/**
 * Rebases one chunk's extraction onto the job: absolute imageIndex, namespaced rowIds
 * (relations included). A single-chunk job is returned untouched so its rowIds stay the
 * model's own, exactly as before chunking existed.
 */
export function rebaseChunkBatch(batch: ImportExtractBatch, chunk: ImportImageChunk, chunkCount: number): ImportExtractBatch {
  if (chunkCount <= 1 && chunk.start === 0) return batch;
  const rowIds = new Set(batch.rows.map((row) => row.rowId));
  return {
    rows: batch.rows.map((row) => ({
      ...row,
      rowId: importChunkRowId(chunk.index, row.rowId),
      imageIndex: row.imageIndex + chunk.start,
      relation:
        row.relation && rowIds.has(row.relation.rowId) ? { kind: row.relation.kind, rowId: importChunkRowId(chunk.index, row.relation.rowId) } : row.relation,
    })),
  };
}

/** Merges rebased chunk batches in screenshot order; visualOrder is already normalized per image. */
export function mergeChunkBatches(batches: ReadonlyArray<ImportExtractBatch>): ImportExtractBatch {
  const rows = batches.flatMap((batch) => batch.rows);
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.rowId)) throw new Error(`duplicate rowId across chunks: ${row.rowId}`);
    seen.add(row.rowId);
  }
  return {
    rows: rows
      .map((row, inputOrder) => ({ row, inputOrder }))
      .sort(byScreenshotOrder)
      .map(({ row }) => row),
  };
}

const byScreenshotOrder = (left: { row: ImportExtractRow; inputOrder: number }, right: { row: ImportExtractRow; inputOrder: number }): number =>
  left.row.imageIndex - right.row.imageIndex || left.row.visualOrder - right.row.visualOrder || left.inputOrder - right.inputOrder;

/** Whether a row carries a chunk namespace (multi-chunk job). */
export function isChunkRowId(rowId: string): boolean {
  return CHUNK_ROW_PREFIX.test(rowId);
}

export interface ImportSeamPair {
  pairId: string;
  earlierRowId: string;
  laterRowId: string;
}

const seamText = (row: ImportExtractRow): string => row.rawTextLines.join("\n").trim().toLowerCase();

const isCalendarDate = (value: string | null): value is string => value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value);

const comparableForSeam = (row: ImportExtractRow): boolean =>
  row.rowRole === "financial_event" &&
  isCalendarDate(row.date) &&
  row.amount !== null &&
  Number.isInteger(row.amount) &&
  row.amount > 0 &&
  row.currency !== null &&
  row.direction !== "unknown";

const seamKey = (row: ImportExtractRow): string => `${row.date}|${row.amount}|${row.currency}|${row.direction}`;

/**
 * Cross-chunk pairs with identical posting facts but different visible text — the only
 * overlap the merged extraction cannot settle deterministically. Identical text is left to
 * `reconcileImportProposals`, which already declines the later occurrence as an existing row.
 * Pairs are emitted in screenshot order, each later row paired with its nearest earlier
 * candidate only, so one repeated amount cannot explode into a quadratic pair list.
 */
export function findImportSeamPairs(rows: ReadonlyArray<ImportExtractRow>, chunkSize = IMPORT_JOB_CHUNK_SIZE): ImportSeamPair[] {
  const ordered = rows
    .map((row, inputOrder) => ({ row, inputOrder }))
    .sort(byScreenshotOrder)
    .map(({ row }) => row)
    .filter(comparableForSeam);
  const earlierByKey = new Map<string, ImportExtractRow[]>();
  const pairs: ImportSeamPair[] = [];
  for (const row of ordered) {
    const key = seamKey(row);
    const candidates = earlierByKey.get(key) ?? [];
    const chunk = importChunkIndexOf(row.imageIndex, chunkSize);
    const text = seamText(row);
    const alreadyLinked = row.relation?.kind === "duplicate_of" ? row.relation.rowId : null;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const earlier = candidates[index]!;
      if (importChunkIndexOf(earlier.imageIndex, chunkSize) === chunk) continue;
      if (seamText(earlier) === text) break;
      if (alreadyLinked === earlier.rowId) break;
      pairs.push({ pairId: `${pairs.length + 1}`, earlierRowId: earlier.rowId, laterRowId: row.rowId });
      break;
    }
    candidates.push(row);
    earlierByKey.set(key, candidates);
  }
  return pairs;
}

/**
 * A window often starts below its date divider, so the model reads the first entries of the
 * next window WITHOUT a date. Such a row that repeats, text for text, an earlier dated row of
 * another window with the same amount is almost certainly the overlap captured twice, but no
 * fact may be invented for it: it is surfaced as an unresolved seam pair (review evidence) and
 * left to the human, never linked or dated.
 */
export function findImportSeamDatelessRepeats(rows: ReadonlyArray<ImportExtractRow>, chunkSize = IMPORT_JOB_CHUNK_SIZE): ImportSeamPair[] {
  const ordered = rows
    .map((row, inputOrder) => ({ row, inputOrder }))
    .sort(byScreenshotOrder)
    .map(({ row }) => row)
    .filter((row) => row.rowRole === "financial_event" && row.amount !== null && row.amount > 0 && row.currency !== null && row.direction !== "unknown");
  const datedByText = new Map<string, ImportExtractRow[]>();
  const repeats: ImportSeamPair[] = [];
  for (const row of ordered) {
    const key = `${seamText(row)}|${row.amount}|${row.currency}|${row.direction}`;
    if (isCalendarDate(row.date)) {
      datedByText.set(key, [...(datedByText.get(key) ?? []), row]);
      continue;
    }
    if (row.date !== null) continue;
    const chunk = importChunkIndexOf(row.imageIndex, chunkSize);
    const earlier = (datedByText.get(key) ?? []).filter((candidate) => importChunkIndexOf(candidate.imageIndex, chunkSize) !== chunk).at(-1);
    if (earlier) repeats.push({ pairId: `d${repeats.length + 1}`, earlierRowId: earlier.rowId, laterRowId: row.rowId });
  }
  return repeats;
}

/** Splits the seam pairs into the model-judged window and the overflow that goes to review. */
export function partitionImportSeamPairs(
  pairs: ReadonlyArray<ImportSeamPair>,
  limit = IMPORT_SEAM_MAX_MODEL_PAIRS,
): { judged: ImportSeamPair[]; overflow: ImportSeamPair[] } {
  return { judged: pairs.slice(0, limit), overflow: pairs.slice(limit) };
}

/** Marks the later row of every confirmed pair as a duplicate of its earlier occurrence. */
export function applyImportSeamVerdicts(
  batch: ImportExtractBatch,
  pairs: ReadonlyArray<ImportSeamPair>,
  verdicts: ReadonlyMap<string, boolean>,
): ImportExtractBatch {
  const duplicateOf = new Map<string, string>();
  for (const pair of pairs) {
    if (verdicts.get(pair.pairId) === true) duplicateOf.set(pair.laterRowId, pair.earlierRowId);
  }
  if (duplicateOf.size === 0) return batch;
  return {
    rows: batch.rows.map((row) => {
      const earlierRowId = duplicateOf.get(row.rowId);
      return earlierRowId === undefined ? row : { ...row, relation: { kind: "duplicate_of", rowId: earlierRowId } };
    }),
  };
}

/** Batches rows for cycle two so one enrichment request never exceeds the size guard. */
export function importEnrichmentBatches<T>(rows: ReadonlyArray<T>, batchSize = IMPORT_ENRICH_BATCH_SIZE): T[][] {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("invalid import enrichment batch size");
  const batches: T[][] = [];
  for (let start = 0; start < rows.length; start += batchSize) batches.push(rows.slice(start, start + batchSize));
  return batches;
}
