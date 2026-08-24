import type { AiLocale, ClientLedger, OpenAiModel } from "@enveo/shared";
import * as e2ee from "../e2ee";
import { idbGet } from "../idb";
import type { ImportJobStorageScope } from "../importJobStorage";
import { type BootStatus, store } from "../store";
import { verifiedIdentityUserId } from "../sync/identity";
import { type E2eeImportJobCreateInput, E2eeImportJobRunner } from "./e2eeRunner";
import { type PlainImportCreateInput, PlainImportJobAdapter } from "./plain";
import { createImportActivityStore, type ImportActivityItem, type ImportActivityListener, type ImportActivityStore } from "./store";

export interface ImportJobManagerState {
  getBootStatus(): BootStatus;
  getBudgetId(): string | null;
  getLedger(): ClientLedger | null;
  subscribe(listener: () => void): () => void;
}

export interface ImportJobManagerPlainPort {
  start(): void;
  stop(): void;
  create(input: PlainImportCreateInput): Promise<ImportActivityItem>;
  refresh(): Promise<void>;
  cancel(id: string): Promise<void>;
  retry(id: string): Promise<void>;
  dismiss(id: string): void;
}

export interface ImportJobManagerE2eePort {
  create(input: E2eeImportJobCreateInput): Promise<ImportActivityItem>;
  resume(): Promise<void>;
  list(): Promise<ImportActivityItem[]>;
  cancel(id: string): Promise<void>;
  retry(id: string): Promise<void>;
  dismiss(id: string): Promise<void>;
}

export interface ImportJobManagerCreateInput {
  accountId: string;
  locale: AiLocale;
  images: string[];
}

export interface ImportJobManagerOptions {
  state?: ImportJobManagerState;
  ownerId?: () => Promise<string | null>;
  tierMeta?: () => { tier: "plain" | "e2ee"; epoch: number };
  createPlain?: (scope: ImportJobStorageScope, activity: ImportActivityStore) => ImportJobManagerPlainPort;
  createE2ee?: (scope: ImportJobStorageScope, activity: ImportActivityStore) => ImportJobManagerE2eePort;
  randomId?: () => string;
  visible?: () => boolean;
  windowTarget?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  documentTarget?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  scheduleInterval?: (callback: () => void, delay: number) => ReturnType<typeof setInterval>;
  clearScheduledInterval?: (timer: ReturnType<typeof setInterval>) => void;
}

const E2EE_WAKE_INTERVAL_MS = 2_000;

function sameScope(left: ImportJobStorageScope | null, right: ImportJobStorageScope): boolean {
  return left?.ownerId === right.ownerId && left.budgetId === right.budgetId;
}

export class ImportJobManager {
  private readonly state: ImportJobManagerState;
  private readonly ownerId: () => Promise<string | null>;
  private readonly tierMeta: () => { tier: "plain" | "e2ee"; epoch: number };
  private readonly createPlain: NonNullable<ImportJobManagerOptions["createPlain"]>;
  private readonly createE2ee: NonNullable<ImportJobManagerOptions["createE2ee"]>;
  private readonly randomId: () => string;
  private readonly visible: () => boolean;
  private readonly windowTarget: ImportJobManagerOptions["windowTarget"];
  private readonly documentTarget: ImportJobManagerOptions["documentTarget"];
  private readonly scheduleInterval: NonNullable<ImportJobManagerOptions["scheduleInterval"]>;
  private readonly clearScheduledInterval: NonNullable<ImportJobManagerOptions["clearScheduledInterval"]>;
  private readonly activity = createImportActivityStore();
  private scope: ImportJobStorageScope | null = null;
  private plain: ImportJobManagerPlainPort | null = null;
  private local: ImportJobManagerE2eePort | null = null;
  private started = false;
  private stateUnsubscribe: (() => void) | null = null;
  private wakeTimer: ReturnType<typeof setInterval> | null = null;
  private activation: Promise<boolean> | null = null;

  constructor(options: ImportJobManagerOptions = {}) {
    this.state = options.state ?? store;
    this.ownerId =
      options.ownerId ??
      (async () => {
        // Called only after BootStatus "ready": the boot ownership guard has already decided
        // whether this replica may be rendered. Prefer its same-session verdict, with the
        // durable owner stamp as the offline/reload fallback; never infer ownership from budgetId.
        return verifiedIdentityUserId() ?? (await idbGet<string>("meta", "userId")) ?? null;
      });
    this.tierMeta = options.tierMeta ?? e2ee.getTierMeta;
    this.createPlain =
      options.createPlain ??
      ((scope, activity) =>
        new PlainImportJobAdapter({
          scope,
          activity,
          // The manager owns foreground wake listeners; the adapter still owns its visible
          // polling timer and keeps server execution independent from observation.
          windowTarget: null,
          documentTarget: null,
        }));
    this.createE2ee = options.createE2ee ?? ((scope, activity) => new E2eeImportJobRunner({ scope, activity }));
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    this.visible = options.visible ?? (() => typeof document === "undefined" || document.visibilityState === "visible");
    this.windowTarget = options.windowTarget ?? (typeof window === "undefined" ? undefined : window);
    this.documentTarget = options.documentTarget ?? (typeof document === "undefined" ? undefined : document);
    this.scheduleInterval = options.scheduleInterval ?? ((callback, delay) => setInterval(callback, delay));
    this.clearScheduledInterval = options.clearScheduledInterval ?? ((timer) => clearInterval(timer));
  }

  private deactivate(clear: boolean): void {
    this.plain?.stop();
    this.plain = null;
    this.local = null;
    this.scope = null;
    if (clear) this.activity.clear();
  }

  private activate(): Promise<boolean> {
    if (this.activation) return this.activation;
    const work = (async () => {
      if (!this.started || this.state.getBootStatus() !== "ready") return false;
      const budgetId = this.state.getBudgetId();
      if (!budgetId || !this.state.getLedger()) return false;
      const ownerId = await this.ownerId();
      if (!ownerId || this.state.getBootStatus() !== "ready" || this.state.getBudgetId() !== budgetId) return false;
      const nextScope = { ownerId, budgetId };
      if (sameScope(this.scope, nextScope) && this.plain && this.local) return true;

      this.deactivate(true);
      this.scope = nextScope;
      this.plain = this.createPlain(nextScope, this.activity);
      this.local = this.createE2ee(nextScope, this.activity);
      this.plain.start();
      return true;
    })();
    this.activation = work.finally(() => {
      this.activation = null;
    });
    return this.activation;
  }

  private readonly handleState = () => {
    const status = this.state.getBootStatus();
    if (status === "ready") void this.resume().catch(() => {});
    else this.deactivate(true);
  };

  private readonly wake = () => {
    if (this.visible()) void this.resume().catch(() => {});
  };

  private readonly wakeLocal = () => {
    if (!this.visible()) return;
    void this.activate()
      .then((active) => (active ? this.local?.resume() : undefined))
      .catch(() => {});
  };

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stateUnsubscribe = this.state.subscribe(this.handleState);
    this.windowTarget?.addEventListener("online", this.wake);
    this.windowTarget?.addEventListener("focus", this.wake);
    this.documentTarget?.addEventListener("visibilitychange", this.wake);
    // Plain jobs own their own activity-gated polling loop. This timer exists only
    // to let a newly elected device-local leader pick up E2EE work.
    this.wakeTimer = this.scheduleInterval(this.wakeLocal, E2EE_WAKE_INTERVAL_MS);
    this.handleState();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.stateUnsubscribe?.();
    this.stateUnsubscribe = null;
    this.windowTarget?.removeEventListener("online", this.wake);
    this.windowTarget?.removeEventListener("focus", this.wake);
    this.documentTarget?.removeEventListener("visibilitychange", this.wake);
    if (this.wakeTimer !== null) this.clearScheduledInterval(this.wakeTimer);
    this.wakeTimer = null;
    this.deactivate(false);
  }

  async resume(): Promise<void> {
    if (!(await this.activate()) || !this.plain || !this.local) return;
    const work: Promise<unknown>[] = [this.local.resume()];
    if (this.visible()) work.push(this.plain.refresh());
    await Promise.all(work);
  }

  async create(input: ImportJobManagerCreateInput): Promise<ImportActivityItem> {
    if (!(await this.activate()) || !this.plain || !this.local || !this.scope) throw new Error("import_manager_not_ready");
    const currentLedger = this.state.getLedger();
    const budget = currentLedger?.budgets.find((candidate) => candidate.id === this.scope?.budgetId);
    if (!budget) throw new Error("budget_mismatch");
    const id = this.randomId();
    const meta = this.tierMeta();
    if (meta.tier === "plain") {
      if (budget.preferences.aiProvider === "rules") throw new Error("ai_capability_unsupported");
      return this.plain.create({ id, accountId: input.accountId, locale: input.locale, images: [...input.images] });
    }
    if (budget.preferences.aiProvider !== "openai") throw new Error("ai_capability_unsupported");
    const created = await this.local.create({
      id,
      accountId: input.accountId,
      locale: input.locale,
      images: [...input.images],
      provider: { provider: "openai", model: budget.preferences.openaiModel as OpenAiModel },
    });
    void this.local.resume().catch(() => {});
    return created;
  }

  observe(id: string, listener: ImportActivityListener): () => void {
    return this.activity.observe(id, listener);
  }

  async list(): Promise<ImportActivityItem[]> {
    await this.resume();
    await this.local?.list();
    return this.activity.list();
  }

  private async item(id: string): Promise<ImportActivityItem | undefined> {
    const known = this.activity.get(id);
    if (known) return known;
    if (!(await this.activate()) || !this.plain || !this.local) return undefined;
    await this.local.list();
    const local = this.activity.get(id);
    if (local) return local;
    if (this.visible()) await this.plain.refresh();
    return this.activity.get(id);
  }

  async cancel(id: string): Promise<void> {
    const current = await this.item(id);
    if (!current) return;
    if (current.source === "e2ee") await this.local?.cancel(id);
    else await this.plain?.cancel(id);
  }

  async retry(id: string): Promise<void> {
    const current = await this.item(id);
    if (!current) return;
    if (current.source === "e2ee") await this.local?.retry(id);
    else await this.plain?.retry(id);
  }

  async dismiss(id: string): Promise<void> {
    const current = await this.item(id);
    if (!current) return;
    if (current.source === "e2ee") await this.local?.dismiss(id);
    else this.plain?.dismiss(id);
  }
}

export const importJobManager = new ImportJobManager();
