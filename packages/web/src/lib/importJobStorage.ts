import type { AiLocale, ImportJobDetail, ImportJobProgress, ImportJobProviderSnapshot } from "@enveo/shared";
import { idbDelete, idbGet, idbGetAll, idbPut, idbPutImportJobIfRevision } from "./idb";

export const IMPORT_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export interface PlainImportUploadDraftInput {
  id: string;
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

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
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
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  getJob(id: string): Promise<StoredE2eeImportJob | undefined> {
    return idbGet("importJobs", id);
  },

  async listJobs(): Promise<StoredE2eeImportJob[]> {
    return newestFirst(await idbGetAll("importJobs"));
  },

  async putJob(job: StoredE2eeImportJob): Promise<void> {
    await idbPut("importJobs", persistedJob(job));
    notify();
  },

  async putJobIfRevision(job: StoredE2eeImportJob, expectedRevision: number): Promise<boolean> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || job.checkpointRevision !== expectedRevision + 1) {
      throw new Error("invalid_import_job_revision");
    }
    const stored = await idbPutImportJobIfRevision(persistedJob(job), expectedRevision);
    if (stored) notify();
    return stored;
  },

  async deleteJob(id: string): Promise<void> {
    await idbDelete("importJobs", id);
    notify();
  },

  getDraft(id: string): Promise<PlainImportUploadDraft | undefined> {
    return idbGet("importDrafts", id);
  },

  async listDrafts(): Promise<PlainImportUploadDraft[]> {
    return newestFirst(await idbGetAll("importDrafts"));
  },

  async createDraft(input: PlainImportUploadDraftInput, now = new Date()): Promise<PlainImportUploadDraft> {
    const hash = await requestHash(input);
    const existing = await idbGet<PlainImportUploadDraft>("importDrafts", input.id);
    if (existing) {
      if (existing.requestHash !== hash) throw new Error("import_draft_conflict");
      return existing;
    }
    const draft = copyDraft(input, hash, now);
    await idbPut("importDrafts", draft);
    notify();
    return draft;
  },

  async deleteDraft(id: string): Promise<void> {
    await idbDelete("importDrafts", id);
    notify();
  },

  async acknowledgeDraft(acknowledgement: PlainImportDraftAcknowledgement): Promise<boolean> {
    const draft = await idbGet<PlainImportUploadDraft>("importDrafts", acknowledgement.id);
    if (
      !draft ||
      acknowledgement.tier !== "plain" ||
      acknowledgement.budgetId !== draft.budgetId ||
      acknowledgement.accountId !== draft.accountId ||
      acknowledgement.locale !== draft.locale
    ) {
      return false;
    }
    await idbDelete("importDrafts", draft.id);
    notify();
    return true;
  },

  async pruneExpiredDrafts(now = new Date()): Promise<number> {
    const drafts = await idbGetAll<PlainImportUploadDraft>("importDrafts");
    const expired = drafts.filter((draft) => Date.parse(draft.expiresAt) <= now.getTime());
    for (const draft of expired) await idbDelete("importDrafts", draft.id);
    if (expired.length > 0) notify();
    return expired.length;
  },
};
