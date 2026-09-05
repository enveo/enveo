import {
  type ChatRequest,
  type ImportChunkFailureDisposition,
  type ImportChunkState,
  ImportChunksPendingError,
  ImportEnrichmentMalformedError,
  type ImportExtractBatch,
  ImportExtractionFailedError,
  type ImportJobErrorCode,
  type ImportRecognitionChatMeta,
  type ImportRecognitionResult,
} from "@enveo/shared";
import { eq } from "drizzle-orm";
import { ZodError } from "zod";
import { CredentialBudgetMismatch, CredentialNotConfigured, type CredentialRepository, CredentialVaultUnavailable } from "../aiCredentials/repository";
import { ByokInvalidBodyError, ByokUpstreamError, byokChat } from "../aiCredentials/transport";
import { meteredOperatorChat, operatorChatPayload, SpendDenied } from "../aiSpend/transport";
import { TierMismatch } from "../context";
import type { DB } from "../db/client";
import * as schema from "../db/schema";
import { UpstreamHttpError, UpstreamNetworkError, UpstreamTimeoutError } from "../openaiHttp";
import { loadImportHistory, runServerImportRecognitionAdapter } from "../routes/import";
import { type ClaimedImportJob, IMPORT_JOB_LEASE_MS, type ImportChunkFailure, type ImportJobRepository } from "./repository";

const RETRY_BACKOFF_MS = [30_000, 120_000] as const;

export class ImportJobBudgetMismatch extends Error {
  constructor() {
    super("budget_mismatch");
  }
}

export class ImportJobTierMismatch extends Error {
  constructor() {
    super("tier_mismatch");
  }
}

export class ImportJobAccountUnavailable extends Error {
  constructor() {
    super("account_unavailable");
  }
}

export class ImportJobInvalidKey extends Error {
  constructor() {
    super("ai_key_invalid");
  }
}

export class ImportJobModelUnavailable extends Error {
  constructor() {
    super("ai_model_unavailable");
  }
}

export class ImportJobMalformedResponse extends Error {
  constructor() {
    super("malformed_model_response");
  }
}

class ImportJobLeaseExpired extends Error {
  constructor() {
    super("expired_import_job_lease");
  }
}

class ImportJobInputExpired extends Error {
  constructor() {
    super("expired_import_job_input");
  }
}

class ImportJobCancelled extends Error {
  constructor() {
    super("import_job_cancelled");
  }
}

export type ImportJobFailureDisposition =
  | { kind: "retry"; errorCode: ImportJobErrorCode; retryAt: Date }
  | { kind: "permanent"; errorCode: ImportJobErrorCode }
  | { kind: "lease_expired"; errorCode: "expired" };

export type ImportJobProcessOutcome =
  | { kind: "ready" }
  | { kind: "cancelled" }
  | { kind: "retry"; errorCode: ImportJobErrorCode; retryAt: Date }
  | { kind: "failed"; errorCode: ImportJobErrorCode }
  | { kind: "lease_expired"; errorCode: "expired" };

const retryOrPermanent = (errorCode: ImportJobErrorCode, attempt: number, now: Date): ImportJobFailureDisposition => {
  if (attempt >= 3) return { kind: "permanent", errorCode };
  return { kind: "retry", errorCode, retryAt: new Date(now.getTime() + RETRY_BACKOFF_MS[attempt - 1]!) };
};

const unwrapFailure = (error: unknown): unknown =>
  error instanceof ImportEnrichmentMalformedError
    ? error
    : error && typeof error === "object" && "reason" in error && (error as { reason?: unknown }).reason !== undefined
      ? (error as { reason: unknown }).reason
      : error;

export function classifyImportJobFailure(error: unknown, attempt: number, now = new Date()): ImportJobFailureDisposition {
  const reason = unwrapFailure(error);
  if (reason instanceof ImportJobLeaseExpired) return { kind: "lease_expired", errorCode: "expired" };
  if (reason instanceof ImportJobInputExpired) return { kind: "permanent", errorCode: "expired" };
  if (reason instanceof SpendDenied) {
    if (attempt >= 3) return { kind: "permanent", errorCode: "ai_budget_exhausted" };
    return { kind: "retry", errorCode: "ai_budget_exhausted", retryAt: new Date(now.getTime() + reason.retryAfterSeconds * 1_000) };
  }
  if (reason instanceof ImportJobBudgetMismatch || reason instanceof CredentialBudgetMismatch) return { kind: "permanent", errorCode: "budget_mismatch" };
  if (reason instanceof ImportJobTierMismatch || reason instanceof TierMismatch) return { kind: "permanent", errorCode: "tier_mismatch" };
  if (reason instanceof ImportJobAccountUnavailable) return { kind: "permanent", errorCode: "account_unavailable" };
  if (reason instanceof ImportJobInvalidKey || reason instanceof CredentialNotConfigured || reason instanceof CredentialVaultUnavailable) {
    return { kind: "permanent", errorCode: "ai_key_invalid" };
  }
  if (reason instanceof ImportJobModelUnavailable) return { kind: "permanent", errorCode: "ai_model_unavailable" };
  if (reason instanceof ByokUpstreamError || reason instanceof UpstreamHttpError) {
    if (reason.status === 401 || reason.status === 403) return { kind: "permanent", errorCode: "ai_key_invalid" };
    if (reason.status === 404) return { kind: "permanent", errorCode: "ai_model_unavailable" };
    return retryOrPermanent("network", attempt, now);
  }
  if (reason instanceof UpstreamTimeoutError) return retryOrPermanent("ai_timeout", attempt, now);
  if (reason instanceof UpstreamNetworkError) return retryOrPermanent("network", attempt, now);
  if (
    reason instanceof ImportJobMalformedResponse ||
    reason instanceof ImportEnrichmentMalformedError ||
    reason instanceof ByokInvalidBodyError ||
    reason instanceof SyntaxError ||
    reason instanceof ZodError
  ) {
    return retryOrPermanent("malformed_model_response", attempt, now);
  }
  return retryOrPermanent("network", attempt, now);
}

type ProcessorRepository = {
  heartbeat: ImportJobRepository["heartbeat"];
  validateClaimContext: ImportJobRepository["validateClaimContext"];
  getForUser: (userId: string, id: string) => Promise<{ status?: string; cancelRequested: boolean } | null>;
  saveChunkExtraction: ImportJobRepository["saveChunkExtraction"];
  failChunk: ImportJobRepository["failChunk"];
  saveExtractionAndDeleteImages: ImportJobRepository["saveExtractionAndDeleteImages"];
  advancePhase: ImportJobRepository["advancePhase"];
  saveReadyResult: ImportJobRepository["saveReadyResult"];
  scheduleRetry: ImportJobRepository["scheduleRetry"];
  failPermanently: ImportJobRepository["failPermanently"];
  finishCancellation: ImportJobRepository["finishCancellation"];
};

export interface ImportRecognitionRunInput {
  checkpoint: ImportRecognitionResult | null;
  /** Per-chunk resume state for cycle one (undefined for a job created before chunking). */
  chunks: ImportChunkState[] | undefined;
  beforeUpstream: () => Promise<void>;
  afterUpstream: () => Promise<void>;
  saveChunkExtraction: (chunkIndex: number, batch: ImportExtractBatch) => Promise<void>;
  failChunk: (chunkIndex: number, error: unknown) => Promise<ImportChunkFailureDisposition>;
  saveExtraction: (result: ImportRecognitionResult) => Promise<void>;
  advancePhase: (phase: "enriching" | "reconciling") => Promise<void>;
  saveResult: (result: ImportRecognitionResult) => Promise<void>;
}

export interface ImportJobProcessorDeps {
  repository: ProcessorRepository;
  recognize: (input: ImportRecognitionRunInput) => Promise<ImportRecognitionResult>;
  now?: () => Date;
  heartbeatIntervalMs?: number;
  logFailure?: (metadata: { jobId: string; attempt: number; errorType: string; chunk?: number }) => void;
}

function startLeaseRenewal(job: ClaimedImportJob, deps: ImportJobProcessorDeps, now: () => Date) {
  const intervalMs = Math.max(1, deps.heartbeatIntervalMs ?? Math.floor(IMPORT_JOB_LEASE_MS / 3));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let failure: unknown = null;

  const schedule = () => {
    timer = setTimeout(() => {
      timer = null;
      inFlight = (async () => {
        try {
          if (!(await deps.repository.heartbeat(job.id, job.leaseToken, now()))) throw new ImportJobLeaseExpired();
        } catch (error) {
          failure = error;
        } finally {
          inFlight = null;
          if (!stopped && failure === null) schedule();
        }
      })();
    }, intervalMs);
  };
  schedule();

  return {
    assertHealthy() {
      if (failure !== null) throw failure;
    },
    async stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      await inFlight;
    },
  };
}

async function persistCancellation(job: ClaimedImportJob, repository: ProcessorRepository): Promise<never> {
  if (!(await repository.finishCancellation(job.id, job.leaseToken))) throw new ImportJobLeaseExpired();
  throw new ImportJobCancelled();
}

export async function processClaimedImportJob(job: ClaimedImportJob, deps: ImportJobProcessorDeps): Promise<ImportJobProcessOutcome> {
  const now = deps.now ?? (() => new Date());
  let leaseRenewal: ReturnType<typeof startLeaseRenewal> | null = null;
  const fence = async () => {
    leaseRenewal?.assertHealthy();
    const renewed = await deps.repository.heartbeat(job.id, job.leaseToken, now());
    leaseRenewal?.assertHealthy();
    const context = await deps.repository.validateClaimContext(job, now());
    if (!renewed && context === "valid") throw new ImportJobLeaseExpired();
    if (context === "lease_lost") throw new ImportJobLeaseExpired();
    if (context === "cancelled") throw new ImportJobCancelled();
    if (context === "cancel_requested") await persistCancellation(job, deps.repository);
    if (context === "budget_mismatch") throw new ImportJobBudgetMismatch();
    if (context === "tier_mismatch") throw new ImportJobTierMismatch();
    if (context === "account_unavailable") throw new ImportJobAccountUnavailable();
  };
  const checkpoint = async (write: () => Promise<boolean>) => {
    await fence();
    if (!(await write())) {
      const current = await deps.repository.getForUser(job.userId, job.id);
      if (current?.cancelRequested) await persistCancellation(job, deps.repository);
      throw new ImportJobLeaseExpired();
    }
  };

  // Cycle one keeps a retry budget PER CHUNK; the post-extraction stage (seam, enrichment,
  // reconciliation) gets its own. When extraction completes inside this claim the stored
  // attempt restarts at 1, so a failure later in the same claim is judged as a first attempt.
  const chunkFailures = new Map<number, ImportChunkFailure>();
  let extractionCompletedThisClaim = false;
  const stageAttempt = () => (extractionCompletedThisClaim ? 1 : job.attempt);

  try {
    if (job.cancelRequested) await persistCancellation(job, deps.repository);
    if (job.tier !== "plain") throw new ImportJobTierMismatch();
    if (!job.accountId) throw new ImportJobAccountUnavailable();
    const hasChunkCheckpoint = job.chunks.some((chunk) => chunk.extraction !== null);
    if (!job.extraction && job.images.length === 0 && !hasChunkCheckpoint) throw new ImportJobInputExpired();

    leaseRenewal = startLeaseRenewal(job, deps, now);

    await deps.recognize({
      checkpoint: job.extraction,
      chunks:
        job.chunks.length === 0
          ? undefined
          : job.chunks.map((chunk) => ({
              index: chunk.index,
              start: chunk.start,
              end: chunk.end,
              extraction: chunk.extraction,
              permanentlyFailed: chunk.status === "failed",
            })),
      beforeUpstream: fence,
      afterUpstream: fence,
      saveChunkExtraction: (chunkIndex, batch) => checkpoint(() => deps.repository.saveChunkExtraction(job.id, job.leaseToken, chunkIndex, batch, now())),
      failChunk: async (chunkIndex, error) => {
        const previousAttempts = job.chunks.find((chunk) => chunk.index === chunkIndex)?.attempt ?? 0;
        const reason = unwrapFailure(error);
        deps.logFailure?.({
          jobId: job.id,
          attempt: previousAttempts + 1,
          chunk: chunkIndex,
          errorType: reason instanceof Error ? reason.constructor.name : typeof reason,
        });
        const disposition = classifyImportJobFailure(error, previousAttempts + 1, now());
        if (disposition.kind === "lease_expired") throw new ImportJobLeaseExpired();
        const failure: ImportChunkFailure = { errorCode: disposition.errorCode, retryAt: disposition.kind === "retry" ? disposition.retryAt : null };
        chunkFailures.set(chunkIndex, failure);
        await checkpoint(() => deps.repository.failChunk(job.id, job.leaseToken, chunkIndex, failure, now()));
        return disposition.kind === "retry" ? "retry" : "permanent";
      },
      saveExtraction: async (extraction) => {
        await checkpoint(() => deps.repository.saveExtractionAndDeleteImages(job.id, job.leaseToken, extraction, now()));
        extractionCompletedThisClaim = true;
      },
      advancePhase: (phase) => checkpoint(() => deps.repository.advancePhase(job.id, job.leaseToken, phase, now())),
      saveResult: (result) => checkpoint(() => deps.repository.saveReadyResult(job.id, job.leaseToken, result, now())),
    });
    return { kind: "ready" };
  } catch (error) {
    if (error instanceof ImportJobCancelled) return { kind: "cancelled" };
    const reason = unwrapFailure(error);
    if (!(error instanceof ImportChunksPendingError) && !(error instanceof ImportExtractionFailedError)) {
      deps.logFailure?.({
        jobId: job.id,
        attempt: stageAttempt(),
        errorType: reason instanceof Error ? reason.constructor.name : typeof reason,
      });
    }
    if (error instanceof ImportJobAccountUnavailable) {
      const saved = await deps.repository.failPermanently(job.id, job.leaseToken, "account_unavailable", now());
      return saved ? { kind: "failed", errorCode: "account_unavailable" } : { kind: "lease_expired", errorCode: "expired" };
    }
    const disposition = chunkStageDisposition(error, chunkFailures, job) ?? classifyImportJobFailure(error, stageAttempt(), now());
    if (disposition.kind === "lease_expired") return disposition;
    try {
      await fence();
    } catch (fenceError) {
      if (fenceError instanceof ImportJobCancelled) return { kind: "cancelled" };
      return { kind: "lease_expired", errorCode: "expired" };
    }
    if (disposition.kind === "retry") {
      const saved = await deps.repository.scheduleRetry(job.id, job.leaseToken, disposition.errorCode, disposition.retryAt, now());
      return saved ? disposition : { kind: "lease_expired", errorCode: "expired" };
    }
    const saved = await deps.repository.failPermanently(job.id, job.leaseToken, disposition.errorCode, now());
    return saved ? { kind: "failed", errorCode: disposition.errorCode } : { kind: "lease_expired", errorCode: "expired" };
  } finally {
    await leaseRenewal?.stop();
  }
}

/** Cycle-one outcomes already judged per chunk: the job follows the earliest chunk retry, or
 *  fails with the first permanently failed chunk's code when nothing could be read. */
function chunkStageDisposition(error: unknown, failures: Map<number, ImportChunkFailure>, job: ClaimedImportJob): ImportJobFailureDisposition | null {
  if (error instanceof ImportChunksPendingError) {
    const retries = error.pendingChunks.map((index) => failures.get(index)).filter((failure): failure is ImportChunkFailure => failure?.retryAt != null);
    const earliest = retries.reduce<ImportChunkFailure | null>((best, failure) => (best === null || failure.retryAt! < best.retryAt! ? failure : best), null);
    if (!earliest) return { kind: "retry", errorCode: "network", retryAt: new Date(Date.now() + RETRY_BACKOFF_MS[0]) };
    return { kind: "retry", errorCode: earliest.errorCode, retryAt: earliest.retryAt! };
  }
  if (error instanceof ImportExtractionFailedError) {
    const failed = [...failures.values()].find((failure) => failure.retryAt === null) ?? job.chunks.find((chunk) => chunk.status === "failed");
    return { kind: "permanent", errorCode: failed?.errorCode ?? "network" };
  }
  return null;
}

/** Safe per-call diagnostics: duration and token counts only — never prompts, images or answers. */
export interface ImportUpstreamCallLog {
  jobId: string;
  stage: ImportRecognitionChatMeta["stage"] | "unknown";
  chunk: number | null;
  batch: number | null;
  durationMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  outcome: "ok" | "error";
}

type ProviderChatDeps = {
  database: DB;
  credentials: Pick<CredentialRepository, "withServerCredentialForWorker">;
  operatorChat?: typeof meteredOperatorChat;
  byokChat?: typeof byokChat;
  logUpstreamFailure?: (metadata: { status: number; requestId: string | null }) => void;
  logUpstreamCall?: (entry: ImportUpstreamCallLog) => void;
  now?: () => number;
};

const usageTokens = (json: Record<string, unknown> | undefined, key: "prompt_tokens" | "completion_tokens"): number | null => {
  const usage = json?.usage;
  const value = usage && typeof usage === "object" ? (usage as Record<string, unknown>)[key] : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

export function createImportJobChat(job: ClaimedImportJob, deps: ProviderChatDeps) {
  const clock = deps.now ?? (() => Date.now());
  const log = deps.logUpstreamCall ?? ((entry: ImportUpstreamCallLog) => console.info("import-job: upstream call", entry));
  const timed = async (meta: ImportRecognitionChatMeta | undefined, call: () => Promise<{ content: string; json?: Record<string, unknown> }>) => {
    const startedAt = clock();
    const base = {
      jobId: job.id,
      stage: meta?.stage ?? ("unknown" as const),
      chunk: meta?.stage === "extract" ? meta.chunk : null,
      batch: meta?.stage === "enrich" ? meta.batch : null,
    };
    try {
      const answer = await call();
      log({
        ...base,
        durationMs: clock() - startedAt,
        promptTokens: usageTokens(answer.json, "prompt_tokens"),
        completionTokens: usageTokens(answer.json, "completion_tokens"),
        outcome: "ok",
      });
      return answer.content;
    } catch (error) {
      log({ ...base, durationMs: clock() - startedAt, promptTokens: null, completionTokens: null, outcome: "error" });
      throw error;
    }
  };

  if (job.provider.provider === "enveo") {
    return (request: ChatRequest, timeoutMs?: number, meta?: ImportRecognitionChatMeta) =>
      timed(meta, async () => {
        const outcome = await (deps.operatorChat ?? meteredOperatorChat)({
          userId: job.userId,
          payload: { ...operatorChatPayload(request), model: job.provider.model },
          timeoutMs,
        });
        if (outcome.kind === "denied") throw new SpendDenied(outcome.retryAfterSeconds);
        if (outcome.kind === "upstream_error") {
          const metadata = { status: outcome.status, requestId: outcome.requestId };
          if (deps.logUpstreamFailure) deps.logUpstreamFailure(metadata);
          else console.warn("import-job: OpenAI rejected request", metadata);
          throw new UpstreamHttpError(outcome.status);
        }
        if (outcome.kind === "invalid_body") throw new ImportJobMalformedResponse();
        return { content: outcome.content || "{}", json: outcome.json };
      });
  }
  return (request: ChatRequest, timeoutMs?: number, meta?: ImportRecognitionChatMeta) =>
    timed(meta, () =>
      deps.credentials.withServerCredentialForWorker(deps.database, { userId: job.userId }, job.budgetId, async (apiKey) => {
        const outcome = await (deps.byokChat ?? byokChat)({ apiKey, model: job.provider.model, request, timeoutMs });
        if (outcome.kind === "upstream_error") throw new ByokUpstreamError(outcome.status);
        if (outcome.kind === "invalid_body") throw new ByokInvalidBodyError();
        return { content: outcome.content, json: outcome.json };
      }),
    );
}

export function createDatabaseImportRecognition(job: ClaimedImportJob, deps: ProviderChatDeps) {
  return async (run: ImportRecognitionRunInput): Promise<ImportRecognitionResult> => {
    const [[budget], accountRows, envelopeRows, categoryRows, transactionRows] = await Promise.all([
      deps.database
        .select({ userId: schema.budgets.userId, currency: schema.budgets.currency, tier: schema.budgets.tier, epoch: schema.budgets.epoch })
        .from(schema.budgets)
        .where(eq(schema.budgets.id, job.budgetId)),
      deps.database.select().from(schema.accounts).where(eq(schema.accounts.budgetId, job.budgetId)),
      deps.database.select().from(schema.envelopes).where(eq(schema.envelopes.budgetId, job.budgetId)),
      deps.database.select().from(schema.categories).where(eq(schema.categories.budgetId, job.budgetId)),
      deps.database.select().from(schema.transactions).where(eq(schema.transactions.budgetId, job.budgetId)),
    ]);
    if (!budget || budget.userId !== job.userId) throw new ImportJobBudgetMismatch();
    if (budget.tier !== "plain" || budget.epoch !== job.epoch) throw new ImportJobTierMismatch();
    const account = accountRows.find((candidate) => candidate.id === job.accountId && !candidate.archived);
    if (!account) throw new ImportJobAccountUnavailable();
    const historyRecords = await loadImportHistory(job.budgetId, budget.currency, deps.database);
    // Absolute positions: a resumed job keeps only the screenshots of chunks not yet read.
    const total = job.screenshotTotal > 0 ? job.screenshotTotal : job.images.length;
    const images: Array<string | null> = Array.from({ length: total }, () => null);
    job.images.forEach((image, fallbackPosition) => {
      const position = job.screenshotTotal > 0 ? image.position : fallbackPosition;
      if (position < total) images[position] = `data:${image.mimeType};base64,${Buffer.from(image.content).toString("base64")}`;
    });
    const result = await runServerImportRecognitionAdapter({
      images,
      chunks: run.chunks,
      locale: job.locale,
      today: new Date().toISOString().slice(0, 10),
      budgetCurrency: budget.currency,
      accountId: account.id,
      accountRows,
      envelopeRows,
      categoryRows,
      transactionRows,
      historyRecords,
      chat: createImportJobChat(job, deps),
      checkpoint: run.checkpoint ?? undefined,
      pipelineMode: "durable",
      cycleTwoFailureMode: "strict",
      lifecycle: {
        beforeUpstream: run.beforeUpstream,
        afterUpstream: run.afterUpstream,
        saveChunkExtraction: run.saveChunkExtraction,
        failChunk: run.failChunk,
        saveExtraction: run.saveExtraction,
        advancePhase: run.advancePhase,
        saveResult: run.saveResult,
      },
    });
    return result;
  };
}
