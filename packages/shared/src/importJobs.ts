import { z } from "zod";
import {
  IMPORT_RELATION_KINDS,
  IMPORT_REVIEW_REASONS,
  IMPORT_SEMANTIC_KINDS,
  type ImportExtractBatch,
  type ImportRecognitionResult,
} from "./importRecognition";

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

type ImportJobActivePhase = "extracting" | "validating" | "enriching" | "reconciling";

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
  })
  .strict();

/** One chunk's cycle-one checkpoint (rows only, already rebased onto the job). */
export const importExtractBatchSchema: z.ZodType<ImportExtractBatch> = z.object({ rows: z.array(importExtractRowSchema) }).strict();

/** The durable job captures Stage A recognition before ledger reconciliation. */
const importSeamOutcomeSchema = z
  .object({ unresolved: z.array(z.object({ earlierRowId: z.string().min(1), laterRowId: z.string().min(1) }).strict()) })
  .strict();

export const importJobResultSchema: z.ZodType<ImportRecognitionResult> = z
  .object({
    rows: z.array(importExtractRowSchema),
    proposals: z.array(importProposalSchema),
    seam: importSeamOutcomeSchema.optional(),
  })
  .strict();

/** Screenshot-level progress of cycle one; `total` is 0 for jobs created before chunking. */
export interface ImportJobScreenshotProgress {
  total: number;
  read: number;
  failed: number;
}

/** Screenshots a finished job could not read were moved into a separate failed job that
 *  the ordinary retry path re-reads without a new upload. */
export interface ImportJobPartialFailure {
  retryJobId: string;
  imageCount: number;
}

export const importJobScreenshotProgressSchema: z.ZodType<ImportJobScreenshotProgress> = z
  .object({ total: z.number().int().nonnegative(), read: z.number().int().nonnegative(), failed: z.number().int().nonnegative() })
  .strict();
export const importJobPartialFailureSchema: z.ZodType<ImportJobPartialFailure> = z
  .object({ retryJobId: z.string().uuid(), imageCount: z.number().int().positive() })
  .strict();

export interface ImportJobProgress {
  status: ImportJobStatus;
  phase: ImportJobPhase;
  /** The last active processing phase while phase reports a resumable wait. */
  resumePhase: ImportJobActivePhase | null;
  cancelRequested: boolean;
  attempt: number;
  errorCode: ImportJobErrorCode | null;
  retryAt: string | null;
  updatedAt: string;
}

const importJobProgressShape = {
  status: importJobStatusSchema,
  phase: importJobPhaseSchema,
  resumePhase: z.enum(["extracting", "validating", "enriching", "reconciling"]).nullable(),
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
  screenshots: ImportJobScreenshotProgress;
  partialFailure: ImportJobPartialFailure | null;
}

export interface ImportJobDetail extends ImportJobSummary {
  locale: string;
  epoch: number;
  result: ImportRecognitionResult | null;
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
  screenshots: importJobScreenshotProgressSchema,
  partialFailure: importJobPartialFailureSchema.nullable(),
} as const;

export const importJobSummarySchema: z.ZodType<ImportJobSummary> = z.object(importJobSummaryShape).strict();

const importJobDetailBaseSchema = z
  .object({
    ...importJobSummaryShape,
    locale: z.string().trim().min(2),
    epoch: z.number().int().nonnegative(),
    result: importJobResultSchema.nullable(),
    appliedCount: z.number().int().nonnegative(),
    skippedCount: z.number().int().nonnegative(),
  })
  .strict();

const ACTIVE_PHASES = ["extracting", "validating", "enriching", "reconciling"] as const;
const WAITING_PHASES = ["waiting_for_network", "waiting_for_device", "waiting_for_unlock"] as const;
const QUEUED_PHASES = ["preparing", "uploading", "queued"] as const;

const isActivePhase = (phase: ImportJobPhase): phase is ImportJobActivePhase => ACTIVE_PHASES.includes(phase as ImportJobActivePhase);
const isWaitingPhase = (phase: ImportJobPhase): boolean => WAITING_PHASES.includes(phase as (typeof WAITING_PHASES)[number]);
const isFailedPhase = (phase: ImportJobPhase): boolean =>
  QUEUED_PHASES.includes(phase as (typeof QUEUED_PHASES)[number]) || isActivePhase(phase) || isWaitingPhase(phase) || phase === "retry_scheduled";

export const importJobDetailSchema: z.ZodType<ImportJobDetail> = importJobDetailBaseSchema.superRefine((detail, context) => {
  const invalid = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  const hasError = detail.errorCode !== null;
  const hasRetry = detail.retryAt !== null;

  if (detail.tier === "e2ee" && detail.epoch === 0) invalid("e2ee import jobs require a positive epoch");

  switch (detail.status) {
    case "queued":
      if (!QUEUED_PHASES.includes(detail.phase as (typeof QUEUED_PHASES)[number])) invalid("queued import jobs must use a queued phase");
      if (detail.resumePhase !== null || detail.cancelRequested || hasError || hasRetry) invalid("queued import jobs cannot carry active work state");
      break;
    case "running":
      if (!isActivePhase(detail.phase) && !isWaitingPhase(detail.phase)) invalid("running import jobs must use an active or waiting phase");
      if (isWaitingPhase(detail.phase) ? detail.resumePhase === null : detail.resumePhase !== null)
        invalid("waiting import jobs must retain exactly one resume phase");
      if (hasError || hasRetry) invalid("running import jobs cannot carry a failure");
      break;
    case "ready":
      if (
        !["ready", "applying"].includes(detail.phase) ||
        detail.resumePhase !== null ||
        detail.cancelRequested ||
        hasError ||
        hasRetry ||
        detail.result === null
      ) {
        invalid("ready import jobs must have a reviewable result");
      }
      break;
    case "completed":
      if (detail.phase !== "completed" || detail.resumePhase !== null || detail.cancelRequested || hasError || hasRetry)
        invalid("completed import jobs must use the completed phase");
      break;
    case "failed":
      if (!isFailedPhase(detail.phase) || !hasError || detail.resumePhase !== null || detail.cancelRequested)
        invalid("failed import jobs must include an error without resumable work state");
      if (hasRetry !== (detail.phase === "retry_scheduled")) invalid("retry scheduling must match the failed phase");
      break;
    case "cancelled":
      if (detail.phase === "completed" || detail.resumePhase !== null || !detail.cancelRequested || hasError || hasRetry)
        invalid("cancelled import jobs must record cancellation only");
      break;
  }
});

export type ImportJobEvent =
  | { type: "claimed"; at: string }
  | { type: "phase"; phase: "validating" | "enriching" | "reconciling"; at: string }
  | { type: "wait"; phase: "waiting_for_network" | "waiting_for_device" | "waiting_for_unlock"; at: string }
  | { type: "resume"; at: string }
  | { type: "result_ready"; at: string }
  | { type: "begin_apply"; at: string }
  | { type: "completed"; at: string }
  | { type: "failed"; errorCode: ImportJobErrorCode; retryAt: string | null; at: string }
  | { type: "retry"; at: string }
  | { type: "cancel"; at: string }
  | { type: "cancelled"; at: string };

const ACTIVE_PHASE_ORDER = ACTIVE_PHASES;

export function isTerminalImportJob(status: ImportJobStatus): boolean {
  return status === "completed" || status === "cancelled";
}

const invalidTransition = (): never => {
  throw new Error("invalid_import_job_transition");
};

export function advanceImportJob(current: ImportJobProgress, event: ImportJobEvent): ImportJobProgress {
  if (!isoTimestampSchema.safeParse(event.at).success) invalidTransition();
  if (event.type === "failed" && event.retryAt !== null && !isoTimestampSchema.safeParse(event.retryAt).success) invalidTransition();
  if (isTerminalImportJob(current.status)) invalidTransition();
  const next = (change: Partial<ImportJobProgress>): ImportJobProgress => ({ ...current, ...change, updatedAt: event.at });

  switch (event.type) {
    case "claimed":
      if (current.status !== "queued") return invalidTransition();
      return next({ status: "running", phase: "extracting", resumePhase: null, attempt: current.attempt + 1, errorCode: null, retryAt: null });
    case "phase": {
      if (current.status !== "running" || current.cancelRequested) return invalidTransition();
      const fromPhase = isWaitingPhase(current.phase) ? current.resumePhase : current.phase;
      const from = ACTIVE_PHASE_ORDER.indexOf(fromPhase as (typeof ACTIVE_PHASE_ORDER)[number]);
      const to = ACTIVE_PHASE_ORDER.indexOf(event.phase);
      if (from >= 0 && to <= from) return invalidTransition();
      return next({ phase: event.phase, resumePhase: null });
    }
    case "wait":
      if (current.status !== "running" || current.cancelRequested || !isActivePhase(current.phase)) return invalidTransition();
      return next({ phase: event.phase, resumePhase: current.phase });
    case "resume":
      if (current.status !== "running" || current.cancelRequested || !isWaitingPhase(current.phase) || current.resumePhase === null) return invalidTransition();
      return next({ phase: current.resumePhase, resumePhase: null });
    case "result_ready":
      if (current.status !== "running" || current.cancelRequested) return invalidTransition();
      return next({ status: "ready", phase: "ready", resumePhase: null, errorCode: null, retryAt: null });
    case "begin_apply":
      if (current.status !== "ready" || current.cancelRequested) return invalidTransition();
      return next({ phase: "applying" });
    case "completed":
      if (current.status !== "ready" || current.phase !== "applying") return invalidTransition();
      return next({ status: "completed", phase: "completed" });
    case "failed":
      if ((current.status !== "queued" && current.status !== "running") || current.cancelRequested) return invalidTransition();
      return next({
        status: "failed",
        phase: event.retryAt ? "retry_scheduled" : current.phase,
        resumePhase: null,
        errorCode: event.errorCode,
        retryAt: event.retryAt,
      });
    case "retry":
      if (current.status !== "failed") return invalidTransition();
      return next({ status: "queued", phase: "queued", resumePhase: null, errorCode: null, retryAt: null });
    case "cancel":
      if (current.status === "running") return next({ cancelRequested: true });
      return next({ status: "cancelled", resumePhase: null, cancelRequested: true, errorCode: null, retryAt: null });
    case "cancelled":
      if (current.status !== "running" || !current.cancelRequested) return invalidTransition();
      return next({ status: "cancelled", resumePhase: null });
  }
}
