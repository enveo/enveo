import {
  type ImportJobDetail,
  type ImportJobErrorCode,
  type ImportJobPhase,
  type ImportJobProviderSnapshot,
  type ImportJobStatus,
  type ImportJobSummary,
  type ImportRecognitionResult,
  importJobErrorCodeSchema,
  importJobPhaseSchema,
  importJobProviderSnapshotSchema,
  importJobResultSchema,
  importJobStatusSchema,
} from "@enveo/shared";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { importJobImages, importJobs } from "../db/schema";

export const IMPORT_JOB_LEASE_MS = 5 * 60 * 1000;
export const IMPORT_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const IMPORT_JOB_RETRY_IMAGE_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface ImportJobImageInput {
  mimeType: string;
  content: Uint8Array;
}

export interface CreateImportJobInput {
  id: string;
  userId: string;
  budgetId: string;
  accountId: string | null;
  provider: ImportJobProviderSnapshot;
  locale: string;
  tier: "plain" | "e2ee";
  epoch: number;
  images: ImportJobImageInput[];
}

interface StoredImage {
  position: number;
  mimeType: string;
  sha256: string;
  byteLength: number;
  content: Uint8Array;
}

export interface ClaimedImportJob {
  id: string;
  userId: string;
  budgetId: string;
  accountId: string | null;
  provider: ImportJobProviderSnapshot;
  locale: string;
  tier: "plain" | "e2ee";
  epoch: number;
  phase: ImportJobPhase;
  resumePhase: "extracting" | "validating" | "enriching" | "reconciling" | null;
  attempt: number;
  cancelRequested: boolean;
  leaseToken: string;
  leaseExpiresAt: Date;
  extraction: ImportRecognitionResult | null;
  images: StoredImage[];
}

export interface ImportJobCleanupCounts {
  imagesDeleted: number;
  detailsCleared: number;
  jobsDeleted: number;
}

export class ImportJobConflict extends Error {
  readonly code = "import_job_conflict" as const;

  constructor() {
    super("import_job_conflict");
    this.name = "ImportJobConflict";
  }
}

type ImportJobRow = typeof importJobs.$inferSelect;

const sha256 = (value: string | Uint8Array): string => new Bun.CryptoHasher("sha256").update(value).digest("hex");

const prepareImages = (images: readonly ImportJobImageInput[]): StoredImage[] =>
  images.map((image, position) => ({
    position,
    mimeType: image.mimeType,
    sha256: sha256(image.content),
    byteLength: image.content.byteLength,
    content: image.content,
  }));

/** Versioned, fixed-order tuple. Only decoded content hashes enter the image portion, so an
 * idempotent retry does not depend on base64 spelling or transport object key order. */
export function computeImportJobRequestHash(input: CreateImportJobInput): string {
  const imageHashes = input.images.map((image) => sha256(image.content));
  return sha256(
    JSON.stringify([
      "enveo-import-job",
      1,
      input.id,
      input.userId,
      input.budgetId,
      input.accountId,
      input.provider.provider,
      input.provider.model,
      input.locale,
      input.tier,
      input.epoch,
      imageHashes,
    ]),
  );
}

const resumePhase = (value: string | null): ClaimedImportJob["resumePhase"] => {
  if (value === null) return null;
  if (["extracting", "validating", "enriching", "reconciling"].includes(value)) return value as ClaimedImportJob["resumePhase"];
  throw new Error("invalid_import_job_resume_phase");
};

const rowProvider = (row: Pick<ImportJobRow, "provider" | "model">): ImportJobProviderSnapshot =>
  importJobProviderSnapshotSchema.parse({ provider: row.provider, model: row.model });

const rowStatus = (row: Pick<ImportJobRow, "status">): ImportJobStatus => importJobStatusSchema.parse(row.status);
const rowPhase = (row: Pick<ImportJobRow, "phase">): ImportJobPhase => importJobPhaseSchema.parse(row.phase);
const rowError = (row: Pick<ImportJobRow, "errorCode">): ImportJobErrorCode | null =>
  row.errorCode === null ? null : importJobErrorCodeSchema.parse(row.errorCode);

const summaryFromRow = (row: ImportJobRow): ImportJobSummary => ({
  id: row.id,
  budgetId: row.budgetId,
  accountId: row.accountId,
  provider: rowProvider(row),
  tier: row.tier === "e2ee" ? "e2ee" : "plain",
  status: rowStatus(row),
  phase: rowPhase(row),
  resumePhase: resumePhase(row.resumePhase),
  cancelRequested: row.cancelRequested,
  attempt: row.attempt,
  errorCode: rowError(row),
  retryAt: row.retryAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  expiresAt: row.expiresAt.toISOString(),
  proposalCount: row.proposalCount,
});

const detailFromRow = (row: ImportJobRow): ImportJobDetail => ({
  ...summaryFromRow(row),
  locale: row.locale,
  epoch: row.epoch,
  result: row.result === null ? null : importJobResultSchema.parse(row.result),
  appliedCount: row.appliedCount,
  skippedCount: row.skippedCount,
});

const activeLease = (jobId: string, leaseToken: string, now: Date) =>
  and(eq(importJobs.id, jobId), eq(importJobs.status, "running"), eq(importJobs.leaseToken, leaseToken), gt(importJobs.leaseExpiresAt, now));

export function createImportJobRepository(database: DB) {
  return {
    async create(input: CreateImportJobInput, now = new Date()): Promise<{ created: boolean; job: ImportJobDetail }> {
      const requestHash = computeImportJobRequestHash(input);
      const images = prepareImages(input.images);
      return database.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(importJobs)
          .values({
            id: input.id,
            clientId: input.id,
            userId: input.userId,
            budgetId: input.budgetId,
            accountId: input.accountId,
            provider: input.provider.provider,
            model: input.provider.model,
            locale: input.locale,
            tier: input.tier,
            epoch: input.epoch,
            requestHash,
            createdAt: now,
            updatedAt: now,
            expiresAt: new Date(now.getTime() + IMPORT_JOB_RETENTION_MS),
          })
          .onConflictDoNothing({ target: importJobs.id })
          .returning();

        if (!inserted) {
          const [existing] = await tx.select().from(importJobs).where(eq(importJobs.id, input.id));
          if (!existing || existing.userId !== input.userId || existing.requestHash !== requestHash) throw new ImportJobConflict();
          return { created: false, job: detailFromRow(existing) };
        }

        if (images.length > 0) {
          await tx.insert(importJobImages).values(images.map((image) => ({ jobId: input.id, ...image })));
        }
        return { created: true, job: detailFromRow(inserted) };
      });
    },

    async listForUser(userId: string): Promise<ImportJobSummary[]> {
      const rows = await database.select().from(importJobs).where(eq(importJobs.userId, userId)).orderBy(desc(importJobs.updatedAt), desc(importJobs.id));
      return rows.map(summaryFromRow);
    },

    async getForUser(userId: string, id: string): Promise<ImportJobDetail | null> {
      const [row] = await database
        .select()
        .from(importJobs)
        .where(and(eq(importJobs.userId, userId), eq(importJobs.id, id)));
      return row ? detailFromRow(row) : null;
    },

    async requestCancel(userId: string, id: string, now = new Date()): Promise<ImportJobDetail | null> {
      return database.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(importJobs)
          .where(and(eq(importJobs.userId, userId), eq(importJobs.id, id)))
          .for("update");
        if (!current) return null;
        if (current.status === "completed" || current.status === "cancelled") return detailFromRow(current);
        const running = current.status === "running";
        const [updated] = await tx
          .update(importJobs)
          .set(
            running
              ? { cancelRequested: true, updatedAt: now }
              : {
                  status: "cancelled",
                  cancelRequested: true,
                  resumePhase: null,
                  errorCode: null,
                  retryAt: null,
                  extraction: null,
                  result: null,
                  leaseOwner: null,
                  leaseToken: null,
                  leaseExpiresAt: null,
                  updatedAt: now,
                },
          )
          .where(eq(importJobs.id, id))
          .returning();
        if (!running) await tx.delete(importJobImages).where(eq(importJobImages.jobId, id));
        return updated ? detailFromRow(updated) : null;
      });
    },

    async retry(userId: string, id: string, now = new Date()): Promise<ImportJobDetail | null> {
      const [updated] = await database
        .update(importJobs)
        .set({
          status: "queued",
          phase: "queued",
          resumePhase: null,
          cancelRequested: false,
          errorCode: null,
          retryAt: null,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(importJobs.userId, userId),
            eq(importJobs.id, id),
            eq(importJobs.status, "failed"),
            or(isNotNull(importJobs.extraction), sql`exists (select 1 from ${importJobImages} where ${importJobImages.jobId} = ${importJobs.id})`),
          ),
        )
        .returning();
      return updated ? detailFromRow(updated) : null;
    },

    async claimNext(workerId: string, now = new Date()): Promise<ClaimedImportJob | null> {
      return database.transaction(async (tx) => {
        const [candidate] = await tx
          .select()
          .from(importJobs)
          .where(
            or(
              eq(importJobs.status, "queued"),
              and(eq(importJobs.status, "failed"), eq(importJobs.phase, "retry_scheduled"), lte(importJobs.retryAt, now)),
              and(eq(importJobs.status, "running"), lte(importJobs.leaseExpiresAt, now)),
            ),
          )
          .orderBy(asc(importJobs.createdAt), asc(importJobs.id))
          .limit(1)
          .for("update", { skipLocked: true });
        if (!candidate) return null;

        const leaseToken = crypto.randomUUID();
        const leaseExpiresAt = new Date(now.getTime() + IMPORT_JOB_LEASE_MS);
        // Extraction is the only durable processing checkpoint. A reclaimed lease therefore
        // resumes from that boundary instead of trusting a later phase whose work may not have
        // completed before the previous process disappeared.
        const phase = candidate.extraction === null ? "extracting" : "validating";
        const [claimed] = await tx
          .update(importJobs)
          .set({
            status: "running",
            phase,
            resumePhase: null,
            attempt: candidate.attempt + 1,
            errorCode: null,
            retryAt: null,
            leaseOwner: workerId,
            leaseToken,
            leaseExpiresAt,
            updatedAt: now,
          })
          .where(eq(importJobs.id, candidate.id))
          .returning();
        if (!claimed) return null;
        const images = await tx.select().from(importJobImages).where(eq(importJobImages.jobId, candidate.id)).orderBy(importJobImages.position);
        return {
          id: claimed.id,
          userId: claimed.userId,
          budgetId: claimed.budgetId,
          accountId: claimed.accountId,
          provider: rowProvider(claimed),
          locale: claimed.locale,
          tier: claimed.tier === "e2ee" ? "e2ee" : "plain",
          epoch: claimed.epoch,
          phase: rowPhase(claimed),
          resumePhase: resumePhase(claimed.resumePhase),
          attempt: claimed.attempt,
          cancelRequested: claimed.cancelRequested,
          leaseToken,
          leaseExpiresAt,
          extraction: claimed.extraction === null ? null : importJobResultSchema.parse(claimed.extraction),
          images,
        };
      });
    },

    async heartbeat(id: string, leaseToken: string, now = new Date()): Promise<boolean> {
      const updated = await database
        .update(importJobs)
        .set({ leaseExpiresAt: new Date(now.getTime() + IMPORT_JOB_LEASE_MS), updatedAt: now })
        .where(activeLease(id, leaseToken, now))
        .returning({ id: importJobs.id });
      return updated.length === 1;
    },

    async advancePhase(id: string, leaseToken: string, phase: "enriching" | "reconciling", now = new Date()): Promise<boolean> {
      const allowedFrom = phase === "enriching" ? ["validating", "enriching"] : ["validating", "enriching", "reconciling"];
      const updated = await database
        .update(importJobs)
        .set({ phase, leaseExpiresAt: new Date(now.getTime() + IMPORT_JOB_LEASE_MS), updatedAt: now })
        .where(and(activeLease(id, leaseToken, now), eq(importJobs.cancelRequested, false), inArray(importJobs.phase, allowedFrom)))
        .returning({ id: importJobs.id });
      return updated.length === 1;
    },

    async saveExtractionAndDeleteImages(id: string, leaseToken: string, extraction: ImportRecognitionResult, now = new Date()): Promise<boolean> {
      const normalized = importJobResultSchema.parse(extraction);
      return database.transaction(async (tx) => {
        const updated = await tx
          .update(importJobs)
          .set({
            extraction: normalized,
            phase: "validating",
            resumePhase: null,
            leaseExpiresAt: new Date(now.getTime() + IMPORT_JOB_LEASE_MS),
            updatedAt: now,
          })
          .where(and(activeLease(id, leaseToken, now), eq(importJobs.cancelRequested, false), eq(importJobs.phase, "extracting")))
          .returning({ id: importJobs.id });
        if (updated.length !== 1) return false;
        await tx.delete(importJobImages).where(eq(importJobImages.jobId, id));
        return true;
      });
    },

    async saveReadyResult(id: string, leaseToken: string, result: ImportRecognitionResult, now = new Date()): Promise<boolean> {
      const normalized = importJobResultSchema.parse(result);
      const updated = await database
        .update(importJobs)
        .set({
          status: "ready",
          phase: "ready",
          resumePhase: null,
          result: normalized,
          proposalCount: normalized.proposals.length,
          errorCode: null,
          retryAt: null,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(and(activeLease(id, leaseToken, now), eq(importJobs.cancelRequested, false), eq(importJobs.phase, "reconciling")))
        .returning({ id: importJobs.id });
      return updated.length === 1;
    },

    async scheduleRetry(id: string, leaseToken: string, errorCode: ImportJobErrorCode, retryAt: Date, now = new Date()): Promise<boolean> {
      const normalizedError = importJobErrorCodeSchema.parse(errorCode);
      const updated = await database
        .update(importJobs)
        .set({
          status: "failed",
          phase: "retry_scheduled",
          resumePhase: null,
          errorCode: normalizedError,
          retryAt,
          leaseOwner: null,
          leaseToken: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(and(activeLease(id, leaseToken, now), eq(importJobs.cancelRequested, false)))
        .returning({ id: importJobs.id });
      return updated.length === 1;
    },

    async failPermanently(id: string, leaseToken: string, errorCode: ImportJobErrorCode, now = new Date()): Promise<boolean> {
      return database.transaction(async (tx) => {
        const updated = await tx
          .update(importJobs)
          .set({
            status: "failed",
            resumePhase: null,
            errorCode: importJobErrorCodeSchema.parse(errorCode),
            retryAt: null,
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: now,
          })
          .where(and(activeLease(id, leaseToken, now), eq(importJobs.cancelRequested, false)))
          .returning({ id: importJobs.id });
        if (updated.length !== 1) return false;
        await tx.delete(importJobImages).where(eq(importJobImages.jobId, id));
        return true;
      });
    },

    async finishCancellation(id: string, leaseToken: string, now = new Date()): Promise<boolean> {
      return database.transaction(async (tx) => {
        const updated = await tx
          .update(importJobs)
          .set({
            status: "cancelled",
            resumePhase: null,
            errorCode: null,
            retryAt: null,
            extraction: null,
            result: null,
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: now,
          })
          .where(and(activeLease(id, leaseToken, now), eq(importJobs.cancelRequested, true)))
          .returning({ id: importJobs.id });
        if (updated.length !== 1) return false;
        await tx.delete(importJobImages).where(eq(importJobImages.jobId, id));
        return true;
      });
    },

    async markCompleted(userId: string, id: string, appliedCount: number, skippedCount: number, now = new Date()): Promise<ImportJobDetail | null> {
      const [updated] = await database
        .update(importJobs)
        .set({
          status: "completed",
          phase: "completed",
          resumePhase: null,
          extraction: null,
          result: null,
          appliedCount,
          skippedCount,
          updatedAt: now,
        })
        .where(and(eq(importJobs.userId, userId), eq(importJobs.id, id), eq(importJobs.status, "ready"), eq(importJobs.cancelRequested, false)))
        .returning();
      return updated ? detailFromRow(updated) : null;
    },

    async cleanupExpired(now = new Date()): Promise<ImportJobCleanupCounts> {
      return database.transaction(async (tx) => {
        const retryCutoff = new Date(now.getTime() - IMPORT_JOB_RETRY_IMAGE_RETENTION_MS);
        const imageJobs = await tx
          .select({ id: importJobs.id })
          .from(importJobs)
          .where(
            or(
              eq(importJobs.status, "cancelled"),
              and(eq(importJobs.status, "failed"), isNull(importJobs.retryAt)),
              and(eq(importJobs.status, "failed"), isNotNull(importJobs.retryAt), lte(importJobs.updatedAt, retryCutoff)),
            ),
          );
        const deletedImages =
          imageJobs.length === 0
            ? []
            : await tx
                .delete(importJobImages)
                .where(
                  inArray(
                    importJobImages.jobId,
                    imageJobs.map((job) => job.id),
                  ),
                )
                .returning({ jobId: importJobImages.jobId });
        const clearedDetails = await tx
          .update(importJobs)
          .set({ extraction: null, result: null })
          .where(and(inArray(importJobs.status, ["completed", "cancelled"]), or(isNotNull(importJobs.extraction), isNotNull(importJobs.result))))
          .returning({ id: importJobs.id });
        const deletedJobs = await tx.delete(importJobs).where(lte(importJobs.expiresAt, now)).returning({ id: importJobs.id });
        return { imagesDeleted: deletedImages.length, detailsCleared: clearedDetails.length, jobsDeleted: deletedJobs.length };
      });
    },
  };
}

export type ImportJobRepository = ReturnType<typeof createImportJobRepository>;
