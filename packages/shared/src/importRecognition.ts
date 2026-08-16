export const IMPORT_SEMANTIC_KINDS = [
  "card_purchase",
  "cash_withdrawal",
  "fee",
  "interest",
  "salary",
  "cashback_or_reward",
  "merchant_refund",
  "chargeback",
  "incoming_transfer",
  "outgoing_transfer",
  "account_topup",
  "internal_transfer",
  "fx_conversion",
  "cash_deposit",
  "unknown",
] as const;
export const IMPORT_RELATION_KINDS = ["fx_for", "refund_of", "pending_version_of", "fee_for", "duplicate_of", "counterpart_of", "continuation_of"] as const;
export const IMPORT_REVIEW_REASONS = [
  "missing_fact",
  "unsupported_currency",
  "inconsistent_direction",
  "possible_transfer",
  "unknown_transfer_endpoint",
  "possible_ocr_error",
  "history_conflict",
  "multiple_history_candidates",
  "invalid_relation",
  "impossible_fx",
  "relation_changes_ledger_shape",
  "fact_correction",
  "pending_or_declined",
  "unknown_kind",
] as const;

export type ImportSemanticKind = (typeof IMPORT_SEMANTIC_KINDS)[number];
export type ImportRelationKind = (typeof IMPORT_RELATION_KINDS)[number];
export type ImportPostingStatus = "posted" | "pending" | "declined" | "unknown";
export type ImportRowRole = "financial_event" | "supporting_detail" | "ui_metadata";
export type ImportDirection = "debit" | "credit" | "unknown";
export type ImportReviewReason = (typeof IMPORT_REVIEW_REASONS)[number];

export interface ImportRowRelation {
  kind: ImportRelationKind;
  rowId: string;
}

export interface ImportExtractRow {
  rowId: string;
  imageIndex: number;
  visualOrder: number;
  rawTextLines: string[];
  date: string | null;
  amount: number | null;
  currency: string | null;
  direction: ImportDirection;
  postingStatus: ImportPostingStatus;
  rowRole: ImportRowRole;
  semanticKind: ImportSemanticKind;
  relation: ImportRowRelation | null;
  confidence: "low" | "medium" | "high";
  reviewReasons: ImportReviewReason[];
}

export interface ImportExtractBatch {
  rows: ImportExtractRow[];
}

export interface ImportProposal {
  rowId: string;
  sourceRows: string[];
  disposition: "candidate" | "supporting" | "pending" | "declined" | "unresolved";
  date: string | null;
  amount: number | null;
  currency: string | null;
  type: "expense" | "income" | "transfer" | null;
  isRefund: boolean;
  toAccountId: string | null;
  semanticKind: ImportSemanticKind;
  relation: ImportRowRelation | null;
  name: string;
  tag: string;
  rawPlace: string;
  envelopeId: string | null;
  categoryId: string | null;
  placeName: string | null;
  reviewReasons: ImportReviewReason[];
  selected: boolean;
}

export interface ImportRecognitionResult {
  rows: ImportExtractRow[];
  proposals: ImportProposal[];
}
