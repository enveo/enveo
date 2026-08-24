import type { AiLocale, ImportJobDetail, ImportJobSummary } from "@enveo/shared";
import { api } from "../api";
import { type ImportJobStorageScope, importJobStorage, type PlainImportUploadDraft, type PlainImportUploadDraftInput } from "../importJobStorage";
import {
  type ImportActivityItem,
  type ImportActivityListener,
  type ImportActivityStore,
  type ImportJobScopeCapability,
  importActivityFromDraft,
  importActivityFromServer,
} from "./store";

export interface PlainImportJobRemote {
  create(input: { id: string; budgetId: string; accountId: string; locale: AiLocale; images: string[] }): Promise<ImportJobDetail>;
  list(): Promise<ImportJobSummary[]>;
  get(id: string): Promise<ImportJobDetail>;
  cancel(id: string, budgetId: string): Promise<ImportJobDetail>;
  retry(id: string, budgetId: string): Promise<ImportJobDetail>;
}

export interface PlainImportJobAdapterOptions {
  scope: ImportJobStorageScope;
  activity: ImportActivityStore;
  capability?: ImportJobScopeCapability;
  remote?: PlainImportJobRemote;
  visible?: () => boolean;
  pollIntervalMs?: number;
  scheduleInterval?: (callback: () => void, delay: number) => ReturnType<typeof setInterval>;
  clearScheduledInterval?: (timer: ReturnType<typeof setInterval>) => void;
  windowTarget?: Pick<Window, "addEventListener" | "removeEventListener"> | null;
  documentTarget?: Pick<Document, "addEventListener" | "removeEventListener"> | null;
}

export type PlainImportCreateInput = Pick<PlainImportUploadDraftInput, "id" | "accountId" | "locale" | "images">;

const POLL_INTERVAL_MS = 2_000;

function shouldPoll(item: ImportActivityItem, budgetId: string): boolean {
  return item.budgetId === budgetId && (item.source === "plain-draft" || (item.source === "plain" && ["queued", "running", "ready"].includes(item.status)));
}

class StalePlainImportAdapter extends Error {
  constructor() {
    super("stale_import_job_adapter");
  }
}

export class PlainImportJobAdapter {
  private readonly remote: PlainImportJobRemote;
  private readonly visible: () => boolean;
  private readonly scheduleInterval: NonNullable<PlainImportJobAdapterOptions["scheduleInterval"]>;
  private readonly clearScheduledInterval: NonNullable<PlainImportJobAdapterOptions["clearScheduledInterval"]>;
  private readonly windowTarget: PlainImportJobAdapterOptions["windowTarget"];
  private readonly documentTarget: PlainImportJobAdapterOptions["documentTarget"];
  private readonly dismissed = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshPromise: Promise<void> | null = null;
  private readonly uploads = new Map<string, Promise<ImportActivityItem>>();
  private stopped = false;

  constructor(private readonly options: PlainImportJobAdapterOptions) {
    this.remote = options.remote ?? api.importJobs;
    this.visible = options.visible ?? (() => typeof document === "undefined" || document.visibilityState === "visible");
    this.scheduleInterval = options.scheduleInterval ?? ((callback, delay) => setInterval(callback, delay));
    this.clearScheduledInterval = options.clearScheduledInterval ?? ((timer) => clearInterval(timer));
    this.windowTarget = options.windowTarget === undefined ? (typeof window === "undefined" ? undefined : window) : (options.windowTarget ?? undefined);
    this.documentTarget =
      options.documentTarget === undefined ? (typeof document === "undefined" ? undefined : document) : (options.documentTarget ?? undefined);
  }

  private readonly refreshWhenVisible = () => {
    if (this.visible()) void this.refresh(false).catch(() => {});
  };

  private isCurrent(): boolean {
    return !this.stopped && (this.options.capability?.isCurrent() ?? true);
  }

  private publish(item: ImportActivityItem): void {
    if (this.isCurrent() && !this.dismissed.has(item.id)) this.options.activity.upsert(item);
  }

  start(): void {
    if (this.stopped || this.timer !== null) return;
    this.timer = this.scheduleInterval(() => {
      if (this.visible() && this.options.activity.list().some((item) => shouldPoll(item, this.options.scope.budgetId))) {
        void this.refresh(false).catch(() => {});
      }
    }, this.options.pollIntervalMs ?? POLL_INTERVAL_MS);
    this.windowTarget?.addEventListener("online", this.refreshWhenVisible);
    this.windowTarget?.addEventListener("focus", this.refreshWhenVisible);
    this.documentTarget?.addEventListener("visibilitychange", this.refreshWhenVisible);
    this.refreshWhenVisible();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.clearScheduledInterval(this.timer);
    this.timer = null;
    this.windowTarget?.removeEventListener("online", this.refreshWhenVisible);
    this.windowTarget?.removeEventListener("focus", this.refreshWhenVisible);
    this.documentTarget?.removeEventListener("visibilitychange", this.refreshWhenVisible);
  }

  observe(id: string, listener: ImportActivityListener): () => void {
    return this.options.activity.observe(id, listener);
  }

  private request(draft: PlainImportUploadDraft) {
    return {
      id: draft.id,
      budgetId: draft.budgetId,
      accountId: draft.accountId,
      locale: draft.locale,
      images: [...draft.images],
    };
  }

  private async settleCancellation(draft: PlainImportUploadDraft, accepted?: ImportJobDetail): Promise<ImportActivityItem> {
    if (!this.isCurrent()) throw new StalePlainImportAdapter();
    const job = accepted ?? (await this.remote.create(this.request(draft)));
    if (!this.isCurrent()) throw new StalePlainImportAdapter();
    const cancelled = await this.remote.cancel(job.id, this.options.scope.budgetId);
    if (!this.isCurrent()) throw new StalePlainImportAdapter();
    await importJobStorage.deleteDraft(this.options.scope, draft.id, draft.requestHash);
    if (this.isCurrent()) this.options.activity.remove(draft.id);
    return importActivityFromServer(cancelled);
  }

  private upload(draft: PlainImportUploadDraft): Promise<ImportActivityItem> {
    const existing = this.uploads.get(draft.id);
    if (existing) return existing;
    const work = this.performUpload(draft);
    this.uploads.set(draft.id, work);
    void work
      .finally(() => {
        if (this.uploads.get(draft.id) === work) this.uploads.delete(draft.id);
      })
      .catch(() => {});
    return work;
  }

  private async performUpload(draft: PlainImportUploadDraft): Promise<ImportActivityItem> {
    if (!this.isCurrent()) return importActivityFromDraft(draft);
    const attempted = await importJobStorage.markDraftUploadAttempt(this.options.scope, draft.id, draft.requestHash);
    if (!this.isCurrent() || !attempted) return importActivityFromDraft(draft);
    if (attempted.cancelRequestedAt) return this.settleCancellation(attempted);

    const job = await this.remote.create(this.request(attempted));
    if (!this.isCurrent()) return importActivityFromServer(job);
    let current = await importJobStorage.getDraft(this.options.scope, draft.id);
    if (!this.isCurrent()) return importActivityFromServer(job);
    if (current?.cancelRequestedAt) return this.settleCancellation(current, job);

    const acknowledged = await importJobStorage.acknowledgeDraft(this.options.scope, draft.requestHash, job);
    if (!this.isCurrent()) return importActivityFromServer(job);
    if (!acknowledged) {
      current = await importJobStorage.getDraft(this.options.scope, draft.id);
      if (!this.isCurrent()) return importActivityFromServer(job);
      if (current?.cancelRequestedAt) return this.settleCancellation(current, job);
      throw new Error("stale_import_draft_acknowledgement");
    }
    const item = importActivityFromServer(job);
    this.publish(item);
    return item;
  }

  async create(input: PlainImportCreateInput): Promise<ImportActivityItem> {
    if (!this.isCurrent()) throw new StalePlainImportAdapter();
    const draft = await importJobStorage.createDraft(this.options.scope, {
      ...input,
      ownerId: this.options.scope.ownerId,
      budgetId: this.options.scope.budgetId,
      images: [...input.images],
    });
    if (!this.isCurrent()) return importActivityFromDraft(draft);
    this.dismissed.delete(draft.id);
    this.publish(importActivityFromDraft(draft));
    return this.upload(draft);
  }

  async resumeDrafts(): Promise<boolean> {
    if (!this.isCurrent()) return false;
    await importJobStorage.pruneExpiredDrafts(this.options.scope);
    if (!this.isCurrent()) return false;
    const drafts = await importJobStorage.listDrafts(this.options.scope);
    if (!this.isCurrent()) return false;
    for (const draft of drafts) {
      if (!this.isCurrent()) break;
      if (!draft.cancelRequestedAt) this.publish(importActivityFromDraft(draft));
      try {
        if (draft.cancelRequestedAt && draft.uploadAttemptedAt === null) {
          await importJobStorage.deleteDraft(this.options.scope, draft.id, draft.requestHash);
        } else {
          await this.upload(draft);
        }
      } catch {
        // The exact draft remains durable for the next online/focus/boot retry.
      }
    }
    return drafts.length > 0;
  }

  refresh(force = true): Promise<void> {
    if (!this.isCurrent() || !this.visible()) return Promise.resolve();
    if (this.refreshPromise) return this.refreshPromise;
    const refresh = (async () => {
      const hadDrafts = await this.resumeDrafts();
      if (!this.isCurrent()) return;
      const active = this.options.activity.list().some((item) => shouldPoll(item, this.options.scope.budgetId));
      if (!force && !hadDrafts && !active) return;
      const jobs = (await this.remote.list()).filter((job) => job.budgetId === this.options.scope.budgetId);
      if (!this.isCurrent()) return;
      for (const summary of jobs) {
        if (!this.isCurrent()) return;
        if (this.dismissed.has(summary.id)) continue;
        if (summary.status === "cancelled") {
          this.options.activity.remove(summary.id);
          continue;
        }
        if (summary.status === "ready") {
          const detail = await this.remote.get(summary.id);
          if (!this.isCurrent()) return;
          this.publish(importActivityFromServer(detail));
        } else {
          this.publish(importActivityFromServer(summary));
        }
      }
    })();
    this.refreshPromise = refresh.finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  async cancel(id: string): Promise<void> {
    if (!this.isCurrent()) return;
    const draft = await importJobStorage.getDraft(this.options.scope, id);
    if (!this.isCurrent()) return;
    if (draft) {
      const inFlight = this.uploads.get(id);
      const cancelled = await importJobStorage.requestDraftCancellation(this.options.scope, id, draft.requestHash);
      if (!this.isCurrent()) return;
      if (!cancelled) {
        // The acknowledgement transaction won the race after getDraft(). Its
        // in-memory create result still gives us a deterministic server id to cancel.
        let accepted: ImportActivityItem | undefined;
        try {
          accepted = await inFlight;
        } catch {
          return;
        }
        if (!this.isCurrent() || accepted?.source !== "plain") return;
        await this.remote.cancel(accepted.id, this.options.scope.budgetId);
        if (this.isCurrent()) this.options.activity.remove(id);
        return;
      }
      this.options.activity.remove(id);
      if (cancelled.uploadAttemptedAt === null) {
        await importJobStorage.deleteDraft(this.options.scope, id, draft.requestHash);
        return;
      }
      try {
        await this.uploads.get(id);
      } catch {
        // The durable tombstone below is the authority after an ambiguous response.
      }
      const remaining = await importJobStorage.getDraft(this.options.scope, id);
      if (this.isCurrent() && remaining?.cancelRequestedAt) await this.settleCancellation(remaining);
      return;
    }
    const job = await this.remote.cancel(id, this.options.scope.budgetId);
    if (this.isCurrent()) this.publish(importActivityFromServer(job));
  }

  async retry(id: string): Promise<void> {
    if (!this.isCurrent()) return;
    const draft = await importJobStorage.getDraft(this.options.scope, id);
    if (!this.isCurrent()) return;
    if (draft) {
      await this.upload(draft);
      return;
    }
    const job = await this.remote.retry(id, this.options.scope.budgetId);
    this.publish(importActivityFromServer(job));
  }

  dismiss(id: string): void {
    if (!this.isCurrent()) return;
    this.dismissed.add(id);
    this.options.activity.remove(id);
  }
}
