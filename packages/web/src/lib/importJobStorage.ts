import type { AiLocale, ImportJobDetail, ImportJobProgress, ImportJobProviderSnapshot } from "@enveo/shared";
import {
  idbDeleteExpiredImportDrafts,
  idbDeleteImportDraftIfMatches,
  idbDeleteImportJobIfScope,
  idbGet,
  idbGetAll,
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
  inputCiphertext: string;
  checkpointCiphertext: string | null;
  resultCiphertext: string | null;
  /** Optimistic phase-write fence for duplicate browser runners. */
  checkpointRevision: number;
  proposalCount: number;
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

const listeners = new Map<string, Set<() => void>>();

function scopeKey(scope: ImportJobStorageScope): string {
  return JSON.stringify([scope.ownerId, scope.budgetId]);
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
    createdAt,
    updatedAt: createdAt,
    expiresAt: new Date(now.getTime() + IMPORT_DRAFT_TTL_MS).toISOString(),
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
    inputCiphertext: ciphertext(job.inputCiphertext)!,
    checkpointCiphertext: ciphertext(job.checkpointCiphertext),
    resultCiphertext: ciphertext(job.resultCiphertext),
    checkpointRevision: job.checkpointRevision,
    proposalCount: job.proposalCount,
    appliedCount: job.appliedCount,
    skippedCount: job.skippedCount,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
  };
}

function newestFirst<T extends { id: string; updatedAt: string }>(rows: T[]): T[] {
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
}

export const importJobStorage = {
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
    return job && inScope(job, scope) ? job : undefined;
  },

  async listJobs(scope: ImportJobStorageScope): Promise<StoredE2eeImportJob[]> {
    assertValidScope(scope);
    return newestFirst((await idbGetAll<StoredE2eeImportJob>("importJobs")).filter((job) => inScope(job, scope)));
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

  async getDraft(scope: ImportJobStorageScope, id: string): Promise<PlainImportUploadDraft | undefined> {
    assertValidScope(scope);
    const draft = await idbGet<PlainImportUploadDraft>("importDrafts", id);
    return draft && inScope(draft, scope) ? draft : undefined;
  },

  async listDrafts(scope: ImportJobStorageScope): Promise<PlainImportUploadDraft[]> {
    assertValidScope(scope);
    return newestFirst((await idbGetAll<PlainImportUploadDraft>("importDrafts")).filter((draft) => inScope(draft, scope)));
  },

  async createDraft(scope: ImportJobStorageScope, input: PlainImportUploadDraftInput, now = new Date()): Promise<PlainImportUploadDraft> {
    assertScope(input, scope);
    const captured = { ...input, images: [...input.images] };
    const hash = await requestHash(captured);
    const draft = copyDraft(captured, hash, now);
    const result = await idbPutImportDraftIfAbsentOrSame(draft);
    if (result.kind === "conflict") throw new Error("import_draft_conflict");
    if (result.kind === "created") notify(scope);
    return result.value as PlainImportUploadDraft;
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
