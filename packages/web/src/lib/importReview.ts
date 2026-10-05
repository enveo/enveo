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

type ImportDetails = Pick<ImportReviewDraftItem, "type" | "name" | "envelopeId" | "categoryId" | "categoryName"> & { accountId?: string };

/** Check the actual reviewed values, never the raw-text/name fallback shown in the row. */
export function importMissingDetails(item: ImportDetails | null | undefined, onBudget: boolean): Message[] {
  if (!item) return [];
  const missing: Message[] = [];
  if (!item.name?.trim()) missing.push(msg("Missing name"));
  if (item.type === "expense") {
    if (!item.categoryId && !item.categoryName?.trim()) missing.push(msg("Missing category"));
    if (onBudget && !item.envelopeId) missing.push(msg("Missing envelope"));
  }
  return missing;
}

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

export function reviewSelectionAfterRefresh(row: ImportReviewRow, previous: Pick<ImportReviewRow, "include" | "duplicateStatus"> | undefined): boolean {
  if (row.duplicateStatus === "exists" || (row.duplicateStatus === "probable" && previous?.duplicateStatus !== "probable")) return false;
  return previous?.include ?? row.include;
}

/** What the person changed in a ready import's review, measured against its recognized state.
 *  Only touched rows are kept, keyed by row id, so every other row follows the recognized state
 *  as it is whenever the review is opened again. */
export interface ImportReviewChanges {
  rows: Record<string, ImportReviewRowChange>;
  /** null keeps the bank balance recognized from the import. */
  bankValue: string | null;
  reconcileAfter: boolean;
}

export interface ImportReviewRowChange {
  include: boolean;
  duplicateStatus: ImportDupStatus;
  edit?: EditedImportItem;
  automaticEnvelopeDefault?: boolean;
}

/** Where review changes are kept. The review depends only on this, so the device-local store can
 *  give way to one that follows the import to the person's other devices. */
export interface ImportReviewChangesStore {
  load(importId: string): Promise<ImportReviewChanges | null>;
  save(importId: string, changes: ImportReviewChanges): Promise<void>;
  clear(importId: string): Promise<void>;
}

/** null when the review shows exactly its recognized state. */
export function importReviewChanges(args: {
  recognized: readonly ImportReviewRow[];
  rows: readonly ImportReviewRow[];
  edited: Record<number, EditedImportItem>;
  editedAutomaticDefaults: Record<number, boolean>;
  bankValue: string;
  recognizedBankValue: string;
  reconcileAfter: boolean;
}): ImportReviewChanges | null {
  const recognized = new Map(args.recognized.map((row) => [row.rowId, row]));
  const rows: ImportReviewChanges["rows"] = {};
  args.rows.forEach((row, index) => {
    const edit = args.edited[index];
    if (!edit && row.include === recognized.get(row.rowId)?.include) return;
    rows[row.rowId] = edit
      ? { include: row.include, duplicateStatus: row.duplicateStatus, edit, automaticEnvelopeDefault: args.editedAutomaticDefaults[index] ?? false }
      : { include: row.include, duplicateStatus: row.duplicateStatus };
  });
  const bankValue = args.bankValue === args.recognizedBankValue ? null : args.bankValue;
  if (Object.keys(rows).length === 0 && bankValue === null && !args.reconcileAfter) return null;
  return { rows, bankValue, reconcileAfter: args.reconcileAfter };
}

/** An edit chooses the row's assignment itself, so a saved assignment that is unavailable no
 *  longer applies to it. */
export function withEditedAssignment(row: ImportReviewRow): ImportReviewRow {
  return row.blockingIssues.includes("assignment_unavailable")
    ? { ...row, blockingIssues: row.blockingIssues.filter((issue) => issue !== "assignment_unavailable") }
    : row;
}

/** Rows rebuilt during a review keep the person's selection and edits. */
export function refreshedReviewRows(
  rebuilt: readonly ImportReviewRow[],
  previous: readonly ImportReviewRow[],
  edited: Record<number, EditedImportItem>,
): ImportReviewRow[] {
  const previousById = new Map(previous.map((row) => [row.rowId, row]));
  return rebuilt.map((row, index) => ({
    ...(edited[index] ? withEditedAssignment(row) : row),
    include: reviewSelectionAfterRefresh(row, previousById.get(row.rowId)),
  }));
}

/** Saves each review's latest changes in order, skipping states superseded while a save was
 *  running, so the store always ends at what the person last saw. */
export function createImportReviewSaver(store: ImportReviewChangesStore, onSaved: (ok: boolean) => void) {
  const queued = new Map<string, ImportReviewChanges | null>();
  let running: Promise<void> | null = null;
  const drain = async () => {
    while (queued.size > 0) {
      const [importId, changes] = queued.entries().next().value!;
      queued.delete(importId);
      try {
        await (changes ? store.save(importId, changes) : store.clear(importId));
        onSaved(true);
      } catch {
        onSaved(false);
      }
    }
    running = null;
  };
  return {
    save(importId: string, changes: ImportReviewChanges | null): void {
      queued.delete(importId);
      queued.set(importId, changes);
      running ??= drain();
    },
    settled: (): Promise<void> => running ?? Promise.resolve(),
  };
}

/** Restores the person's choices on top of the recognized state as it is now, with the
 *  in-session refresh rule: rows already in the budget stay locked, and a row that has become a
 *  probable duplicate since starts unchecked. */
export function restoreImportReview(
  recognized: readonly ImportReviewRow[],
  changes: ImportReviewChanges,
): { rows: ImportReviewRow[]; edited: Record<number, EditedImportItem>; editedAutomaticDefaults: Record<number, boolean> } {
  const edited: Record<number, EditedImportItem> = {};
  const editedAutomaticDefaults: Record<number, boolean> = {};
  const rows = recognized.map((row, index) => {
    const change = changes.rows[row.rowId];
    if (!change) return row;
    const include = reviewSelectionAfterRefresh(row, change);
    if (!change.edit || row.duplicateStatus === "exists") return { ...row, include };
    edited[index] = change.edit;
    editedAutomaticDefaults[index] = change.automaticEnvelopeDefault ?? false;
    return { ...withEditedAssignment(row), include };
  });
  return { rows, edited, editedAutomaticDefaults };
}

/** An edit can outlive what it points at, e.g. a category merged away while the review waited.
 *  Only the vanished references are cleared, so the rest of the edit survives; the row is
 *  unchecked and flagged until the person chooses again. */
export function reconcileReviewEdits(args: {
  rows: readonly ImportReviewRow[];
  edited: Record<number, EditedImportItem>;
  ledger: Pick<ClientLedger, "accounts" | "envelopes" | "categories">;
  defaultAccountId: string;
}): { rows: ImportReviewRow[]; edited: Record<number, EditedImportItem>; invalidated: boolean } {
  const active = (entries: ReadonlyArray<{ id: string; archived: boolean }>) => new Set(entries.filter((entry) => !entry.archived).map((entry) => entry.id));
  const accounts = active(args.ledger.accounts);
  const envelopes = active(args.ledger.envelopes);
  const categories = active(args.ledger.categories);
  const rows = [...args.rows];
  const edited = { ...args.edited };
  let invalidated = false;
  for (const [key, edit] of Object.entries(args.edited)) {
    const index = Number(key);
    const row = rows[index];
    if (!row) continue;
    const accountId = accounts.has(edit.accountId) ? edit.accountId : args.defaultAccountId;
    const toAccountId = edit.toAccountId !== null && accounts.has(edit.toAccountId) && edit.toAccountId !== accountId ? edit.toAccountId : null;
    const envelopeId = edit.envelopeId !== null && envelopes.has(edit.envelopeId) ? edit.envelopeId : null;
    const categoryId = edit.categoryId !== null && categories.has(edit.categoryId) ? edit.categoryId : null;
    if (accountId === edit.accountId && toAccountId === edit.toAccountId && envelopeId === edit.envelopeId && categoryId === edit.categoryId) continue;
    invalidated = true;
    edited[index] = { ...edit, accountId, toAccountId, envelopeId, categoryId };
    rows[index] = { ...row, include: false, requiresReview: true, blockingIssues: [...new Set([...row.blockingIssues, "assignment_unavailable" as const])] };
  }
  return { rows, edited, invalidated };
}

const isNullableString = (value: unknown): boolean => value === null || typeof value === "string";

function isEditedImportItem(value: unknown): value is EditedImportItem {
  const edit = value as Record<string, unknown> | null;
  return (
    typeof edit === "object" &&
    edit !== null &&
    ["expense", "income", "transfer"].includes(edit.type as string) &&
    typeof edit.accountId === "string" &&
    isNullableString(edit.toAccountId) &&
    typeof edit.isRefund === "boolean" &&
    Number.isSafeInteger(edit.amount) &&
    typeof edit.date === "string" &&
    typeof edit.name === "string" &&
    isNullableString(edit.envelopeId) &&
    isNullableString(edit.categoryId) &&
    isNullableString(edit.placeName) &&
    typeof edit.note === "string"
  );
}

/** Stored changes are read defensively: a row they cannot vouch for falls back to its recognized
 *  state instead of reaching the apply path. */
export function parseImportReviewChanges(json: string): ImportReviewChanges | null {
  let value: Partial<ImportReviewChanges> | null;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!value || typeof value.rows !== "object" || !value.rows || !isNullableString(value.bankValue) || typeof value.reconcileAfter !== "boolean") return null;
  const rows = Object.entries(value.rows).filter(
    ([, row]) =>
      typeof row?.include === "boolean" &&
      ["new", "probable", "exists"].includes(row.duplicateStatus) &&
      (row.edit === undefined || isEditedImportItem(row.edit)) &&
      (row.automaticEnvelopeDefault === undefined || typeof row.automaticEnvelopeDefault === "boolean"),
  );
  return { rows: Object.fromEntries(rows), bankValue: value.bankValue ?? null, reconcileAfter: value.reconcileAfter };
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
  if (row.blockingIssues.includes("assignment_unavailable")) badges.push({ label: msg("Saved assignment is unavailable"), tone: "warning" });
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

export function importReviewDoneStats(rows: ImportReviewRow[], result: { added: number; skipped: number }): { added: number; dup: number } {
  return {
    added: result.added,
    dup: rows.filter((row) => row.duplicateStatus === "exists").length + result.skipped,
  };
}

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

  doubtful: boolean;
}

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

export function bankBalanceHint(rows: ReadonlyArray<{ rowRole: string; rawTextLines: string[] }>): number | null {
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

export interface ImportBalanceDiagnosis {
  reach: number;

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

export function importPeriodStart(rows: ReadonlyArray<{ date: string | null }>): string | null {
  let earliest: string | null = null;
  for (const row of rows) if (row.date && (earliest === null || row.date < earliest)) earliest = row.date;
  return earliest;
}
