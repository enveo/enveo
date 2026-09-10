import {
  type BalanceMatchCandidate,
  type BalanceMatchChange,
  balanceMatchOptions,
  type ClientLedger,
  type ImportDupStatus,
  type ImportProposal,
  type ImportReviewReason,
  type ImportSemanticKind,
  importProposalBlockingReasons,
  isCalendarDate,
  parseDisplayAmount,
  type ReconciledImportProposal,
  type ReconciledImportRecognitionResult,
} from "@enveo/shared";
import type { EditedImportItem, ImportApplyItem, ImportApplyResponse, ImportItem } from "./api";
import { type Message, msg } from "./i18n";
import { importReviewItem, type LocalImportReviewItem, reviewedImportItemsForApply } from "./localImport";

export type ImportReviewDisposition = ImportProposal["disposition"];

export type ImportReviewDraftItem = Omit<ImportItem, "type" | "date" | "amount"> & {
  type: ImportItem["type"] | null;
  date: string | null;
  amount: number | null;
};

/** The apply boundary requires real calendar dates and integer money. */
export function isCompleteImportReviewItem(item: Pick<ImportReviewDraftItem, "date" | "amount" | "type"> | null | undefined): boolean {
  return (
    !!item && isCalendarDate(item.date) && Number.isSafeInteger(item.amount) && item.amount! > 0 && ["expense", "income", "transfer"].includes(item.type ?? "")
  );
}

export interface ImportReviewRow {
  draftItem?: ImportReviewDraftItem;
  rowId: string;
  disposition: ImportReviewDisposition;
  semanticKind: ImportSemanticKind;
  relation: ImportProposal["relation"];
  reviewReasons: ImportReviewReason[];
  requiresReview: boolean;
  blockingIssues: ImportBlockingIssue[];
  duplicateStatus: ImportDupStatus;
  alreadyApplied: boolean;
  sourceRef: string;
  rawTextLines: string[];
  date: string | null;
  amount: number | null;
  currency: string | null;
  include: boolean;
  editable: boolean;
  item: LocalImportReviewItem | null;
}

/** Keep explicit choices, but newly discovered duplicate evidence needs a fresh selection. */
export function reviewSelectionAfterRefresh(row: ImportReviewRow, previous: ImportReviewRow | undefined): boolean {
  if (row.duplicateStatus === "exists" || (row.duplicateStatus === "probable" && previous?.duplicateStatus !== "probable")) return false;
  return previous?.include ?? row.include;
}

export function visibleImportReviewRows<T extends Pick<ImportReviewRow, "disposition">>(rows: readonly T[]): { row: T; index: number; position: number }[] {
  const visible: { row: T; index: number; position: number }[] = [];
  rows.forEach((row, index) => {
    if (row.disposition !== "supporting") visible.push({ row, index, position: visible.length });
  });
  return visible;
}

export type ImportBlockingIssue = ImportReviewReason | "currency_mismatch" | "assignment_unavailable";

const REASON_MESSAGES: Record<ImportReviewReason, Message> = {
  missing_fact: msg("Missing date or amount"),
  unsupported_currency: msg("Unsupported currency"),
  inconsistent_direction: msg("Direction needs review"),
  possible_transfer: msg("Possible transfer"),
  unknown_transfer_endpoint: msg("Transfer account is unknown"),
  possible_ocr_error: msg("Possible recognition error"),
  history_conflict: msg("Conflicts with transaction history"),
  multiple_history_candidates: msg("Several history matches"),
  invalid_relation: msg("Related row is invalid"),
  impossible_fx: msg("FX amounts do not match"),
  relation_changes_ledger_shape: msg("Related rows could change the ledger"),
  fact_correction: msg("AI suggested changing an extracted fact"),
  pending_or_declined: msg("Declined by the bank"),
  unknown_posting_status: msg("Posting status is unknown"),
  unknown_kind: msg("Unknown transaction type"),
  possible_duplicate: msg("May repeat a row from another screenshot"),
  inferred_date: msg("Date taken from the neighbouring screenshot"),
  suspicious_text: msg("Text looks like an attempt to manipulate the import"),
  fx_converted: msg("Amount taken from the exchange line"),
};

export function importReviewReasonMessage(reason: string): Message {
  return REASON_MESSAGES[reason as ImportReviewReason] ?? msg("Needs review");
}

export interface ImportReviewBadge {
  label: Message;
  tone: "neutral" | "positive" | "warning";
}

export interface ImportReviewControlLabel {
  message: Message;
  values: { n: number };
}

/** Localizable, row-specific names for the native controls rendered by ImportSheet. */
export function reviewRowControlLabels(
  row: ImportReviewRow,
  index: number,
): { select: ImportReviewControlLabel | null; edit: ImportReviewControlLabel | null } {
  const canSelect = row.item !== null || row.editable;
  if (row.duplicateStatus === "exists" || !canSelect) return { select: null, edit: null };
  const values = { n: index + 1 };
  return {
    select: { message: msg("Select recognized row {n}"), values },
    edit: row.editable ? { message: msg("Edit item {n}"), values } : null,
  };
}

const dispositionBadge = (disposition: ImportReviewDisposition): ImportReviewBadge | null => {
  switch (disposition) {
    case "pending":
      return { label: msg("Pending — not added"), tone: "neutral" };
    case "declined":
      return { label: msg("Declined — not added"), tone: "neutral" };
    case "supporting":
      return { label: msg("Supporting detail — not a transaction"), tone: "neutral" };
    case "unresolved":
      return { label: msg("Unresolved — needs review"), tone: "warning" };
    case "candidate":
      return null;
  }
};

/** Concise, exhaustive display facts. Duplicate labels collapse without hiding reasons. */
export function reviewBadges(row: ImportReviewRow, edit?: EditedImportItem): ImportReviewBadge[] {
  const badges: ImportReviewBadge[] = [];
  const disposition = row.duplicateStatus === "exists" ? null : dispositionBadge(edit ? "candidate" : row.disposition);
  if (disposition) badges.push(disposition);
  if (row.relation?.kind === "fx_for" || row.semanticKind === "fx_conversion") badges.push({ label: msg("FX relation"), tone: "warning" });
  if (edit ? edit.isRefund : row.item?.isRefund || row.semanticKind === "merchant_refund" || row.semanticKind === "chargeback") {
    badges.push({ label: msg("Refund"), tone: "positive" });
  }
  if (row.semanticKind === "cashback_or_reward" && (!edit || edit.type === "income")) badges.push({ label: msg("Reward / income"), tone: "positive" });
  if (row.alreadyApplied) badges.push({ label: msg("Already added by this import"), tone: "neutral" });
  else if (row.duplicateStatus === "exists") badges.push({ label: msg("Already exists"), tone: "neutral" });
  if (row.duplicateStatus === "probable") badges.push({ label: msg("Probable duplicate"), tone: "warning" });
  if (!edit && row.blockingIssues.includes("assignment_unavailable")) badges.push({ label: msg("Saved assignment is unavailable"), tone: "warning" });
  for (const reason of row.reviewReasons) {
    if (edit && ["missing_fact", "unknown_kind", "inconsistent_direction", "unknown_transfer_endpoint", "fact_correction"].includes(reason)) continue;
    const label = importReviewReasonMessage(reason);
    badges.push({ label, tone: reason === "pending_or_declined" ? "neutral" : "warning" });
  }
  const unique = new Map<Message, ImportReviewBadge>();
  for (const badge of badges) unique.set(badge.label, badge);
  return [...unique.values()];
}

function completeCandidateItem(args: {
  proposal: ReconciledImportProposal;
  recognition: ReconciledImportRecognitionResult;
  ledger: ClientLedger;
  dryResult?: ImportApplyResponse["results"][number];
  duplicateStatus: ImportDupStatus;
  automaticEnvelopeId: string | null | undefined;
}): LocalImportReviewItem | null {
  const { proposal } = args;
  if (proposal.disposition !== "candidate" || proposal.date === null || proposal.amount === null || proposal.type === null) return null;
  const rowsById = new Map(args.recognition.rows.map((row) => [row.rowId, row]));
  const sourceRef = proposal.sourceRows
    .flatMap((rowId) => rowsById.get(rowId)?.rawTextLines ?? [])
    .join("\n")
    .trim();
  const envelopeNames = new Map(args.ledger.envelopes.map((envelope) => [envelope.id, envelope.name]));
  const categoryNames = new Map(args.ledger.categories.map((category) => [category.id, category.name]));
  const status = args.duplicateStatus === "new" ? "added" : args.duplicateStatus;
  const result: ImportApplyResponse["results"][number] = args.dryResult
    ? { ...args.dryResult, status }
    : {
        date: proposal.date,
        amount: proposal.amount,
        type: proposal.type,
        isRefund: proposal.isRefund,
        toAccountId: proposal.toAccountId,
        name: proposal.name,
        tag: proposal.tag,
        rawPlace: sourceRef || null,
        envelopeId: proposal.envelopeId,
        envelopeName: proposal.envelopeId ? (envelopeNames.get(proposal.envelopeId) ?? null) : null,
        categoryId: proposal.categoryId,
        categoryName: proposal.categoryId ? (categoryNames.get(proposal.categoryId) ?? null) : null,
        placeName: proposal.placeName,
        currency: proposal.currency ?? undefined,
        status,
      };
  const item = importReviewItem({ ...result, rawPlace: sourceRef || null }, args.automaticEnvelopeId);
  return { ...item, include: proposal.selected && item.include };
}

const effectiveDuplicateStatus = (
  recognitionStatus: ImportDupStatus,
  dryRunStatus: ImportApplyResponse["results"][number]["status"] | undefined,
): ImportDupStatus => {
  if (recognitionStatus === "exists" || dryRunStatus === "exists") return "exists";
  if (recognitionStatus === "probable" || dryRunStatus === "probable") return "probable";
  return "new";
};

/** Joins dry-run verdicts back onto recognition without dropping any raw row. */
export function buildImportReviewRows(args: {
  recognition: ReconciledImportRecognitionResult;
  ledger: ClientLedger;
  dryRunResults: ImportApplyResponse["results"];
  automaticEnvelopeId: string | null | undefined;
  budgetCurrency: string;
  appliedRowIds?: readonly string[];
  skippedRowIds?: readonly string[];
}): ImportReviewRow[] {
  const proposals = new Map(args.recognition.proposals.map((proposal) => [proposal.rowId, proposal]));
  const appliedRowIds = new Set(args.appliedRowIds ?? []);
  const skippedRowIds = new Set(args.skippedRowIds ?? []);
  let dryIndex = 0;
  return args.recognition.rows.map((rawRow) => {
    const proposal = proposals.get(rawRow.rowId);
    const alreadyApplied = appliedRowIds.has(rawRow.rowId);
    const sourceRef = (proposal?.sourceRows ?? [rawRow.rowId])
      .flatMap((rowId) => args.recognition.rows.find((row) => row.rowId === rowId)?.rawTextLines ?? [])
      .join("\n")
      .trim();
    if (!proposal) {
      return {
        rowId: rawRow.rowId,
        disposition: "unresolved",
        semanticKind: rawRow.semanticKind,
        relation: rawRow.relation,
        reviewReasons: ["missing_fact"],
        requiresReview: true,
        blockingIssues: ["missing_fact"],
        duplicateStatus: alreadyApplied ? "exists" : "new",
        alreadyApplied,
        sourceRef,
        rawTextLines: rawRow.rawTextLines,
        date: rawRow.date,
        amount: rawRow.amount,
        currency: rawRow.currency,
        include: false,
        editable: false,
        item: null,
      };
    }
    const receivesDryResult =
      proposal.selected && proposal.disposition === "candidate" && proposal.date !== null && proposal.amount !== null && proposal.type !== null;
    const dryResult = receivesDryResult ? args.dryRunResults[dryIndex++] : undefined;
    const duplicateStatus = alreadyApplied ? "exists" : effectiveDuplicateStatus(proposal.duplicateStatus, dryResult?.status);
    const item = completeCandidateItem({
      proposal,
      recognition: args.recognition,
      ledger: args.ledger,
      dryResult,
      duplicateStatus,
      automaticEnvelopeId: args.automaticEnvelopeId,
    });
    const reviewItem = duplicateStatus === "exists" ? null : item;
    const blockingIssues: ImportBlockingIssue[] = importProposalBlockingReasons(proposal);
    if ((proposal as ReconciledImportProposal & { assignmentUnavailable?: boolean }).assignmentUnavailable) blockingIssues.push("assignment_unavailable");
    if (proposal.currency && proposal.currency !== args.budgetCurrency) blockingIssues.push("currency_mismatch");
    return {
      rowId: rawRow.rowId,
      disposition: proposal.disposition,
      semanticKind: proposal.semanticKind,
      relation: proposal.relation,
      reviewReasons: proposal.reviewReasons,
      requiresReview: proposal.reviewReasons.length > 0 || duplicateStatus === "probable" || blockingIssues.length > 0,
      blockingIssues,
      duplicateStatus,
      alreadyApplied,
      sourceRef,
      rawTextLines: rawRow.rawTextLines,
      date: proposal.date,
      amount: proposal.amount,
      currency: proposal.currency,
      include: duplicateStatus === "new" && !skippedRowIds.has(rawRow.rowId) && reviewItem?.include === true,
      editable: duplicateStatus !== "exists" && (reviewItem !== null || (proposal.disposition === "unresolved" && rawRow.rowRole === "financial_event")),
      draftItem: {
        ...proposal,
        date: isCalendarDate(proposal.date) ? proposal.date : null,
        rawPlace: sourceRef || null,
        currency: proposal.currency ?? undefined,
      },
      item: reviewItem ? { ...reviewItem, include: reviewItem.include } : null,
    };
  });
}

/** The final allowlist boundary before TxnPayload planning. */
export function reviewedImportRowsForApply(args: {
  rows: ImportReviewRow[];
  edited: Record<number, EditedImportItem>;
  editedAutomaticDefaults: Record<number, boolean>;
}): ImportApplyItem[] {
  return args.rows.flatMap((row, index) => {
    if (!row.include || row.duplicateStatus === "exists") return [];
    const edit = args.edited[index];
    if (row.disposition !== "candidate" && !(row.disposition === "unresolved" && row.editable)) return [];
    if (!isCompleteImportReviewItem(edit ?? row.item)) throw new Error("import_review_incomplete");
    const item =
      row.item ??
      (edit
        ? {
            ...edit,
            tag: row.draftItem?.tag ?? "",
            currency: row.currency ?? undefined,
            rawPlace: row.sourceRef || null,
            status: "added" as const,
            include: true,
            automaticEnvelopeDefault: false,
          }
        : null);
    if (!item) throw new Error("import_review_incomplete");
    return reviewedImportItemsForApply({
      items: [{ ...item, include: true }],
      edited: edit ? { 0: edit } : {},
      editedAutomaticDefaults: { 0: args.editedAutomaticDefaults[index] ?? false },
    }).map((item) => ({ ...item, importRowId: row.rowId }));
  });
}

export interface ImportBalanceEffect {
  accountId: string;
  name: string;
  before: number;
  after: number;
  delta: number;
}

/**
 * How applying the currently selected rows would move each touched account. Balances come from
 * the caller at `currentMonth()` (account balances are global, never "as of the viewed month").
 * Only accounts whose balance actually changes are listed; the import's source account first.
 */
export function importBalanceEffect(args: {
  items: readonly ImportApplyItem[];
  defaultAccountId: string;
  accounts: ReadonlyArray<{ id: string; name: string; balance: number; archived?: boolean }>;
}): ImportBalanceEffect[] {
  const deltas = new Map<string, number>();
  const add = (accountId: string, amount: number) => deltas.set(accountId, (deltas.get(accountId) ?? 0) + amount);
  for (const item of args.items) {
    const accountId = item.accountId ?? args.defaultAccountId;
    if (item.type === "income") add(accountId, item.amount);
    else if (item.type === "expense") add(accountId, item.isRefund ? item.amount : -item.amount);
    else {
      add(accountId, -item.amount);
      if (item.toAccountId) add(item.toAccountId, item.amount);
    }
  }
  return args.accounts
    .filter((account) => (deltas.get(account.id) ?? 0) !== 0)
    .sort((left, right) => Number(right.id === args.defaultAccountId) - Number(left.id === args.defaultAccountId))
    .map((account) => {
      const delta = deltas.get(account.id) ?? 0;
      return { accountId: account.id, name: account.name, before: account.balance, after: account.balance + delta, delta };
    });
}

/** Truthful completion totals: each extracted exact duplicate is one skipped row, while
 * apply-time skips cover rows that became duplicates while the review remained open. */
export function importReviewDoneStats(rows: ImportReviewRow[], result: { added: number; skipped: number }): { added: number; dup: number } {
  return {
    added: result.added,
    dup: rows.filter((row) => row.duplicateStatus === "exists").length + result.skipped,
  };
}

/** Signed effect of one row on the import's source account when it is included (minor units). */
function sourceAccountEffect(item: ImportApplyItem, defaultAccountId: string): number {
  const accountId = item.accountId ?? defaultAccountId;
  if (item.type === "income") return accountId === defaultAccountId ? item.amount : 0;
  if (item.type === "expense") return accountId === defaultAccountId ? (item.isRefund ? item.amount : -item.amount) : 0;
  if (accountId === defaultAccountId) return -item.amount;
  return item.toAccountId === defaultAccountId ? item.amount : 0;
}

const reviewApplyItem = (row: ImportReviewRow, edit: EditedImportItem | undefined): ImportApplyItem | null =>
  edit ? { ...row.item, ...edit, tag: row.item?.tag ?? row.draftItem?.tag ?? "" } : row.item;

export interface ReviewBalanceMatchCandidate extends BalanceMatchCandidate {
  index: number;
  /** Flagged by the review (as opposed to merely left out). */
  doubtful: boolean;
}

/**
 * Rows the balance matcher may toggle: the ones the review already doubts (flagged, probable
 * duplicate) and the ones currently left out. Confident selected rows, rows without a complete
 * transaction and rows the user edited by hand stay exactly as they are. Doubtful rows come first
 * so the candidate cap keeps the most likely explanations.
 */
export function balanceMatchCandidatesForReview(args: {
  rows: ImportReviewRow[];
  edited: Record<number, EditedImportItem>;
  defaultAccountId: string;
}): ReviewBalanceMatchCandidate[] {
  const candidates: ReviewBalanceMatchCandidate[] = [];
  args.rows.forEach((row, index) => {
    if (row.duplicateStatus === "exists" || row.alreadyApplied) return;
    const edit = args.edited[index];
    if (!row.item && !edit) return;
    if (edit && row.include) return;
    const doubtful = row.requiresReview || row.duplicateStatus === "probable";
    if (!doubtful && row.include) return;
    const item = reviewApplyItem(row, edit);
    if (!item || !isCompleteImportReviewItem(item)) return;
    const effect = sourceAccountEffect(item, args.defaultAccountId);
    if (effect === 0) return;
    candidates.push({
      index,
      id: row.rowId,
      effect,
      included: row.include,
      flippable: item.type !== "transfer" && row.reviewReasons.includes("inconsistent_direction"),
      doubtful,
    });
  });
  return candidates.sort((left, right) => Number(right.doubtful) - Number(left.doubtful) || left.index - right.index);
}

/** Applies a found change set: inclusion flips are selection changes, a direction flip becomes an edit. */
export function applyBalanceMatchToReview(args: {
  rows: ImportReviewRow[];
  edited: Record<number, EditedImportItem>;
  changes: readonly BalanceMatchChange[];
  defaultAccountId: string;
}): { rows: ImportReviewRow[]; edited: Record<number, EditedImportItem> } {
  const rows = args.rows.map((row) => ({ ...row }));
  const edited = { ...args.edited };
  for (const change of args.changes) {
    const index = rows.findIndex((row) => row.rowId === change.id);
    const row = rows[index];
    if (!row || (!row.item && !edited[index])) continue;
    if (change.action === "exclude") {
      rows[index] = { ...row, include: false };
      continue;
    }
    rows[index] = { ...row, include: true };
    if (change.action === "flip") {
      const current = reviewApplyItem(row, edited[index])!;
      edited[index] = {
        type: current.type === "income" ? "expense" : "income",
        accountId: current.accountId ?? args.defaultAccountId,
        toAccountId: null,
        isRefund: false,
        amount: current.amount,
        date: current.date,
        name: current.name,
        envelopeId: current.envelopeId ?? null,
        categoryId: current.categoryId ?? null,
        placeName: current.placeName ?? null,
        note: edited[index]?.note ?? "",
      };
    }
  }
  return { rows, edited };
}

const BALANCE_LABEL = /saldo|balance|dost[eę]pn|available|stan konta|kontostand|solde|saldo disponible/i;
const NUMBER_TOKEN = /-?\d[\d\s\u00a0.,]*\d|-?\d/g;

/** The bank balance the screenshots themselves show, when a balance line was read as interface chrome. */
export function bankBalanceHint(rows: ReadonlyArray<{ rowRole: string; rawTextLines: string[] }>): number | null {
  // A statement names several balances; the one the bank "shows" is the closing/available
  // figure, so those labels are tried before any other balance line.
  for (const label of [CLOSING_BALANCE_LABEL, BALANCE_LABEL]) {
    for (const row of rows) {
      if (row.rowRole !== "ui_metadata") continue;
      const index = row.rawTextLines.findIndex((text) => label.test(text));
      if (index === -1) continue;
      const found = balanceFigure(row.rawTextLines[index]!, row.rawTextLines[index + 1], label);
      if (found !== null) return found;
    }
  }
  return null;
}

const CLOSING_BALANCE_LABEL = /closing balance|saldo (końcowe|zamknięcia|dostępne)|dost[eę]pn|available/i;

/** The figure on the label's own line, or — a statement table — the cell under the label's
 *  column on the next line (cells are the double-space-separated groups of one line). */
function balanceFigure(line: string, next: string | undefined, label: RegExp): number | null {
  const own = (line.replace(label, "").match(NUMBER_TOKEN) ?? []).map(parseDisplayAmount).find((value) => value !== null);
  if (own !== undefined) return own;
  if (!next) return null;
  const cells = line.split(/\s{2,}/);
  const column = cells.findIndex((cell) => label.test(cell));
  const below = next.split(/\s{2,}/);
  const cell = below[column] ?? below[below.length - 1];
  return (cell?.match(NUMBER_TOKEN) ?? []).map(parseDisplayAmount).find((value) => value !== null) ?? null;
}

/* ── The no-match diagnosis ── */

export interface ImportBalanceDiagnosis {
  /** The largest difference the uncertain rows could explain if every change went the same way. */
  reach: number;
  /** Ledger rows on the account entered by hand (no import trace) since the import's first date. */
  manualEntries: Array<{ id: string; date: string; effect: number; name: string | null; transfer: boolean }>;
}

/**
 * When no change set fits, say why in terms the human can act on: how much the doubtful rows
 * could account for at most, and which entries on this account carry no import trace in the
 * period — the usual home of a balance drift that predates the screenshots.
 */
export function importBalanceDiagnosis(args: {
  candidates: ReadonlyArray<BalanceMatchCandidate>;
  transactions: ClientLedger["transactions"];
  accountId: string;
  since: string | null;
  limit?: number;
}): ImportBalanceDiagnosis {
  const reach = args.candidates.reduce((sum, candidate) => sum + Math.max(0, ...balanceMatchOptions(candidate).map((option) => Math.abs(option.delta))), 0);
  const manualEntries = args.transactions
    .filter((transaction) => transaction.sourceRef === null && (args.since === null || transaction.date >= args.since))
    .filter((transaction) => transaction.accountId === args.accountId || (transaction.type === "transfer" && transaction.toAccountId === args.accountId))
    .sort((left, right) => (left.date < right.date ? 1 : left.date > right.date ? -1 : 0))
    .slice(0, args.limit ?? 5)
    .map((transaction) => ({
      id: transaction.id,
      date: transaction.date,
      effect:
        transaction.type === "income"
          ? transaction.amount
          : transaction.type === "expense"
            ? transaction.isRefund
              ? transaction.amount
              : -transaction.amount
            : transaction.accountId === args.accountId
              ? -transaction.amount
              : transaction.amount,
      name: transaction.name ?? transaction.note ?? null,
      transfer: transaction.type === "transfer",
    }));
  return { reach, manualEntries };
}

/** The earliest date the screenshots show, the natural start of "this period". */
export function importPeriodStart(rows: ReadonlyArray<{ date: string | null }>): string | null {
  let earliest: string | null = null;
  for (const row of rows) if (row.date && (earliest === null || row.date < earliest)) earliest = row.date;
  return earliest;
}
