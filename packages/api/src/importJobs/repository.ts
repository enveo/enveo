import type { ImportReceipt } from "@enveo/shared";
import {
  IMPORT_JOB_CHUNK_SIZE,
  type ImportExtractBatch,
  type ImportJobDetail,
  type ImportJobErrorCode,
  type ImportJobPhase,
  type ImportJobProviderSnapshot,
  type ImportJobStatus,
  type ImportJobSummary,
  type ImportRecognitionResult,
  importExtractBatchSchema,
  importImageChunks,
  importJobErrorCodeSchema,
  importJobPhaseSchema,
  importJobProviderSnapshotSchema,
  importJobResultSchema,
  importJobStatusSchema,
} from "@enveo/shared";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lt, lte, or, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { accounts, budgets, importJobChunks, importJobImages, importJobs } from "../db/schema";

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

export interface ClaimedImportChunk {
  index: number;
  start: number;
  end: number;
  attempt: number;
  status: "pending" | "extracted" | "failed";
  errorCode: ImportJobErrorCode | null;
  retryAt: Date | null;
  extraction: ImportExtractBatch | null;
}

export interface ImportChunkFailure {
  errorCode: ImportJobErrorCode;
  /** null ⇒ the chunk exhausted its attempts and is skipped by the finished job. */
  retryAt: Date | null;
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
  /** Screenshots still retained (positions of chunks not yet extracted). */
  images: StoredImage[];
  screenshotTotal: number;
  /** Empty for a job created before chunking (its retained images are read as one window). */
  chunks: ClaimedImportChunk[];
}

export interface ImportJobCleanupCounts {
  imagesDeleted: number;
  detailsCleared: number;
  jobsDeleted: number;
}

export type ImportJobClaimContext = "valid" | "lease_lost" | "cancel_requested" | "cancelled" | "tier_mismatch" | "budget_mismatch" | "account_unavailable";

export class ImportJobConflict extends Error {
  readonly code = "import_job_conflict" as const;

  constructor() {
    super("import_job_conflict");
    this.name = "ImportJobConflict";
  }
}

type ImportJobRow = typeof importJobs.$inferSelect;
type ImportJobChunkRow = typeof importJobChunks.$inferSelect;

/** One SQL condition: a position is still needed by some window that has not been extracted. */
const positionStillNeeded = (jobId: string, position: typeof importJobImages.position) =>
  sql`exists (select 1 from ${importJobChunks} c where c.job_id = ${jobId} and c.status <> 'extracted' and ${position} >= c.image_start and ${position} < c.image_end)`;

/** Denormalized screenshot counters over DISTINCT positions — windows overlap by one screenshot,
 *  so summing window sizes would exceed the total and violate the counter check. */
async function recountScreenshots(tx: Pick<DB, "execute">, jobId: string, now: Date): Promise<void> {
  await tx.execute(sql`
    update ${importJobs} j set
      screenshots_read = (
        select count(*) from generate_series(0, greatest(j.screenshot_total, 1) - 1) p
        where p < j.screenshot_total
          and exists (select 1 from ${importJobChunks} c where c.job_id = j.id and c.status = 'extracted' and p >= c.image_start and p < c.image_end)
      ),
      screenshots_failed = (
        select count(*) from generate_series(0, greatest(j.screenshot_total, 1) - 1) p
        where p < j.screenshot_total
          and exists (select 1 from ${importJobChunks} c where c.job_id = j.id and c.status = 'failed' and p >= c.image_start and p < c.image_end)
          and not exists (select 1 from ${importJobChunks} c where c.job_id = j.id and c.status = 'extracted' and p >= c.image_start and p < c.image_end)
      ),
      updated_at = ${now.toISOString()}::timestamptz
    where j.id = ${jobId}`);
}

const chunkRowsFor = (jobId: string, imageCount: number, now: Date) =>
  importImageChunks(imageCount, IMPORT_JOB_CHUNK_SIZE).map((chunk) => ({
    jobId,
    chunkIndex: chunk.index,
    imageStart: chunk.start,
    imageEnd: chunk.end,
    status: "pending" as const,
    attempt: 0,
    errorCode: null,
    retryAt: null,
    extraction: null,
    updatedAt: now,
  }));

const claimedChunk = (row: ImportJobChunkRow): ClaimedImportChunk => ({
  index: row.chunkIndex,
  start: row.imageStart,
  end: row.imageEnd,
  attempt: row.attempt,
  status: row.status === "extracted" ? "extracted" : row.status === "failed" ? "failed" : "pending",
  errorCode: row.errorCode === null ? null : importJobErrorCodeSchema.parse(row.errorCode),
  retryAt: row.retryAt,
  extraction: row.extraction === null ? null : importExtractBatchSchema.parse(row.extraction),
});

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
  screenshots: { total: row.screenshotTotal, read: row.screenshotsRead, failed: row.screenshotsFailed },
  partialFailure: row.partialRetryJobId === null ? null : { retryJobId: row.partialRetryJobId, imageCount: row.partialImageCount },
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
            screenshotTotal: images.length,
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
          await tx.insert(importJobChunks).values(chunkRowsFor(input.id, images.length, now));
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

    async getForBudget(userId: string, budgetId: string, id: string): Promise<ImportJobDetail | null> {
      const [row] = await database
        .select()
        .from(importJobs)
        .where(and(eq(importJobs.userId, userId), eq(importJobs.budgetId, budgetId), eq(importJobs.id, id)));
      return row ? detailFromRow(row) : null;
    },

    async deleteMany(userId: string, budgetId: string, ids: string[]): Promise<number> {
      if (ids.length === 0) return 0;
      const deleted = await database
        .delete(importJobs)
        .where(
          and(
            eq(importJobs.userId, userId),
            eq(importJobs.budgetId, budgetId),
            inArray(importJobs.id, ids),
            inArray(importJobs.status, ["ready", "failed", "completed", "cancelled"]),
          ),
        )
        .returning({ id: importJobs.id });
      return deleted.length;
    },

    async requestCancel(userId: string, budgetId: string, id: string, now = new Date()): Promise<ImportJobDetail | null> {
      return database.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(importJobs)
          .where(and(eq(importJobs.userId, userId), eq(importJobs.budgetId, budgetId), eq(importJobs.id, id)))
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
          .where(and(eq(importJobs.userId, userId), eq(importJobs.budgetId, budgetId), eq(importJobs.id, id)))
          .returning();
        if (!running) {
          await tx.delete(importJobImages).where(eq(importJobImages.jobId, id));
          await tx.delete(importJobChunks).where(eq(importJobChunks.jobId, id));
        }
        return updated ? detailFromRow(updated) : null;
      });
    },

    async retry(userId: string, budgetId: string, id: string, now = new Date()): Promise<ImportJobDetail | null> {
      return database.transaction(async (tx) => {
        const [updated] = await tx
          .update(importJobs)
          .set({
            status: "queued",
            phase: "queued",
            resumePhase: null,
            cancelRequested: false,
            errorCode: null,
            retryAt: null,
            attempt: 0,
            screenshotsFailed: 0,
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(importJobs.userId, userId),
              eq(importJobs.budgetId, budgetId),
              eq(importJobs.id, id),
              eq(importJobs.status, "failed"),
              or(isNotNull(importJobs.extraction), sql`exists (select 1 from ${importJobImages} where ${importJobImages.jobId} = ${importJobs.id})`),
            ),
          )
          .returning();
        if (!updated) return null;
        // A manual retry gives every unread window a fresh set of attempts; extracted windows stay.
        await tx
          .update(importJobChunks)
          .set({ status: "pending", attempt: 0, errorCode: null, retryAt: null, updatedAt: now })
          .where(and(eq(importJobChunks.jobId, id), inArray(importJobChunks.status, ["pending", "failed"])));
        await recountScreenshots(tx, id, now);
        const [current] = await tx.select().from(importJobs).where(eq(importJobs.id, id));
        return current ? detailFromRow(current) : detailFromRow(updated);
      });
    },

    async claimNext(workerId: string, now = new Date()): Promise<ClaimedImportJob | null> {
      return database.transaction(async (tx) => {
        const cancelled = await tx
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
          .where(and(eq(importJobs.status, "running"), eq(importJobs.cancelRequested, true), lte(importJobs.leaseExpiresAt, now)))
          .returning({ id: importJobs.id });
        await tx
          .update(importJobs)
          .set({
            status: "failed",
            resumePhase: null,
            errorCode: "network",
            retryAt: null,
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: now,
          })
          .where(and(eq(importJobs.status, "running"), eq(importJobs.cancelRequested, false), gte(importJobs.attempt, 3), lte(importJobs.leaseExpiresAt, now)));
        const terminalIds = cancelled.map((row) => row.id);
        if (terminalIds.length > 0) {
          await tx.delete(importJobImages).where(inArray(importJobImages.jobId, terminalIds));
          await tx.delete(importJobChunks).where(inArray(importJobChunks.jobId, terminalIds));
        }

        const [candidate] = await tx
          .select()
          .from(importJobs)
          .where(
            and(
              lt(importJobs.attempt, 3),
              or(
                eq(importJobs.status, "queued"),
                and(eq(importJobs.status, "failed"), eq(importJobs.phase, "retry_scheduled"), lte(importJobs.retryAt, now)),
                and(eq(importJobs.status, "running"), lte(importJobs.leaseExpiresAt, now)),
              ),
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
        const chunkRows = await tx.select().from(importJobChunks).where(eq(importJobChunks.jobId, candidate.id)).orderBy(importJobChunks.chunkIndex);
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
          screenshotTotal: claimed.screenshotTotal,
          chunks: chunkRows.map(claimedChunk),
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

    async validateClaimContext(
      job: Pick<ClaimedImportJob, "id" | "userId" | "budgetId" | "accountId" | "tier" | "epoch" | "leaseToken">,
      now = new Date(),
    ): Promise<ImportJobClaimContext> {
      const [current] = await database
        .select({
          userId: importJobs.userId,
          budgetId: importJobs.budgetId,
          accountId: importJobs.accountId,
          tier: importJobs.tier,
          epoch: importJobs.epoch,
          status: importJobs.status,
          cancelRequested: importJobs.cancelRequested,
          leaseToken: importJobs.leaseToken,
          leaseExpiresAt: importJobs.leaseExpiresAt,
          budgetUserId: budgets.userId,
          budgetTier: budgets.tier,
          budgetEpoch: budgets.epoch,
          liveAccountId: accounts.id,
          accountBudgetId: accounts.budgetId,
          accountArchived: accounts.archived,
        })
        .from(importJobs)
        .leftJoin(budgets, eq(budgets.id, importJobs.budgetId))
        .leftJoin(accounts, eq(accounts.id, importJobs.accountId))
        .where(eq(importJobs.id, job.id))
        .limit(1);
      if (!current) return "lease_lost";
      if (current.status === "cancelled") return "cancelled";
      if (current.cancelRequested) return "cancel_requested";
      if (current.status !== "running" || current.leaseToken !== job.leaseToken || current.leaseExpiresAt === null || current.leaseExpiresAt <= now) {
        return "lease_lost";
      }
      if (current.userId !== job.userId || current.budgetId !== job.budgetId || current.budgetUserId !== job.userId) return "budget_mismatch";
      if (
        job.tier !== "plain" ||
        current.tier !== job.tier ||
        current.epoch !== job.epoch ||
        current.budgetTier !== "plain" ||
        current.budgetEpoch !== job.epoch
      ) {
        return "tier_mismatch";
      }
      if (
        !job.accountId ||
        current.accountId !== job.accountId ||
        current.liveAccountId !== job.accountId ||
        current.accountBudgetId !== job.budgetId ||
        current.accountArchived !== false
      ) {
        return "account_unavailable";
      }
      return "valid";
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

    /** One window of cycle one is durable: its extraction is kept and its screenshots released. */
    async saveChunkExtraction(id: string, leaseToken: string, chunkIndex: number, batch: ImportExtractBatch, now = new Date()): Promise<boolean> {
      const normalized = importExtractBatchSchema.parse(batch);
      return database.transaction(async (tx) => {
        const [job] = await tx
          .select({ id: importJobs.id })
          .from(importJobs)
          .where(and(activeLease(id, leaseToken, now), eq(importJobs.cancelRequested, false), eq(importJobs.phase, "extracting")))
          .for("update");
        if (!job) return false;
        const [chunk] = await tx
          .update(importJobChunks)
          .set({ status: "extracted", extraction: normalized, errorCode: null, retryAt: null, updatedAt: now })
          .where(and(eq(importJobChunks.jobId, id), eq(importJobChunks.chunkIndex, chunkIndex), inArray(importJobChunks.status, ["pending", "failed"])))
          .returning({ start: importJobChunks.imageStart, end: importJobChunks.imageEnd });
        if (!chunk) return false;
        // The screenshot shared with a neighbouring window stays until that window is done too.
        await tx
          .delete(importJobImages)
          .where(
            and(
              eq(importJobImages.jobId, id),
              gte(importJobImages.position, chunk.start),
              lt(importJobImages.position, chunk.end),
              sql`not ${positionStillNeeded(id, importJobImages.position)}`,
            ),
          );
        await recountScreenshots(tx, id, now);
        await tx
          .update(importJobs)
          .set({ leaseExpiresAt: new Date(now.getTime() + IMPORT_JOB_LEASE_MS), updatedAt: now })
          .where(eq(importJobs.id, id));
        return true;
      });
    },

    /** Records one window's failed attempt; a null retryAt makes the window permanently unread. */
    async failChunk(id: string, leaseToken: string, chunkIndex: number, failure: ImportChunkFailure, now = new Date()): Promise<boolean> {
      const errorCode = importJobErrorCodeSchema.parse(failure.errorCode);
      return database.transaction(async (tx) => {
        const [job] = await tx
          .select({ id: importJobs.id })
          .from(importJobs)
          .where(and(activeLease(id, leaseToken, now), eq(importJobs.cancelRequested, false), eq(importJobs.phase, "extracting")))
          .for("update");
        if (!job) return false;
        const [chunk] = await tx
          .update(importJobChunks)
          .set({
            status: failure.retryAt === null ? "failed" : "pending",
            attempt: sql`${importJobChunks.attempt} + 1`,
            errorCode,
            retryAt: failure.retryAt,
            updatedAt: now,
          })
          .where(and(eq(importJobChunks.jobId, id), eq(importJobChunks.chunkIndex, chunkIndex), eq(importJobChunks.status, "pending")))
          .returning({ start: importJobChunks.imageStart, end: importJobChunks.imageEnd });
        if (!chunk) return false;
        await recountScreenshots(tx, id, now);
        await tx
          .update(importJobs)
          .set({ leaseExpiresAt: new Date(now.getTime() + IMPORT_JOB_LEASE_MS), updatedAt: now })
          .where(eq(importJobs.id, id));
        return true;
      });
    },

    /** The merged Stage A checkpoint. Screenshots of unread windows are kept for the partial-retry
     * child job created with the ready result; `attempt` restarts because the post-extraction
     * stage (seam, enrichment, reconciliation) gets its own retry budget. */
    async saveExtractionAndDeleteImages(id: string, leaseToken: string, extraction: ImportRecognitionResult, now = new Date()): Promise<boolean> {
      const normalized = importJobResultSchema.parse(extraction);
      return database.transaction(async (tx) => {
        const updated = await tx
          .update(importJobs)
          .set({
            extraction: normalized,
            phase: "validating",
            resumePhase: null,
            attempt: 1,
            leaseExpiresAt: new Date(now.getTime() + IMPORT_JOB_LEASE_MS),
            updatedAt: now,
          })
          .where(and(activeLease(id, leaseToken, now), eq(importJobs.cancelRequested, false), eq(importJobs.phase, "extracting")))
          .returning({ id: importJobs.id });
        if (updated.length !== 1) return false;
        await tx.delete(importJobImages).where(
          and(
            eq(importJobImages.jobId, id),
            sql`(not exists (select 1 from ${importJobChunks} c where c.job_id = ${importJobImages.jobId} and c.status = 'failed' and ${importJobImages.position} >= c.image_start and ${importJobImages.position} < c.image_end)
                or exists (select 1 from ${importJobChunks} c where c.job_id = ${importJobImages.jobId} and c.status = 'extracted' and ${importJobImages.position} >= c.image_start and ${importJobImages.position} < c.image_end))`,
          ),
        );
        return true;
      });
    },

    /** Publishes the reviewable result. Screenshots the job could not read move, in the same
     * transaction, into a new failed child job so the ordinary retry path re-reads them without a
     * new upload — the parent ends with no images, as a ready job must. */
    async saveReadyResult(id: string, leaseToken: string, result: ImportRecognitionResult, now = new Date()): Promise<boolean> {
      const normalized = importJobResultSchema.parse(result);
      return database.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(importJobs)
          .where(and(activeLease(id, leaseToken, now), eq(importJobs.cancelRequested, false), eq(importJobs.phase, "reconciling")))
          .for("update");
        if (!current) return false;

        const failedChunks = await tx
          .select()
          .from(importJobChunks)
          .where(and(eq(importJobChunks.jobId, id), eq(importJobChunks.status, "failed")))
          .orderBy(importJobChunks.chunkIndex);
        const unread = await tx.select().from(importJobImages).where(eq(importJobImages.jobId, id)).orderBy(importJobImages.position);
        let partial: { retryJobId: string; imageCount: number } | null = null;
        if (unread.length > 0 && failedChunks.length > 0) {
          const childId = crypto.randomUUID();
          const childInput: CreateImportJobInput = {
            id: childId,
            userId: current.userId,
            budgetId: current.budgetId,
            accountId: current.accountId,
            provider: rowProvider(current),
            locale: current.locale,
            tier: current.tier === "e2ee" ? "e2ee" : "plain",
            epoch: current.epoch,
            images: unread.map((image) => ({ mimeType: image.mimeType, content: image.content })),
          };
          await tx.insert(importJobs).values({
            id: childId,
            clientId: childId,
            userId: current.userId,
            budgetId: current.budgetId,
            accountId: current.accountId,
            provider: current.provider,
            model: current.model,
            locale: current.locale,
            tier: current.tier,
            epoch: current.epoch,
            requestHash: computeImportJobRequestHash(childInput),
            status: "failed",
            phase: "extracting",
            errorCode: failedChunks[0]!.errorCode ?? "network",
            screenshotTotal: unread.length,
            createdAt: now,
            updatedAt: now,
            expiresAt: new Date(now.getTime() + IMPORT_JOB_RETENTION_MS),
          });
          await tx.insert(importJobChunks).values(chunkRowsFor(childId, unread.length, now));
          for (const [position, image] of unread.entries()) {
            await tx
              .update(importJobImages)
              .set({ jobId: childId, position })
              .where(and(eq(importJobImages.jobId, id), eq(importJobImages.position, image.position)));
          }
          partial = { retryJobId: childId, imageCount: unread.length };
        } else if (unread.length > 0) {
          await tx.delete(importJobImages).where(eq(importJobImages.jobId, id));
        }

        const updated = await tx
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
            partialRetryJobId: partial?.retryJobId ?? null,
            partialImageCount: partial?.imageCount ?? 0,
            updatedAt: now,
            expiresAt: new Date(now.getTime() + IMPORT_JOB_RETENTION_MS),
          })
          .where(eq(importJobs.id, id))
          .returning({ id: importJobs.id });
        return updated.length === 1;
      });
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
            result: null,
            proposalCount: 0,
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAt: null,
            updatedAt: now,
          })
          .where(and(activeLease(id, leaseToken, now), eq(importJobs.cancelRequested, false)))
          .returning({ id: importJobs.id });
        if (updated.length !== 1) return false;
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
        await tx.delete(importJobChunks).where(eq(importJobChunks.jobId, id));
        return true;
      });
    },

    async markCompleted(
      userId: string,
      budgetId: string,
      id: string,
      appliedCount: number,
      skippedCount: number,
      now = new Date(),
      receipt?: ImportReceipt,
    ): Promise<ImportJobDetail | null> {
      const [updated] = await database
        .update(importJobs)
        .set({
          status: "completed",
          phase: "completed",
          resumePhase: null,
          extraction: null,
          result: receipt ? { rows: [], proposals: [], receipt } : null,
          appliedCount,
          skippedCount,
          updatedAt: now,
        })
        .where(
          and(
            eq(importJobs.userId, userId),
            eq(importJobs.budgetId, budgetId),
            eq(importJobs.id, id),
            eq(importJobs.status, "ready"),
            eq(importJobs.cancelRequested, false),
          ),
        )
        .returning();
      if (updated) await database.delete(importJobChunks).where(eq(importJobChunks.jobId, id));
      return updated ? detailFromRow(updated) : null;
    },

    async cleanupExpired(now = new Date()): Promise<ImportJobCleanupCounts> {
      return database.transaction(async (tx) => {
        const retryCutoff = new Date(now.getTime() - IMPORT_JOB_RETRY_IMAGE_RETENTION_MS);
        const imageJobs = await tx
          .select({ id: importJobs.id })
          .from(importJobs)
          .where(or(eq(importJobs.status, "cancelled"), and(eq(importJobs.status, "failed"), lte(importJobs.updatedAt, retryCutoff))))
          .for("update");
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
        if (imageJobs.length > 0) {
          await tx
            .update(importJobs)
            .set({
              phase: "extracting",
              resumePhase: null,
              errorCode: "expired",
              retryAt: null,
              extraction: null,
              result: null,
              screenshotsRead: 0,
              screenshotsFailed: 0,
            })
            .where(
              and(
                eq(importJobs.status, "failed"),
                inArray(
                  importJobs.id,
                  imageJobs.map((job) => job.id),
                ),
              ),
            );
          await tx.delete(importJobChunks).where(
            inArray(
              importJobChunks.jobId,
              imageJobs.map((job) => job.id),
            ),
          );
        }
        const clearedDetails = await tx
          .update(importJobs)
          .set({ extraction: null, result: null })
          .where(
            and(
              or(eq(importJobs.status, "cancelled"), and(eq(importJobs.status, "completed"), sql`${importJobs.result}->'receipt' IS NULL`)),
              or(isNotNull(importJobs.extraction), isNotNull(importJobs.result)),
            ),
          )
          .returning({ id: importJobs.id });
        await tx
          .delete(importJobChunks)
          .where(sql`${importJobChunks.jobId} in (select ${importJobs.id} from ${importJobs} where ${importJobs.status} in ('completed', 'cancelled'))`);
        const deletedJobs = await tx.delete(importJobs).where(lte(importJobs.expiresAt, now)).returning({ id: importJobs.id });
        return { imagesDeleted: deletedImages.length, detailsCleared: clearedDetails.length, jobsDeleted: deletedJobs.length };
      });
    },
  };
}

export type ImportJobRepository = ReturnType<typeof createImportJobRepository>;
