import type { AiLocale, ImportJobDetail, ImportJobSummary } from "@enveo/shared";
import { api } from "../api";
import { type ImportJobStorageScope, importJobStorage, type PlainImportUploadDraft, type PlainImportUploadDraftInput } from "../importJobStorage";
import { type ImportActivityItem, type ImportActivityListener, type ImportActivityStore, importActivityFromDraft, importActivityFromServer } from "./store";

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

function shouldPoll(item: ImportActivityItem): boolean {
  return item.source === "plain-draft" || (item.source === "plain" && ["queued", "running", "ready"].includes(item.status));
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
    if (this.visible()) void this.refresh().catch(() => {});
  };

  start(): void {
    if (this.timer !== null) return;
    this.timer = this.scheduleInterval(() => {
      if (this.visible() && this.options.activity.list().some(shouldPoll)) void this.refresh().catch(() => {});
    }, this.options.pollIntervalMs ?? POLL_INTERVAL_MS);
    this.windowTarget?.addEventListener("online", this.refreshWhenVisible);
    this.windowTarget?.addEventListener("focus", this.refreshWhenVisible);
    this.documentTarget?.addEventListener("visibilitychange", this.refreshWhenVisible);
    this.refreshWhenVisible();
  }

  stop(): void {
    if (this.timer !== null) this.clearScheduledInterval(this.timer);
    this.timer = null;
    this.windowTarget?.removeEventListener("online", this.refreshWhenVisible);
    this.windowTarget?.removeEventListener("focus", this.refreshWhenVisible);
    this.documentTarget?.removeEventListener("visibilitychange", this.refreshWhenVisible);
  }

  observe(id: string, listener: ImportActivityListener): () => void {
    return this.options.activity.observe(id, listener);
  }

  private async upload(draft: PlainImportUploadDraft): Promise<ImportActivityItem> {
    const job = await this.remote.create({
      id: draft.id,
      budgetId: draft.budgetId,
      accountId: draft.accountId,
      locale: draft.locale,
      images: [...draft.images],
    });
    const acknowledged = await importJobStorage.acknowledgeDraft(this.options.scope, draft.requestHash, job);
    if (!acknowledged) throw new Error("stale_import_draft_acknowledgement");
    const item = importActivityFromServer(job);
    if (!this.dismissed.has(item.id)) this.options.activity.upsert(item);
    return item;
  }

  async create(input: PlainImportCreateInput): Promise<ImportActivityItem> {
    const draft = await importJobStorage.createDraft(this.options.scope, {
      ...input,
      ownerId: this.options.scope.ownerId,
      budgetId: this.options.scope.budgetId,
      images: [...input.images],
    });
    this.dismissed.delete(draft.id);
    this.options.activity.upsert(importActivityFromDraft(draft));
    return this.upload(draft);
  }

  async resumeDrafts(): Promise<void> {
    await importJobStorage.pruneExpiredDrafts(this.options.scope);
    const drafts = await importJobStorage.listDrafts(this.options.scope);
    for (const draft of drafts) {
      if (!this.dismissed.has(draft.id)) this.options.activity.upsert(importActivityFromDraft(draft));
      try {
        await this.upload(draft);
      } catch {
        // The exact draft remains durable for the next online/focus/boot retry.
      }
    }
  }

  refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const refresh = (async () => {
      await this.resumeDrafts();
      const jobs = (await this.remote.list()).filter((job) => job.budgetId === this.options.scope.budgetId);
      for (const summary of jobs) {
        if (this.dismissed.has(summary.id)) continue;
        if (summary.status === "ready") {
          this.options.activity.upsert(importActivityFromServer(await this.remote.get(summary.id)));
        } else {
          this.options.activity.upsert(importActivityFromServer(summary));
        }
      }
    })();
    this.refreshPromise = refresh.finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  async cancel(id: string): Promise<void> {
    const draft = await importJobStorage.getDraft(this.options.scope, id);
    if (draft) {
      await importJobStorage.deleteDraft(this.options.scope, id, draft.requestHash);
      this.options.activity.remove(id);
      return;
    }
    const job = await this.remote.cancel(id, this.options.scope.budgetId);
    this.options.activity.upsert(importActivityFromServer(job));
  }

  async retry(id: string): Promise<void> {
    const draft = await importJobStorage.getDraft(this.options.scope, id);
    if (draft) {
      await this.upload(draft);
      return;
    }
    const job = await this.remote.retry(id, this.options.scope.budgetId);
    this.options.activity.upsert(importActivityFromServer(job));
  }

  dismiss(id: string): void {
    this.dismissed.add(id);
    this.options.activity.remove(id);
  }
}
