import { z } from "zod";
import { IMPORT_RELATION_KINDS, IMPORT_REVIEW_REASONS, IMPORT_SEMANTIC_KINDS, type ReconciledImportRecognitionResult } from "./importRecognition";

export const IMPORT_JOB_STATUSES = ["queued", "running", "ready", "completed", "failed", "cancelled"] as const;
export const IMPORT_JOB_PHASES = [
  "preparing",
  "uploading",
  "queued",
  "extracting",
  "validating",
  "enriching",
  "reconciling",
  "ready",
  "applying",
  "completed",
  "waiting_for_network",
  "waiting_for_device",
  "waiting_for_unlock",
  "retry_scheduled",
] as const;
export const IMPORT_JOB_ERROR_CODES = [
  "network",
  "ai_timeout",
  "ai_budget_exhausted",
  "ai_key_invalid",
  "ai_model_unavailable",
  "malformed_model_response",
  "budget_mismatch",
  "tier_mismatch",
  "account_unavailable",
  "expired",
] as const;

export const importJobStatusSchema = z.enum(IMPORT_JOB_STATUSES);
export const importJobPhaseSchema = z.enum(IMPORT_JOB_PHASES);
export const importJobErrorCodeSchema = z.enum(IMPORT_JOB_ERROR_CODES);
export const importJobProviderSnapshotSchema = z
  .object({
    provider: z.enum(["enveo", "openai"]),
    model: z.string().trim().min(1),
  })
  .strict();

export type ImportJobStatus = z.infer<typeof importJobStatusSchema>;
export type ImportJobPhase = z.infer<typeof importJobPhaseSchema>;
export type ImportJobErrorCode = z.infer<typeof importJobErrorCodeSchema>;
export type ImportJobProviderSnapshot = z.infer<typeof importJobProviderSnapshotSchema>;

const isoTimestampSchema = z.string().datetime({ offset: true });
const importRelationSchema = z.object({ kind: z.enum(IMPORT_RELATION_KINDS), rowId: z.string().min(1) }).strict();
const importExtractRowSchema = z
  .object({
    rowId: z.string().min(1),
    imageIndex: z.number().int().nonnegative(),
    visualOrder: z.number().int().nonnegative(),
    rawTextLines: z.array(z.string()),
    date: z.string().nullable(),
    amount: z.number().int().positive().nullable(),
    currency: z.string().nullable(),
    direction: z.enum(["debit", "credit", "unknown"]),
    postingStatus: z.enum(["posted", "pending", "declined", "unknown"]),
    rowRole: z.enum(["financial_event", "supporting_detail", "ui_metadata"]),
    semanticKind: z.enum(IMPORT_SEMANTIC_KINDS),
    relation: importRelationSchema.nullable(),
    confidence: z.enum(["low", "medium", "high"]),
    reviewReasons: z.array(z.enum(IMPORT_REVIEW_REASONS)),
  })
  .strict();
const importProposalSchema = z
  .object({
    rowId: z.string().min(1),
    sourceRows: z.array(z.string().min(1)),
    disposition: z.enum(["candidate", "supporting", "pending", "declined", "unresolved"]),
    date: z.string().nullable(),
    amount: z.number().int().positive().nullable(),
    currency: z.string().nullable(),
    type: z.enum(["expense", "income", "transfer"]).nullable(),
    isRefund: z.boolean(),
    toAccountId: z.string().nullable(),
    semanticKind: z.enum(IMPORT_SEMANTIC_KINDS),
    relation: importRelationSchema.nullable(),
    name: z.string(),
    tag: z.string(),
    rawPlace: z.string(),
    envelopeId: z.string().nullable(),
    categoryId: z.string().nullable(),
    placeName: z.string().nullable(),
    reviewReasons: z.array(z.enum(IMPORT_REVIEW_REASONS)),
    selected: z.boolean(),
    duplicateStatus: z.enum(["new", "probable", "exists"]),
    sourceAccountInvalid: z.boolean(),
  })
  .strict();

export const importJobResultSchema: z.ZodType<ReconciledImportRecognitionResult> = z
  .object({
    rows: z.array(importExtractRowSchema),
    proposals: z.array(importProposalSchema),
  })
  .strict();

export interface ImportJobProgress {
  status: ImportJobStatus;
  phase: ImportJobPhase;
  cancelRequested: boolean;
  attempt: number;
  errorCode: ImportJobErrorCode | null;
  retryAt: string | null;
  updatedAt: string;
}

const importJobProgressShape = {
  status: importJobStatusSchema,
  phase: importJobPhaseSchema,
  cancelRequested: z.boolean(),
  attempt: z.number().int().nonnegative(),
  errorCode: importJobErrorCodeSchema.nullable(),
  retryAt: isoTimestampSchema.nullable(),
  updatedAt: isoTimestampSchema,
} as const;

export const importJobProgressSchema: z.ZodType<ImportJobProgress> = z.object(importJobProgressShape).strict();

export interface ImportJobSummary extends ImportJobProgress {
  id: string;
  budgetId: string;
  accountId: string | null;
  provider: ImportJobProviderSnapshot;
  tier: "plain" | "e2ee";
  createdAt: string;
  expiresAt: string;
  proposalCount: number;
}

export interface ImportJobDetail extends ImportJobSummary {
  locale: string;
  epoch: number;
  result: ReconciledImportRecognitionResult | null;
  appliedCount: number;
  skippedCount: number;
}

const importJobSummaryShape = {
  ...importJobProgressShape,
  id: z.string().uuid(),
  budgetId: z.string().min(1),
  accountId: z.string().min(1).nullable(),
  provider: importJobProviderSnapshotSchema,
  tier: z.enum(["plain", "e2ee"]),
  createdAt: isoTimestampSchema,
  expiresAt: isoTimestampSchema,
  proposalCount: z.number().int().nonnegative(),
} as const;

export const importJobSummarySchema: z.ZodType<ImportJobSummary> = z.object(importJobSummaryShape).strict();

export const importJobDetailSchema: z.ZodType<ImportJobDetail> = z
  .object({
    ...importJobSummaryShape,
    locale: z.string().trim().min(2),
    epoch: z.number().int().positive(),
    result: importJobResultSchema.nullable(),
    appliedCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(),
  })
  .strict();

export type ImportJobEvent =
  | { type: "claimed"; at: string }
  | { type: "phase"; phase: "validating" | "enriching" | "reconciling"; at: string }
  | { type: "wait"; phase: "waiting_for_network" | "waiting_for_device" | "waiting_for_unlock"; at: string }
  | { type: "result_ready"; at: string }
  | { type: "begin_apply"; at: string }
  | { type: "completed"; at: string }
  | { type: "failed"; errorCode: ImportJobErrorCode; retryAt: string | null; at: string }
  | { type: "retry"; at: string }
  | { type: "cancel"; at: string }
  | { type: "cancelled"; at: string };

const ACTIVE_PHASE_ORDER = ["extracting", "validating", "enriching", "reconciling"] as const;

export function isTerminalImportJob(status: ImportJobStatus): boolean {
  return status === "completed" || status === "cancelled";
}

const invalidTransition = (): never => {
  throw new Error("invalid_import_job_transition");
};

export function advanceImportJob(current: ImportJobProgress, event: ImportJobEvent): ImportJobProgress {
  if (isTerminalImportJob(current.status)) invalidTransition();
  const next = (change: Partial<ImportJobProgress>): ImportJobProgress => ({ ...current, ...change, updatedAt: event.at });

  switch (event.type) {
    case "claimed":
      if (current.status !== "queued") return invalidTransition();
      return next({ status: "running", phase: "extracting", attempt: current.attempt + 1, errorCode: null, retryAt: null });
    case "phase": {
      if (current.status !== "running" || current.cancelRequested) return invalidTransition();
      const from = ACTIVE_PHASE_ORDER.indexOf(current.phase as (typeof ACTIVE_PHASE_ORDER)[number]);
      const to = ACTIVE_PHASE_ORDER.indexOf(event.phase);
      if (from >= 0 && to <= from) return invalidTransition();
      return next({ phase: event.phase });
    }
    case "wait":
      if (current.status !== "running" || current.cancelRequested) return invalidTransition();
      return next({ phase: event.phase });
    case "result_ready":
      if (current.status !== "running" || current.cancelRequested) return invalidTransition();
      return next({ status: "ready", phase: "ready", errorCode: null, retryAt: null });
    case "begin_apply":
      if (current.status !== "ready" || current.cancelRequested) return invalidTransition();
      return next({ phase: "applying" });
    case "completed":
      if (current.status !== "ready" || current.phase !== "applying") return invalidTransition();
      return next({ status: "completed", phase: "completed" });
    case "failed":
      if (current.status !== "queued" && current.status !== "running") return invalidTransition();
      return next({ status: "failed", phase: event.retryAt ? "retry_scheduled" : current.phase, errorCode: event.errorCode, retryAt: event.retryAt });
    case "retry":
      if (current.status !== "failed") return invalidTransition();
      return next({ status: "queued", phase: "queued", errorCode: null, retryAt: null });
    case "cancel":
      if (current.status === "running") return next({ cancelRequested: true });
      return next({ status: "cancelled", cancelRequested: true });
    case "cancelled":
      if (current.status !== "running" || !current.cancelRequested) return invalidTransition();
      return next({ status: "cancelled" });
  }
}
