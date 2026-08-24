import { type ChatRequest, type ImportJobErrorCode, type ImportRecognitionResult, stripImportRecognitionReconciliation } from "@enveo/shared";
import { eq } from "drizzle-orm";
import { ZodError } from "zod";
import { CredentialBudgetMismatch, CredentialNotConfigured, type CredentialRepository, CredentialVaultUnavailable } from "../aiCredentials/repository";
import { ByokInvalidBodyError, ByokUpstreamError, byokChatContent } from "../aiCredentials/transport";
import { meteredOperatorChat, operatorChatPayload, SpendDenied } from "../aiSpend/transport";
import { TierMismatch } from "../context";
import type { DB } from "../db/client";
import * as schema from "../db/schema";
import { UpstreamHttpError, UpstreamNetworkError, UpstreamTimeoutError } from "../openaiHttp";
import { loadImportHistory, runServerImportRecognitionAdapter } from "../routes/import";
import type { ClaimedImportJob, ImportJobRepository } from "./repository";

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
  error && typeof error === "object" && "reason" in error && (error as { reason?: unknown }).reason !== undefined
    ? (error as { reason: unknown }).reason
    : error;

export function classifyImportJobFailure(error: unknown, attempt: number, now = new Date()): ImportJobFailureDisposition {
  const reason = unwrapFailure(error);
  if (reason instanceof ImportJobLeaseExpired) return { kind: "lease_expired", errorCode: "expired" };
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
  if (reason instanceof ImportJobMalformedResponse || reason instanceof ByokInvalidBodyError || reason instanceof SyntaxError || reason instanceof ZodError) {
    return retryOrPermanent("malformed_model_response", attempt, now);
  }
  return retryOrPermanent("network", attempt, now);
}

type ProcessorRepository = {
  heartbeat: ImportJobRepository["heartbeat"];
  getForUser: (userId: string, id: string) => Promise<{ status?: string; cancelRequested: boolean } | null>;
  saveExtractionAndDeleteImages: ImportJobRepository["saveExtractionAndDeleteImages"];
  advancePhase: ImportJobRepository["advancePhase"];
  saveReadyResult: ImportJobRepository["saveReadyResult"];
  scheduleRetry: ImportJobRepository["scheduleRetry"];
  failPermanently: ImportJobRepository["failPermanently"];
  finishCancellation: ImportJobRepository["finishCancellation"];
};

export interface ImportRecognitionRunInput {
  checkpoint: ImportRecognitionResult | null;
  afterUpstream: () => Promise<void>;
  saveExtraction: (result: ImportRecognitionResult) => Promise<void>;
  advancePhase: (phase: "enriching" | "reconciling") => Promise<void>;
}

export interface ImportJobProcessorDeps {
  repository: ProcessorRepository;
  recognize: (input: ImportRecognitionRunInput) => Promise<ImportRecognitionResult>;
  now?: () => Date;
}

async function persistCancellation(job: ClaimedImportJob, repository: ProcessorRepository): Promise<never> {
  if (!(await repository.finishCancellation(job.id, job.leaseToken))) throw new ImportJobLeaseExpired();
  throw new ImportJobCancelled();
}

export async function processClaimedImportJob(job: ClaimedImportJob, deps: ImportJobProcessorDeps): Promise<ImportJobProcessOutcome> {
  const now = deps.now ?? (() => new Date());
  const fence = async () => {
    if (!(await deps.repository.heartbeat(job.id, job.leaseToken, now()))) throw new ImportJobLeaseExpired();
    const current = await deps.repository.getForUser(job.userId, job.id);
    if (!current) throw new ImportJobBudgetMismatch();
    if (current.status === "cancelled" || current.cancelRequested) await persistCancellation(job, deps.repository);
  };
  const checkpoint = async (write: () => Promise<boolean>) => {
    await fence();
    if (!(await write())) {
      const current = await deps.repository.getForUser(job.userId, job.id);
      if (current?.cancelRequested) await persistCancellation(job, deps.repository);
      throw new ImportJobLeaseExpired();
    }
  };

  try {
    if (job.cancelRequested) await persistCancellation(job, deps.repository);
    if (job.tier !== "plain") throw new ImportJobTierMismatch();
    if (!job.accountId) throw new ImportJobAccountUnavailable();
    if (!job.extraction && job.images.length === 0) throw new ImportJobLeaseExpired();

    const result = await deps.recognize({
      checkpoint: job.extraction,
      afterUpstream: fence,
      saveExtraction: (extraction) => checkpoint(() => deps.repository.saveExtractionAndDeleteImages(job.id, job.leaseToken, extraction, now())),
      advancePhase: (phase) => checkpoint(() => deps.repository.advancePhase(job.id, job.leaseToken, phase, now())),
    });
    await checkpoint(() => deps.repository.saveReadyResult(job.id, job.leaseToken, result, now()));
    return { kind: "ready" };
  } catch (error) {
    if (error instanceof ImportJobCancelled) return { kind: "cancelled" };
    const disposition = classifyImportJobFailure(error, job.attempt, now());
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
  }
}

type ProviderChatDeps = {
  database: DB;
  credentials: Pick<CredentialRepository, "withServerCredentialForWorker">;
  operatorChat?: typeof meteredOperatorChat;
  byokChat?: typeof byokChatContent;
};

export function createImportJobChat(job: ClaimedImportJob, deps: ProviderChatDeps) {
  if (job.provider.provider === "enveo") {
    return async (request: ChatRequest, timeoutMs?: number) => {
      const outcome = await (deps.operatorChat ?? meteredOperatorChat)({
        userId: job.userId,
        payload: { ...operatorChatPayload(request), model: job.provider.model },
        timeoutMs,
      });
      if (outcome.kind === "denied") throw new SpendDenied(outcome.retryAfterSeconds);
      if (outcome.kind === "upstream_error") throw new UpstreamHttpError(outcome.status);
      if (outcome.kind === "invalid_body") throw new ImportJobMalformedResponse();
      return outcome.content || "{}";
    };
  }
  return (request: ChatRequest, timeoutMs?: number) =>
    deps.credentials.withServerCredentialForWorker(deps.database, { userId: job.userId }, job.budgetId, (apiKey) =>
      (deps.byokChat ?? byokChatContent)({ apiKey, model: job.provider.model, request, timeoutMs }),
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
    const images = job.images.map((image) => `data:${image.mimeType};base64,${Buffer.from(image.content).toString("base64")}`);
    const result = await runServerImportRecognitionAdapter({
      images,
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
      lifecycle: {
        afterUpstream: run.afterUpstream,
        saveExtraction: run.saveExtraction,
        advancePhase: run.advancePhase,
      },
    });
    return stripImportRecognitionReconciliation(result);
  };
}
