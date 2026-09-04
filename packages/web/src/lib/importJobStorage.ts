import type {
  AiLocale,
  ImportJobDetail,
  ImportJobPartialFailure,
  ImportJobProgress,
  ImportJobProviderSnapshot,
  ImportJobScreenshotProgress,
} from "@enveo/shared";
import {
  idbDelete,
  idbDeleteExpiredImportDrafts,
  idbDeleteImportDraftIfMatches,
  idbDeleteImportJobIfScope,
  idbDeleteImportJobWithMetaIfScope,
  idbGet,
  idbGetAll,
  idbImportTransactionProof,
  idbMutateImportDraftState,
  idbMutateMeta,
  idbPut,
  idbPutImportDraftIfAbsentOrSame,
  idbPutImportJobForScope,
  idbPutImportJobIfRevision,
} from "./idb";

export const IMPORT_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export interface PlainImportUploadDraftInput {
  id: string;
  ownerId: string;
  budgetId: string;
  accountId: string;
  locale: AiLocale;
  /** Already-compressed image data URLs, byte-for-byte identical on retry. */
  images: string[];
}

export interface PlainImportUploadDraft extends PlainImportUploadDraftInput {
  requestHash: string;
  /** Set before the first create request, so a later cancellation can reconcile an ambiguous acknowledgement. */
  uploadAttemptedAt: string | null;
  /** Durable cancel tombstone retained until a possibly accepted create has been cancelled. */
  cancelRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface StoredE2eeImportJob extends ImportJobProgress {
  id: string;
  ownerId: string;
  budgetId: string;
  accountId: string;
  provider: ImportJobProviderSnapshot & { provider: "openai" };
  locale: AiLocale;
  tier: "e2ee";
  epoch: number;
  /** `{ images: (string | null)[] }` — a read window's screenshots are nulled in place. */
  inputCiphertext: string | null;
  /** Per-window cycle-one state (`{ chunks: [...] }`), present only while windows are being read. */
  chunkCiphertext: string | null;
  checkpointCiphertext: string | null;
  resultCiphertext: string | null;
  /** Optimistic phase-write fence for duplicate browser runners. */
  checkpointRevision: number;
  proposalCount: number;
  screenshots: ImportJobScreenshotProgress;
  partialFailure: ImportJobPartialFailure | null;
  appliedCount: number;
  skippedCount: number;
  createdAt: string;
  expiresAt: string;
}

export type PlainImportDraftAcknowledgement = Pick<ImportJobDetail, "id" | "budgetId" | "accountId" | "locale" | "tier">;

export interface ImportJobStorageScope {
  /** Authenticated replica owner (user id), never a ledger/bank account id. */
  ownerId: string;
  budgetId: string;
}

export interface ImportApplyProgress {
  appliedRowIds: string[];
  appliedCount: number;
  skippedRowIds: string[];
  skippedCount: number;
}

export interface ImportPreparedRow {
  rowToken: string;
  transactionId: string;
  leaseOwner: string | null;
  leaseUntil: number;
  fence: number;
}

export interface StoredImportApplyProgress extends ImportApplyProgress {
  preparedRows: ImportPreparedRow[];
}

const listeners = new Map<string, Set<() => void>>();

function scopeKey(scope: ImportJobStorageScope): string {
  return JSON.stringify([scope.ownerId, scope.budgetId]);
}

function applyProgressKey(scope: ImportJobStorageScope, id: string): string {
  return JSON.stringify(["import-apply-progress", 3, scope.ownerId, scope.budgetId, id]);
}

function legacyApplyProgressKey(scope: ImportJobStorageScope, id: string): string {
  return JSON.stringify(["import-apply-progress", 2, scope.ownerId, scope.budgetId, id]);
}

function oldestApplyProgressKey(scope: ImportJobStorageScope, id: string): string {
  return JSON.stringify(["import-apply-progress", 1, scope.ownerId, scope.budgetId, id]);
}

const emptyApplyProgress = (): ImportApplyProgress => ({ appliedRowIds: [], appliedCount: 0, skippedRowIds: [], skippedCount: 0 });

function distinctRowIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((rowId): rowId is string => typeof rowId === "string" && rowId.length > 0))];
}

function normalizedApplyProgress(value: unknown): StoredImportApplyProgress {
  if (!value || typeof value !== "object") return { ...emptyApplyProgress(), preparedRows: [] };
  const record = value as { appliedRowIds?: unknown; skippedRowIds?: unknown; preparedRows?: unknown };
  const appliedRowIds = distinctRowIds(record.appliedRowIds);
  const skippedRowIds = distinctRowIds(record.skippedRowIds).filter((rowId) => !appliedRowIds.includes(rowId));
  const preparedRows = Array.isArray(record.preparedRows)
    ? [
        ...new Map(
          record.preparedRows.flatMap((entry) => {
            if (!entry || typeof entry !== "object") return [];
            const prepared = entry as {
              rowToken?: unknown;
              transactionId?: unknown;
              leaseOwner?: unknown;
              leaseUntil?: unknown;
              fence?: unknown;
            };
            return typeof prepared.rowToken === "string" &&
              prepared.rowToken.length > 0 &&
              typeof prepared.transactionId === "string" &&
              prepared.transactionId.length > 0 &&
              (prepared.leaseOwner === null || typeof prepared.leaseOwner === "string") &&
              typeof prepared.leaseUntil === "number" &&
              Number.isFinite(prepared.leaseUntil) &&
              typeof prepared.fence === "number" &&
              Number.isSafeInteger(prepared.fence) &&
              prepared.fence > 0
              ? [
                  [
                    prepared.rowToken,
                    {
                      rowToken: prepared.rowToken,
                      transactionId: prepared.transactionId,
                      leaseOwner: prepared.leaseOwner,
                      leaseUntil: prepared.leaseUntil,
                      fence: prepared.fence,
                    },
                  ] as const,
                ]
              : [];
          }),
        ).values(),
      ].filter((entry) => !appliedRowIds.includes(entry.rowToken) && !skippedRowIds.includes(entry.rowToken))
    : [];
  return { appliedRowIds, appliedCount: appliedRowIds.length, skippedRowIds, skippedCount: skippedRowIds.length, preparedRows };
}

function inScope(value: { ownerId: string; budgetId: string }, scope: ImportJobStorageScope): boolean {
  return value.ownerId === scope.ownerId && value.budgetId === scope.budgetId;
}

function assertValidScope(scope: ImportJobStorageScope): void {
  if (!scope.ownerId || !scope.budgetId) throw new Error("invalid_import_storage_scope");
}

function assertScope(value: { ownerId: string; budgetId: string }, scope: ImportJobStorageScope): void {
  assertValidScope(scope);
  if (!inScope(value, scope)) throw new Error("import_storage_scope_mismatch");
}

function notify(scope: ImportJobStorageScope): void {
  for (const listener of listeners.get(scopeKey(scope)) ?? []) listener();
}

const textEncoder = new TextEncoder();

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Fixed-order client upload identity. It protects the same-id retry boundary from an
 * accidental local payload replacement; the server independently hashes decoded content
 * plus its authoritative user/provider snapshot. */
async function requestHash(input: PlainImportUploadDraftInput): Promise<string> {
  return sha256Hex(JSON.stringify(["enveo-import-upload-draft", 1, input.id, input.budgetId, input.accountId, input.locale, input.images]));
}

function copyDraft(input: PlainImportUploadDraftInput, hash: string, now: Date): PlainImportUploadDraft {
  const createdAt = now.toISOString();
  return {
    id: input.id,
    ownerId: input.ownerId,
    budgetId: input.budgetId,
    accountId: input.accountId,
    locale: input.locale,
    images: [...input.images],
    requestHash: hash,
    uploadAttemptedAt: null,
    cancelRequestedAt: null,
    createdAt,
    updatedAt: createdAt,
    expiresAt: new Date(now.getTime() + IMPORT_DRAFT_TTL_MS).toISOString(),
  };
}

function normalizedDraft(draft: PlainImportUploadDraft): PlainImportUploadDraft {
  return {
    ...draft,
    images: [...draft.images],
    uploadAttemptedAt: typeof draft.uploadAttemptedAt === "string" ? draft.uploadAttemptedAt : null,
    cancelRequestedAt: typeof draft.cancelRequestedAt === "string" ? draft.cancelRequestedAt : null,
  };
}

function ciphertext(value: string | null): string | null {
  if (value !== null && !value.startsWith("v2.")) throw new Error("bad_ciphertext");
  return value;
}

/** Project onto the persistence allowlist. Extra runtime properties (image data URLs,
 * plaintext checkpoints/results, prompts, keys) can never cross this boundary. */
function persistedJob(job: StoredE2eeImportJob): StoredE2eeImportJob {
  if (job.tier !== "e2ee" || job.provider.provider !== "openai") throw new Error("invalid_import_job");
  return {
    id: job.id,
    ownerId: job.ownerId,
    budgetId: job.budgetId,
    accountId: job.accountId,
    provider: { provider: "openai", model: job.provider.model },
    locale: job.locale,
    tier: "e2ee",
    epoch: job.epoch,
    status: job.status,
    phase: job.phase,
    resumePhase: job.resumePhase,
    cancelRequested: job.cancelRequested,
    attempt: job.attempt,
    errorCode: job.errorCode,
    retryAt: job.retryAt,
    inputCiphertext: ciphertext(job.inputCiphertext),
    chunkCiphertext: ciphertext(job.chunkCiphertext ?? null),
    checkpointCiphertext: ciphertext(job.checkpointCiphertext),
    resultCiphertext: ciphertext(job.resultCiphertext),
    checkpointRevision: job.checkpointRevision,
    proposalCount: job.proposalCount,
    screenshots: normalizedScreenshots(job.screenshots),
    partialFailure: normalizedPartialFailure(job.partialFailure),
    appliedCount: job.appliedCount,
    skippedCount: job.skippedCount,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
  };
}

const nonnegativeInt = (value: unknown): number => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0);

function normalizedScreenshots(value: unknown): ImportJobScreenshotProgress {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return { total: nonnegativeInt(record.total), read: nonnegativeInt(record.read), failed: nonnegativeInt(record.failed) };
}

function normalizedPartialFailure(value: unknown): ImportJobPartialFailure | null {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  return record && typeof record.retryJobId === "string" && record.retryJobId.length > 0 && nonnegativeInt(record.imageCount) > 0
    ? { retryJobId: record.retryJobId, imageCount: nonnegativeInt(record.imageCount) }
    : null;
}

/** Records written before 4.3 lack the window fields; assume the oldest client shape. */
function normalizedJob(job: StoredE2eeImportJob): StoredE2eeImportJob {
  return {
    ...job,
    chunkCiphertext: job.chunkCiphertext ?? null,
    screenshots: normalizedScreenshots(job.screenshots),
    partialFailure: normalizedPartialFailure(job.partialFailure),
  };
}

function newestFirst<T extends { id: string; updatedAt: string }>(rows: T[]): T[] {
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
}

export const importJobStorage = {
  durableTransactionProof(scope: ImportJobStorageScope, transactionId: string): Promise<"durable" | "rejected" | "absent"> {
    assertValidScope(scope);
    if (!transactionId) return Promise.resolve("absent");
    return idbImportTransactionProof(scope, transactionId);
  },

  async getApplyProgress(scope: ImportJobStorageScope, id: string): Promise<ImportApplyProgress> {
    assertValidScope(scope);
    const { preparedRows: _, ...progress } = normalizedApplyProgress(await idbGet<unknown>("meta", applyProgressKey(scope, id)));
    return progress;
  },

  async getApplyProgressRecord(scope: ImportJobStorageScope, id: string): Promise<StoredImportApplyProgress> {
    assertValidScope(scope);
    return normalizedApplyProgress(await idbGet<unknown>("meta", applyProgressKey(scope, id)));
  },

  async putApplyProgress(
    scope: ImportJobStorageScope,
    id: string,
    progress: Pick<ImportApplyProgress, "appliedRowIds" | "skippedRowIds"> & { preparedRows?: readonly ImportPreparedRow[] },
  ): Promise<void> {
    assertValidScope(scope);
    const normalized = normalizedApplyProgress(progress);
    await idbPut("meta", normalized, applyProgressKey(scope, id));
  },

  async claimApplyRow(
    scope: ImportJobStorageScope,
    id: string,
    claim: { rowToken: string; transactionId: string; ownerToken: string; now: number; leaseUntil: number },
  ): Promise<{ kind: "claimed"; transactionId: string; fence: number } | { kind: "busy" } | { kind: "applied" }> {
    assertValidScope(scope);
    if (
      !claim.rowToken ||
      !claim.transactionId ||
      !claim.ownerToken ||
      !Number.isFinite(claim.now) ||
      !Number.isFinite(claim.leaseUntil) ||
      claim.leaseUntil <= claim.now
    ) {
      throw new Error("invalid_import_apply_claim");
    }
    let result: { kind: "claimed"; transactionId: string; fence: number } | { kind: "busy" } | { kind: "applied" } = { kind: "busy" };
    await idbMutateMeta(applyProgressKey(scope, id), (current) => {
      const normalized = normalizedApplyProgress(current);
      if (normalized.appliedRowIds.includes(claim.rowToken)) {
        result = { kind: "applied" };
        return normalized;
      }
      const existing = normalized.preparedRows.find((prepared) => prepared.rowToken === claim.rowToken);
      if (existing && existing.leaseUntil > claim.now) {
        result = { kind: "busy" };
        return normalized;
      }
      const prepared = {
        rowToken: claim.rowToken,
        transactionId: existing?.transactionId ?? claim.transactionId,
        leaseOwner: claim.ownerToken,
        leaseUntil: claim.leaseUntil,
        fence: (existing?.fence ?? 0) + 1,
      } satisfies ImportPreparedRow;
      result = { kind: "claimed", transactionId: prepared.transactionId, fence: prepared.fence };
      return normalizedApplyProgress({
        appliedRowIds: normalized.appliedRowIds,
        skippedRowIds: normalized.skippedRowIds.filter((rowToken) => rowToken !== claim.rowToken),
        preparedRows: [...normalized.preparedRows.filter((candidate) => candidate.rowToken !== claim.rowToken), prepared],
      });
    });
    return result;
  },

  async renewApplyRow(
    scope: ImportJobStorageScope,
    id: string,
    renewal: { rowToken: string; ownerToken: string; fence: number; now: number; leaseUntil: number },
  ): Promise<boolean> {
    assertValidScope(scope);
    let renewed = false;
    await idbMutateMeta(applyProgressKey(scope, id), (current) => {
      const normalized = normalizedApplyProgress(current);
      const existing = normalized.preparedRows.find((prepared) => prepared.rowToken === renewal.rowToken);
      if (
        !existing ||
        existing.leaseOwner !== renewal.ownerToken ||
        existing.fence !== renewal.fence ||
        existing.leaseUntil <= renewal.now ||
        renewal.leaseUntil <= renewal.now
      ) {
        return normalized;
      }
      renewed = true;
      return normalizedApplyProgress({
        ...normalized,
        preparedRows: normalized.preparedRows.map((prepared) =>
          prepared.rowToken === renewal.rowToken ? { ...prepared, leaseUntil: renewal.leaseUntil } : prepared,
        ),
      });
    });
    return renewed;
  },

  async completeApplyRow(scope: ImportJobStorageScope, id: string, completion: { rowToken: string; ownerToken: string; fence: number }): Promise<boolean> {
    assertValidScope(scope);
    let completed = false;
    await idbMutateMeta(applyProgressKey(scope, id), (current) => {
      const normalized = normalizedApplyProgress(current);
      const existing = normalized.preparedRows.find((prepared) => prepared.rowToken === completion.rowToken);
      if (!existing || existing.leaseOwner !== completion.ownerToken || existing.fence !== completion.fence) return normalized;
      completed = true;
      return normalizedApplyProgress({
        appliedRowIds: [...normalized.appliedRowIds, completion.rowToken],
        skippedRowIds: normalized.skippedRowIds.filter((rowToken) => rowToken !== completion.rowToken),
        preparedRows: normalized.preparedRows.filter((prepared) => prepared.rowToken !== completion.rowToken),
      });
    });
    return completed;
  },

  async promoteDurableApplyRow(scope: ImportJobStorageScope, id: string, rowToken: string, transactionId: string): Promise<boolean> {
    assertValidScope(scope);
    let promoted = false;
    await idbMutateMeta(applyProgressKey(scope, id), (current) => {
      const normalized = normalizedApplyProgress(current);
      const existing = normalized.preparedRows.find((prepared) => prepared.rowToken === rowToken && prepared.transactionId === transactionId);
      if (!existing) return normalized;
      promoted = true;
      return normalizedApplyProgress({
        appliedRowIds: [...normalized.appliedRowIds, rowToken],
        skippedRowIds: normalized.skippedRowIds.filter((candidate) => candidate !== rowToken),
        preparedRows: normalized.preparedRows.filter((prepared) => prepared !== existing),
      });
    });
    return promoted;
  },

  async releaseApplyRow(scope: ImportJobStorageScope, id: string, release: { rowToken: string; ownerToken: string; fence: number }): Promise<boolean> {
    assertValidScope(scope);
    let released = false;
    await idbMutateMeta(applyProgressKey(scope, id), (current) => {
      const normalized = normalizedApplyProgress(current);
      const existing = normalized.preparedRows.find((prepared) => prepared.rowToken === release.rowToken);
      if (!existing || existing.leaseOwner !== release.ownerToken || existing.fence !== release.fence) return normalized;
      released = true;
      return normalizedApplyProgress({
        ...normalized,
        preparedRows: normalized.preparedRows.map((prepared) =>
          prepared.rowToken === release.rowToken ? { ...prepared, leaseOwner: null, leaseUntil: 0 } : prepared,
        ),
      });
    });
    return released;
  },

  async mergeApplyProgress(
    scope: ImportJobStorageScope,
    id: string,
    update: { appliedRowIds?: readonly string[]; skippedRowIds?: readonly string[] },
  ): Promise<StoredImportApplyProgress> {
    assertValidScope(scope);
    return normalizedApplyProgress(
      await idbMutateMeta(applyProgressKey(scope, id), (current) => {
        const normalized = normalizedApplyProgress(current);
        const applied = new Set(normalized.appliedRowIds);
        const skipped = new Set(normalized.skippedRowIds);
        for (const rowId of distinctRowIds(update.appliedRowIds)) {
          skipped.delete(rowId);
          applied.add(rowId);
        }
        for (const rowId of distinctRowIds(update.skippedRowIds)) {
          if (!applied.has(rowId)) skipped.add(rowId);
        }
        const accounted = new Set([...applied, ...skipped]);
        return normalizedApplyProgress({
          appliedRowIds: [...applied],
          skippedRowIds: [...skipped],
          preparedRows: normalized.preparedRows.filter((prepared) => !accounted.has(prepared.rowToken)),
        });
      }),
    );
  },

  async deleteApplyProgress(scope: ImportJobStorageScope, id: string): Promise<void> {
    assertValidScope(scope);
    await idbDelete("meta", applyProgressKey(scope, id));
    await idbDelete("meta", legacyApplyProgressKey(scope, id));
    await idbDelete("meta", oldestApplyProgressKey(scope, id));
  },

  subscribe(scope: ImportJobStorageScope, listener: () => void): () => void {
    assertValidScope(scope);
    const key = scopeKey(scope);
    const scoped = listeners.get(key) ?? new Set<() => void>();
    scoped.add(listener);
    listeners.set(key, scoped);
    return () => {
      scoped.delete(listener);
      if (scoped.size === 0) listeners.delete(key);
    };
  },

  async getJob(scope: ImportJobStorageScope, id: string): Promise<StoredE2eeImportJob | undefined> {
    assertValidScope(scope);
    const job = await idbGet<StoredE2eeImportJob>("importJobs", id);
    return job && inScope(job, scope) ? normalizedJob(job) : undefined;
  },

  async listJobs(scope: ImportJobStorageScope): Promise<StoredE2eeImportJob[]> {
    assertValidScope(scope);
    return newestFirst((await idbGetAll<StoredE2eeImportJob>("importJobs")).filter((job) => inScope(job, scope)).map(normalizedJob));
  },

  async putJob(scope: ImportJobStorageScope, job: StoredE2eeImportJob): Promise<void> {
    assertScope(job, scope);
    if (!(await idbPutImportJobForScope(persistedJob(job), scope))) throw new Error("import_job_scope_conflict");
    notify(scope);
  },

  async putJobIfRevision(scope: ImportJobStorageScope, job: StoredE2eeImportJob, expectedRevision: number): Promise<boolean> {
    assertScope(job, scope);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || job.checkpointRevision !== expectedRevision + 1) {
      throw new Error("invalid_import_job_revision");
    }
    const stored = await idbPutImportJobIfRevision(persistedJob(job), expectedRevision);
    if (stored) notify(scope);
    return stored;
  },

  async deleteJob(scope: ImportJobStorageScope, id: string): Promise<boolean> {
    assertValidScope(scope);
    const deleted = await idbDeleteImportJobIfScope(id, scope);
    if (deleted) notify(scope);
    return deleted;
  },

  async deleteJobWithProgress(scope: ImportJobStorageScope, id: string, permitted: () => boolean = () => true): Promise<boolean> {
    assertValidScope(scope);
    const deleted = await idbDeleteImportJobWithMetaIfScope(
      id,
      scope,
      [applyProgressKey(scope, id), legacyApplyProgressKey(scope, id), oldestApplyProgressKey(scope, id)],
      permitted,
    );
    if (deleted) notify(scope);
    return deleted;
  },

  async getDraft(scope: ImportJobStorageScope, id: string): Promise<PlainImportUploadDraft | undefined> {
    assertValidScope(scope);
    const draft = await idbGet<PlainImportUploadDraft>("importDrafts", id);
    return draft && inScope(draft, scope) ? normalizedDraft(draft) : undefined;
  },

  async listDrafts(scope: ImportJobStorageScope): Promise<PlainImportUploadDraft[]> {
    assertValidScope(scope);
    return newestFirst((await idbGetAll<PlainImportUploadDraft>("importDrafts")).filter((draft) => inScope(draft, scope)).map(normalizedDraft));
  },

  async createDraft(scope: ImportJobStorageScope, input: PlainImportUploadDraftInput, now = new Date()): Promise<PlainImportUploadDraft> {
    assertScope(input, scope);
    const captured = { ...input, images: [...input.images] };
    const hash = await requestHash(captured);
    const draft = copyDraft(captured, hash, now);
    const result = await idbPutImportDraftIfAbsentOrSame(draft);
    if (result.kind === "conflict") throw new Error("import_draft_conflict");
    if (result.kind === "created") notify(scope);
    return normalizedDraft(result.value as PlainImportUploadDraft);
  },

  async markDraftUploadAttempt(
    scope: ImportJobStorageScope,
    id: string,
    expectedRequestHash: string,
    now = new Date(),
  ): Promise<PlainImportUploadDraft | undefined> {
    assertValidScope(scope);
    const result = await idbMutateImportDraftState({
      ...scope,
      id,
      requestHash: expectedRequestHash,
      field: "uploadAttemptedAt",
      at: now.toISOString(),
    });
    if (!result) return undefined;
    notify(scope);
    return normalizedDraft(result as PlainImportUploadDraft);
  },

  async requestDraftCancellation(
    scope: ImportJobStorageScope,
    id: string,
    expectedRequestHash: string,
    now = new Date(),
  ): Promise<PlainImportUploadDraft | undefined> {
    assertValidScope(scope);
    const result = await idbMutateImportDraftState({
      ...scope,
      id,
      requestHash: expectedRequestHash,
      field: "cancelRequestedAt",
      at: now.toISOString(),
    });
    if (!result) return undefined;
    notify(scope);
    return normalizedDraft(result as PlainImportUploadDraft);
  },

  async deleteDraft(scope: ImportJobStorageScope, id: string, expectedRequestHash: string): Promise<boolean> {
    assertValidScope(scope);
    const deleted = await idbDeleteImportDraftIfMatches({ ...scope, id, requestHash: expectedRequestHash });
    if (deleted) notify(scope);
    return deleted;
  },

  async acknowledgeDraft(scope: ImportJobStorageScope, expectedRequestHash: string, acknowledgement: PlainImportDraftAcknowledgement): Promise<boolean> {
    assertValidScope(scope);
    if (
      acknowledgement.tier !== "plain" ||
      acknowledgement.budgetId !== scope.budgetId ||
      acknowledgement.accountId === null ||
      acknowledgement.locale === null
    ) {
      return false;
    }
    const deleted = await idbDeleteImportDraftIfMatches({
      ...scope,
      id: acknowledgement.id,
      accountId: acknowledgement.accountId,
      locale: acknowledgement.locale,
      requestHash: expectedRequestHash,
      requireCancelRequestedAtNull: true,
    });
    if (deleted) notify(scope);
    return deleted;
  },

  async pruneExpiredDrafts(scope: ImportJobStorageScope, now = new Date()): Promise<number> {
    assertValidScope(scope);
    const deleted = await idbDeleteExpiredImportDrafts(scope, now.getTime());
    if (deleted > 0) notify(scope);
    return deleted;
  },
};
