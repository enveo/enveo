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
/**
 * Screenshots a window shares with the previous one. Bank histories show a date divider once
 * per day, so the first entries of a scroll-order screenshot usually sit BELOW their divider —
 * the model dates them from the previous screenshot. A window that starts cold has no such
 * context (dates come back null and overlap goes undetected), so every later window re-reads
 * the last screenshot of the previous window and drops that screenshot's rows from its own
 * output: the model sees the divider and the repeated entries exactly as inside one window.
 */
export const IMPORT_JOB_CHUNK_OVERLAP = 1;

export interface ImportImageChunk {
  index: number;
  /** First absolute image position (inclusive) — for a later window this is the shared screenshot. */
  start: number;
  /** Last absolute image position (exclusive). */
  end: number;
  /** Leading positions that belong to the previous window (context only; their rows are dropped). */
  leadOverlap: number;
}

export function importImageChunks(imageCount: number, chunkSize = IMPORT_JOB_CHUNK_SIZE, overlap = IMPORT_JOB_CHUNK_OVERLAP): ImportImageChunk[] {
  if (!Number.isInteger(imageCount) || imageCount < 0) throw new Error("invalid import image count");
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error("invalid import chunk size");
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= chunkSize) throw new Error("invalid import chunk overlap");
  if (imageCount <= chunkSize) return imageCount === 0 ? [] : [{ index: 0, start: 0, end: imageCount, leadOverlap: 0 }];
  const stride = chunkSize - overlap;
  const chunks: ImportImageChunk[] = [];
  for (let start = 0; start === 0 || start + overlap < imageCount; start += stride) {
    chunks.push({ index: chunks.length, start, end: Math.min(imageCount, start + chunkSize), leadOverlap: start === 0 ? 0 : overlap });
  }
  return chunks;
}

/** Window ranges recorded by a durable runner become the layout again (legacy jobs kept
 *  non-overlapping windows; nothing here assumes the current stride). */
export function importChunkLayout(ranges: ReadonlyArray<{ index: number; start: number; end: number }>): ImportImageChunk[] {
  const ordered = [...ranges].sort((left, right) => left.index - right.index);
  return ordered.map((range, position) => {
    const previous = ordered[position - 1];
    return {
      index: range.index,
      start: range.start,
      end: range.end,
      leadOverlap: previous ? Math.max(0, Math.min(previous.end - range.start, range.end - range.start - 1)) : 0,
    };
  });
}

/** The window whose OWN output covers an absolute image position (shared screenshots belong to the earlier window). */
export function importChunkIndexOf(imageIndex: number, chunks: ReadonlyArray<ImportImageChunk>): number {
  const owner = chunks.find((chunk) => imageIndex >= chunk.start + chunk.leadOverlap && imageIndex < chunk.end);
  return owner?.index ?? chunks.find((chunk) => imageIndex >= chunk.start && imageIndex < chunk.end)?.index ?? 0;
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
  // Rows of the shared leading screenshot(s) were already produced by the previous window; they
  // served only as date/overlap context here. A relation into them is dropped with them — the
  // merged result lets reconciliation and the seam pass judge the repeat instead.
  const kept = batch.rows.filter((row) => row.imageIndex >= chunk.leadOverlap);
  const rowIds = new Set(kept.map((row) => row.rowId));
  return {
    rows: kept.map((row) => ({
      ...row,
      rowId: importChunkRowId(chunk.index, row.rowId),
      imageIndex: row.imageIndex + chunk.start,
      relation: row.relation && rowIds.has(row.relation.rowId) ? { kind: row.relation.kind, rowId: importChunkRowId(chunk.index, row.relation.rowId) } : null,
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
export function findImportSeamPairs(rows: ReadonlyArray<ImportExtractRow>, chunks: ReadonlyArray<ImportImageChunk>): ImportSeamPair[] {
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
    const chunk = importChunkIndexOf(row.imageIndex, chunks);
    const text = seamText(row);
    const alreadyLinked = row.relation?.kind === "duplicate_of" ? row.relation.rowId : null;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const earlier = candidates[index]!;
      if (importChunkIndexOf(earlier.imageIndex, chunks) === chunk) continue;
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
export function findImportSeamDatelessRepeats(rows: ReadonlyArray<ImportExtractRow>, chunks: ReadonlyArray<ImportImageChunk>): ImportSeamPair[] {
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
    const chunk = importChunkIndexOf(row.imageIndex, chunks);
    const earlier = (datedByText.get(key) ?? []).filter((candidate) => importChunkIndexOf(candidate.imageIndex, chunks) !== chunk).at(-1);
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

/* ── Deterministic repair of what the model cannot be trusted with: relation targets and dates ── */

const isFinancialTwinCandidate = (row: ImportExtractRow): boolean =>
  row.rowRole === "financial_event" && row.amount !== null && row.amount > 0 && row.currency !== null;

/** Identity of a visibly repeated entry: its text plus the facts that never differ between two
 *  captures. The sign is NOT part of it: a pending entry often shows none, and the same entry
 *  can be read with and without one; a visible contradiction is filtered out separately. */
const twinKey = (row: ImportExtractRow): string => `${seamText(row)}|${row.amount}|${row.currency}`;
const compatibleDirections = (left: ImportExtractRow, right: ImportExtractRow): boolean =>
  left.direction === "unknown" || right.direction === "unknown" || left.direction === right.direction;

const ordered = (rows: ReadonlyArray<ImportExtractRow>): ImportExtractRow[] =>
  rows
    .map((row, inputOrder) => ({ row, inputOrder }))
    .sort(byScreenshotOrder)
    .map(({ row }) => row);

const twinIndex = (rows: ReadonlyArray<ImportExtractRow>): Map<string, ImportExtractRow[]> => {
  const index = new Map<string, ImportExtractRow[]>();
  for (const row of rows) {
    if (!isFinancialTwinCandidate(row)) continue;
    const key = twinKey(row);
    index.set(key, [...(index.get(key) ?? []), row]);
  }
  return index;
};

const seamPair = (left: ImportExtractRow, right: ImportExtractRow): { earlierRowId: string; laterRowId: string } => {
  const leftFirst = left.imageIndex - right.imageIndex || left.visualOrder - right.visualOrder;
  return leftFirst <= 0 ? { earlierRowId: left.rowId, laterRowId: right.rowId } : { earlierRowId: right.rowId, laterRowId: left.rowId };
};

export interface ImportRelationRepair {
  batch: ImportExtractBatch;
  /** Same visible entry with two different dates: review evidence, never a silent link or drop. */
  unresolved: Array<{ earlierRowId: string; laterRowId: string }>;
}

/**
 * The model's `duplicate_of` targets are unreliable when they point FORWARD to rows it has not
 * emitted yet (observed: off by one or two, landing on an unrelated pending row and hiding a real
 * top-up). A duplicate claim is only kept when its target has the same amount and currency and
 * sits in another screenshot; otherwise the claim is re-pointed at the ONE row that repeats this
 * row's text and facts in another screenshot, surfaced for review when that twin carries a
 * different date, and dropped when no such twin exists. Other relation kinds are left to the
 * fact checks in `validateImportExtraction`.
 */
export function repairImportRelations(batch: ImportExtractBatch): ImportRelationRepair {
  const rowsById = new Map(batch.rows.map((row) => [row.rowId, row]));
  const twins = twinIndex(batch.rows);
  const unresolved: Array<{ earlierRowId: string; laterRowId: string }> = [];
  const rows = batch.rows.map((row): ImportExtractRow => {
    if (row.relation?.kind !== "duplicate_of") return row;
    const target = rowsById.get(row.relation.rowId);
    // Two rows naming each other as the duplicate would both be dropped and the entry lost:
    // the earlier capture is the original, so only the later one keeps the claim.
    if (target?.relation?.kind === "duplicate_of" && target.relation.rowId === row.rowId && seamPair(row, target).earlierRowId === row.rowId) {
      return { ...row, relation: null };
    }
    const plausible =
      target !== undefined &&
      target.rowId !== row.rowId &&
      target.imageIndex !== row.imageIndex &&
      target.amount === row.amount &&
      target.currency === row.currency;
    if (plausible) return row;
    const candidates = isFinancialTwinCandidate(row)
      ? (twins.get(twinKey(row)) ?? []).filter((twin) => twin.rowId !== row.rowId && twin.imageIndex !== row.imageIndex && compatibleDirections(row, twin))
      : [];
    if (candidates.length !== 1) return { ...row, relation: null };
    const twin = candidates[0]!;
    if (row.date !== null && twin.date !== null && row.date !== twin.date) {
      unresolved.push(seamPair(row, twin));
      return { ...row, relation: null };
    }
    return { ...row, relation: { kind: "duplicate_of" as const, rowId: twin.rowId } };
  });
  return { batch: { rows }, unresolved };
}

const isDateDivider = (row: ImportExtractRow): boolean => row.rowRole === "ui_metadata" && isCalendarDate(row.date);

/** Rows of one screenshot in visual order, split at its date dividers. */
interface ScreenshotLayout {
  imageIndex: number;
  rows: ImportExtractRow[];
  /** Rows before the first date divider (dated only by a divider outside this screenshot). */
  leading: ImportExtractRow[];
  /** Rows after the last date divider. */
  trailing: ImportExtractRow[];
  lastDividerDate: string | null;
}

const layoutScreenshots = (rows: ReadonlyArray<ImportExtractRow>): Map<number, ScreenshotLayout> => {
  const byImage = new Map<number, ImportExtractRow[]>();
  for (const row of ordered(rows)) byImage.set(row.imageIndex, [...(byImage.get(row.imageIndex) ?? []), row]);
  const layouts = new Map<number, ScreenshotLayout>();
  for (const [imageIndex, imageRows] of byImage) {
    const firstDivider = imageRows.findIndex(isDateDivider);
    const lastDivider = imageRows.map(isDateDivider).lastIndexOf(true);
    layouts.set(imageIndex, {
      imageIndex,
      rows: imageRows,
      leading: firstDivider === -1 ? imageRows : imageRows.slice(0, firstDivider),
      trailing: lastDivider === -1 ? [] : imageRows.slice(lastDivider + 1),
      lastDividerDate: lastDivider === -1 ? null : imageRows[lastDivider]!.date,
    });
  }
  return layouts;
};

/**
 * Which neighbouring screenshot continues ABOVE a given one, judged from the overlap the model
 * read twice: an entry at the top of screenshot k that repeats at the bottom of k+1 means k+1
 * shows the list segment above k. Screenshots are taken in one scrolling direction, so one vote
 * per overlapping pair decides for the whole job; a tie decides nothing.
 */
function screenshotAboveOffset(layouts: ReadonlyMap<number, ScreenshotLayout>, rows: ReadonlyArray<ImportExtractRow>): 1 | -1 | null {
  const twins = twinIndex(rows);
  let votes = 0;
  for (const group of twins.values()) {
    for (const left of group) {
      for (const right of group) {
        if (right.imageIndex !== left.imageIndex + 1 || !compatibleDirections(left, right)) continue;
        const lower = layouts.get(left.imageIndex)!;
        const upper = layouts.get(right.imageIndex)!;
        if (lower.leading.includes(left) && upper.trailing.includes(right)) votes += 1;
        else if (lower.trailing.includes(left) && upper.leading.includes(right)) votes -= 1;
      }
    }
  }
  return votes > 0 ? 1 : votes < 0 ? -1 : null;
}

/**
 * Fills dates the model left empty, from evidence the merged screenshots already contain:
 *
 * 1. an entry repeated text-for-text in the ADJACENT screenshot with a date is the same entry
 *    seen twice — it takes that date and is linked as its duplicate;
 * 2. entries above the first date divider of a screenshot share one divider (the one that
 *    scrolled out of view), so a date known for any of them holds for all of them;
 * 3. that off-screen divider is the LAST divider of the screenshot that continues above, when
 *    the overlap evidence says which neighbour that is; screenshots without any divider are
 *    walked through.
 *
 * Every filled date is marked `dateInferred` so the review can say so. Nothing else is touched:
 * a date the model did read, right or wrong, stays the model's.
 */
export function inferImportDates(batch: ImportExtractBatch): ImportExtractBatch {
  const rows = batch.rows.map((row) => ({ ...row }));
  const byId = new Map(rows.map((row) => [row.rowId, row]));
  const set = (row: ImportExtractRow, date: string) => {
    const target = byId.get(row.rowId)!;
    target.date = date;
    target.dateInferred = true;
  };

  // 1. Adjacent twins.
  const twins = twinIndex(rows);
  for (const group of twins.values()) {
    for (const row of group) {
      if (row.date !== null) continue;
      const dated = group.filter((twin) => twin.date !== null && Math.abs(twin.imageIndex - row.imageIndex) === 1 && compatibleDirections(row, twin));
      const dates = new Set(dated.map((twin) => twin.date));
      if (dates.size !== 1) continue;
      set(row, dated[0]!.date!);
      const later = seamPair(row, dated[0]!).laterRowId;
      const laterRow = byId.get(later)!;
      const earlierRowId = later === row.rowId ? dated[0]!.rowId : row.rowId;
      if (laterRow.relation === null) laterRow.relation = { kind: "duplicate_of", rowId: earlierRowId };
    }
  }

  // 2. One divider per leading block.
  const layouts = layoutScreenshots(rows);
  const fillLeading = (layout: ScreenshotLayout, date: string) => {
    for (const row of layout.leading) if (row.rowRole !== "ui_metadata" && row.date === null) set(row, date);
  };
  for (const layout of layouts.values()) {
    const known = new Set(layout.leading.filter((row) => row.rowRole !== "ui_metadata" && row.date !== null).map((row) => row.date));
    if (known.size === 1) fillLeading(layout, [...known][0]!);
  }

  // 3. The neighbour's last divider — for empty dates, and for dates the model took from the
  //    neighbour on the WRONG side (it reads screenshots as if they continued downward; when the
  //    overlap proves the list continues upward, a leading block dated like the divider at the
  //    bottom of the screenshot below actually belongs to the divider at the bottom of the one
  //    above). Only an exact match with the wrong side's divider is corrected: a date that
  //    matches neither is the model's reading and stays.
  const above = screenshotAboveOffset(layouts, rows);
  if (above !== null) {
    const lastDividerTowards = (from: ScreenshotLayout, step: 1 | -1): string | null => {
      let neighbour = layouts.get(from.imageIndex + step);
      while (neighbour && neighbour.lastDividerDate === null && neighbour.rows.length > 0) neighbour = layouts.get(neighbour.imageIndex + step);
      return neighbour?.lastDividerDate ?? null;
    };
    for (const layout of layouts.values()) {
      const leading = layout.leading.filter((row) => row.rowRole !== "ui_metadata");
      if (leading.length === 0) continue;
      const right = lastDividerTowards(layout, above);
      if (right === null) continue;
      const wrong = lastDividerTowards(layout, above === 1 ? -1 : 1);
      for (const row of leading) {
        if (row.date === null || (wrong !== null && wrong !== right && row.date === wrong)) set(row, right);
      }
    }
  }

  // 4. The same entry captured twice in NON-adjacent screenshots (the user's screenshots do not
  //    always tile the list; a pending entry can also be shown under two dates by the bank app).
  //    Identical text, amount and currency in another screenshot is one entry when at most one
  //    of the two sits under a divider of its own screenshot: that one is the anchor, the other
  //    (dated only by inference, or by the model's guess for a leading block) takes its date and
  //    is linked as its duplicate. Two rows each under their own divider with different dates are
  //    two transactions and are left alone; identical rows inside ONE screenshot are separate.
  const anchored = layoutScreenshots(rows);
  const underOwnDivider = (row: ImportExtractRow): boolean => !row.dateInferred && !anchored.get(row.imageIndex)!.leading.includes(row);
  for (const group of twinIndex(rows).values()) {
    if (group.length < 2) continue;
    const anchors = group.filter(underOwnDivider);
    for (const row of group) {
      if (underOwnDivider(row) || (row.relation !== null && row.relation.kind !== "fx_for")) continue;
      const matches = anchors.filter((anchor) => anchor.imageIndex !== row.imageIndex && compatibleDirections(row, anchor));
      const dates = new Set(matches.map((anchor) => anchor.date));
      if (matches.length === 0 || dates.size !== 1) continue;
      const anchor = matches[0]!;
      const target = byId.get(row.rowId)!;
      if (anchor.date !== null && target.date !== anchor.date) set(target, anchor.date);
      // The anchor already names this row as its original (the model's claim, or the overlap
      // rule above): one claim is enough, two would drop both.
      if (anchor.relation?.kind === "duplicate_of" && anchor.relation.rowId === row.rowId) continue;
      if (target.relation?.kind === "fx_for") {
        // The capture that carries the exchange line is the one worth keeping: the anchor lends
        // its date and steps back as the duplicate, so the conversion is not lost with it.
        const anchorRow = byId.get(anchor.rowId)!;
        if (anchorRow.relation === null) anchorRow.relation = { kind: "duplicate_of", rowId: row.rowId };
        continue;
      }
      target.relation = { kind: "duplicate_of", rowId: anchor.rowId };
    }
  }

  return { rows };
}
