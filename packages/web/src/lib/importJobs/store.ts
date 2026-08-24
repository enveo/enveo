import type { ImportJobDetail, ImportJobProgress, ImportJobProviderSnapshot, ImportJobSummary, ImportRecognitionResult } from "@enveo/shared";
import type { PlainImportUploadDraft, StoredE2eeImportJob } from "../importJobStorage";

export type ImportActivitySource = "plain-draft" | "plain" | "e2ee";

/** One UI-facing shape for upload recovery, server-backed jobs, and encrypted local jobs. */
export interface ImportActivityItem extends ImportJobProgress {
  id: string;
  budgetId: string;
  accountId: string | null;
  provider: ImportJobProviderSnapshot | null;
  locale: string;
  tier: "plain" | "e2ee";
  epoch: number;
  source: ImportActivitySource;
  result: ImportRecognitionResult | null;
  proposalCount: number;
  appliedCount: number;
  skippedCount: number;
  createdAt: string;
  expiresAt: string;
}

export type ImportActivityListener = (item: ImportActivityItem | undefined) => void;

export function isScheduledImportRetry(item: ImportActivityItem): boolean {
  return item.status === "failed" && item.phase === "retry_scheduled" && item.retryAt !== null;
}

export function importActivityAttention(item: ImportActivityItem): "ready" | "failed" | null {
  if (item.status === "ready") return "ready";
  if (item.status === "failed" && !isScheduledImportRetry(item)) return "failed";
  return null;
}

/** Revocable authority for one authenticated owner/budget/tier activation. */
export interface ImportJobScopeCapability {
  isCurrent(): boolean;
}

export function importActivityFromDraft(draft: PlainImportUploadDraft): ImportActivityItem {
  return {
    id: draft.id,
    budgetId: draft.budgetId,
    accountId: draft.accountId,
    provider: null,
    locale: draft.locale,
    tier: "plain",
    epoch: 0,
    source: "plain-draft",
    status: "queued",
    phase: "uploading",
    resumePhase: null,
    cancelRequested: false,
    attempt: 0,
    errorCode: null,
    retryAt: null,
    result: null,
    proposalCount: 0,
    appliedCount: 0,
    skippedCount: 0,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    expiresAt: draft.expiresAt,
  };
}

export function importActivityFromServer(job: ImportJobSummary | ImportJobDetail): ImportActivityItem {
  const detail = job as ImportJobDetail;
  return {
    ...job,
    source: "plain",
    locale: typeof detail.locale === "string" ? detail.locale : "en",
    epoch: typeof detail.epoch === "number" ? detail.epoch : 0,
    result: detail.result ?? null,
    appliedCount: detail.appliedCount ?? 0,
    skippedCount: detail.skippedCount ?? 0,
  };
}

export function importActivityFromE2ee(job: StoredE2eeImportJob, result: ImportRecognitionResult | null = null): ImportActivityItem {
  return {
    id: job.id,
    budgetId: job.budgetId,
    accountId: job.accountId,
    provider: job.provider,
    locale: job.locale,
    tier: "e2ee",
    epoch: job.epoch,
    source: "e2ee",
    status: job.status,
    phase: job.phase,
    resumePhase: job.resumePhase,
    cancelRequested: job.cancelRequested,
    attempt: job.attempt,
    errorCode: job.errorCode,
    retryAt: job.retryAt,
    result,
    proposalCount: job.proposalCount,
    appliedCount: job.appliedCount,
    skippedCount: job.skippedCount,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiresAt: job.expiresAt,
  };
}

export interface ImportActivityStore {
  upsert(item: ImportActivityItem): void;
  remove(id: string): void;
  get(id: string): ImportActivityItem | undefined;
  list(): ImportActivityItem[];
  observe(id: string, listener: ImportActivityListener): () => void;
  subscribe(listener: () => void): () => void;
  getVersion(): number;
  clear(): void;
}

export function createImportActivityStore(): ImportActivityStore {
  const items = new Map<string, ImportActivityItem>();
  const observers = new Map<string, Set<ImportActivityListener>>();
  const listeners = new Set<() => void>();
  let version = 0;
  const notify = (id: string) => {
    version++;
    const item = items.get(id);
    for (const listener of observers.get(id) ?? []) listener(item);
    for (const listener of listeners) listener();
  };

  return {
    upsert(item) {
      items.set(item.id, item);
      notify(item.id);
    },
    remove(id) {
      if (!items.delete(id)) return;
      notify(id);
    },
    get: (id) => items.get(id),
    list: () => [...items.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id)),
    observe(id, listener) {
      const scoped = observers.get(id) ?? new Set<ImportActivityListener>();
      scoped.add(listener);
      observers.set(id, scoped);
      listener(items.get(id));
      return () => {
        scoped.delete(listener);
        if (scoped.size === 0) observers.delete(id);
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getVersion: () => version,
    clear() {
      const ids = [...items.keys()];
      items.clear();
      for (const id of ids) notify(id);
    },
  };
}
