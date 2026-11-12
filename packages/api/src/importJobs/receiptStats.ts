import {
  IMPORT_CORRECTION_FIELDS,
  IMPORT_DUP_STATUSES,
  IMPORT_RELATION_KINDS,
  IMPORT_REVIEW_REASONS,
  type ImportCorrectionField,
  type ImportReceipt,
} from "@enveo/shared";

/** How the human treated rows that carried one flag. Counts only: a receipt's names and amounts
 *  never leave this function. */
export interface ImportFlagTally {
  rows: number;
  added: number;
  /** The human checked or unchecked the row against the recognized selection. */
  selectionChanged: number;
  /** The human changed a field other than the selection. */
  corrected: number;
}

export interface ImportReceiptStats {
  imports: number;
  rows: number;
  added: number;
  /** Rows whose recognized flags and corrections were recorded; every tally below counts these. */
  measuredRows: number;
  corrections: Record<ImportCorrectionField, number>;
  byReason: Record<(typeof IMPORT_REVIEW_REASONS)[number], ImportFlagTally>;
  byDuplicateStatus: Record<(typeof IMPORT_DUP_STATUSES)[number], ImportFlagTally>;
  byRelation: Record<(typeof IMPORT_RELATION_KINDS)[number], ImportFlagTally>;
  /** No reason, a new entry, no relation: a correction here is something the flags missed. */
  unflagged: ImportFlagTally;
  balance: {
    imports: number;
    screenshotFigure: { none: number; kept: number; changed: number };
    difference: { none: number; zero: number; nonzero: number };
    foreignAtFaceValue: number;
    suggested: number;
    declined: number;
    unmatched: number;
    applied: number;
    appliedChanges: number;
    reconcileAfter: number;
  };
}

const emptyTally = (): ImportFlagTally => ({ rows: 0, added: 0, selectionChanged: 0, corrected: 0 });
const tallies = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((key) => [key, emptyTally()])) as Record<K, ImportFlagTally>;

export function summarizeImportReceipts(receipts: readonly ImportReceipt[]): ImportReceiptStats {
  const stats: ImportReceiptStats = {
    imports: receipts.length,
    rows: 0,
    added: 0,
    measuredRows: 0,
    corrections: Object.fromEntries(IMPORT_CORRECTION_FIELDS.map((field) => [field, 0])) as Record<ImportCorrectionField, number>,
    byReason: tallies(IMPORT_REVIEW_REASONS),
    byDuplicateStatus: tallies(IMPORT_DUP_STATUSES),
    byRelation: tallies(IMPORT_RELATION_KINDS),
    unflagged: emptyTally(),
    balance: {
      imports: 0,
      screenshotFigure: { none: 0, kept: 0, changed: 0 },
      difference: { none: 0, zero: 0, nonzero: 0 },
      foreignAtFaceValue: 0,
      suggested: 0,
      declined: 0,
      unmatched: 0,
      applied: 0,
      appliedChanges: 0,
      reconcileAfter: 0,
    },
  };
  for (const receipt of receipts) {
    for (const row of receipt.rows) {
      stats.rows++;
      if (row.added) stats.added++;
      if (row.reviewReasons === undefined || row.correctionFields === undefined) continue;
      stats.measuredRows++;
      for (const field of row.correctionFields) stats.corrections[field]++;
      const groups = [
        ...row.reviewReasons.map((reason) => stats.byReason[reason]),
        ...(row.duplicateStatus ? [stats.byDuplicateStatus[row.duplicateStatus]] : []),
        ...(row.relationKind ? [stats.byRelation[row.relationKind]] : []),
      ];
      if (row.reviewReasons.length === 0 && (row.duplicateStatus ?? "new") === "new" && !row.relationKind) groups.push(stats.unflagged);
      for (const tally of groups) {
        tally.rows++;
        if (row.added) tally.added++;
        if (row.correctionFields.includes("selection")) tally.selectionChanged++;
        if (row.correctionFields.some((field) => field !== "selection")) tally.corrected++;
      }
    }
    const check = receipt.balanceCheck;
    if (!check) continue;
    const balance = stats.balance;
    balance.imports++;
    balance.screenshotFigure[check.screenshotFigure]++;
    balance.difference[check.difference]++;
    if (check.foreignAtFaceValue) balance.foreignAtFaceValue++;
    if (check.reconcileAfter) balance.reconcileAfter++;
    for (const key of ["suggested", "declined", "unmatched", "applied", "appliedChanges"] as const) balance[key] += check[key];
  }
  return stats;
}
