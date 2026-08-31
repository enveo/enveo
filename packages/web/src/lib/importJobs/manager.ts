import type { AiLocale, ClientLedger, OpenAiModel } from "@enveo/shared";
import { importApplyRowToken, plainImportApplyRowToken } from "../crypto";
import * as e2ee from "../e2ee";
import { idbGet } from "../idb";
import { type ImportApplyProgress, type ImportJobStorageScope, importJobStorage } from "../importJobStorage";
import { type BootStatus, store } from "../store";
import { verifiedIdentityUserId } from "../sync/identity";
import { type E2eeImportJobCreateInput, E2eeImportJobRunner } from "./e2eeRunner";
import { type PlainImportCreateInput, PlainImportJobAdapter } from "./plain";
import {
  createImportActivityStore,
  type ImportActivityItem,
  type ImportActivityListener,
  type ImportActivityStore,
  type ImportJobScopeCapability,
} from "./store";

export interface ImportJobManagerState {
  getBootStatus(): BootStatus;
  getBudgetId(): string | null;
  getLedger(): ClientLedger | null;
  subscribe(listener: () => void): () => void;
}

export interface ImportJobManagerPlainPort {
  start(): void;
  stop(): void;
  create(input: PlainImportCreateInput, onCreated?: ImportActivityListener): Promise<ImportActivityItem>;
  refresh(force?: boolean): Promise<void>;
  cancel(id: string): Promise<void>;
  retry(id: string): Promise<void>;
  complete(id: string, counts: { appliedCount: number; skippedCount: number }): Promise<void>;
  dismiss(id: string): void;
}

export interface ImportJobManagerE2eePort {
  stop(): void;
  create(input: E2eeImportJobCreateInput): Promise<ImportActivityItem>;
  resume(): Promise<void>;
  list(): Promise<ImportActivityItem[]>;
  cancel(id: string): Promise<void>;
  retry(id: string): Promise<void>;
  complete(id: string, counts: { appliedCount: number; skippedCount: number }): Promise<void>;
  dismiss(id: string): Promise<void>;
}

export interface ImportJobManagerCreateInput {
  accountId: string;
  locale: AiLocale;
  images: string[];
}

type ApplyLockAssertion = () => Promise<void>;
type WithApplyLock = <T>(name: string, callback: () => Promise<T>) => Promise<T>;

interface BrowserLockManager {
  request<T>(name: string, options: { mode: "exclusive" }, callback: () => Promise<T>): Promise<T>;
}

const withBrowserApplyLock: WithApplyLock = async (name, callback) => {
  const locks = (globalThis.navigator as (Navigator & { locks?: BrowserLockManager }) | undefined)?.locks;
  if (!locks) throw new Error("import_web_locks_unavailable");
  return locks.request(name, { mode: "exclusive" }, callback);
};

export interface ImportJobManagerOptions {
  state?: ImportJobManagerState;
  ownerId?: () => Promise<string | null>;
  tierMeta?: () => { tier: "plain" | "e2ee"; epoch: number };
  createPlain?: (scope: ImportJobStorageScope, activity: ImportActivityStore, capability: ImportJobScopeCapability) => ImportJobManagerPlainPort;
  createE2ee?: (scope: ImportJobStorageScope, activity: ImportActivityStore, capability: ImportJobScopeCapability) => ImportJobManagerE2eePort;
  randomId?: () => string;
  visible?: () => boolean;
  windowTarget?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  documentTarget?: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  scheduleInterval?: (callback: () => void, delay: number) => ReturnType<typeof setInterval>;
  clearScheduledInterval?: (timer: ReturnType<typeof setInterval>) => void;
  applyOwnerId?: () => string;
  deriveRowToken?: (item: ImportActivityItem, rowId: string) => Promise<string>;
  durableTransactionProof?: (scope: ImportJobStorageScope, transactionId: string) => Promise<"durable" | "rejected" | "absent">;
  nowMs?: () => number;
  scheduleApplyLeaseInterval?: (callback: () => void, delay: number) => ReturnType<typeof setInterval>;
  clearApplyLeaseInterval?: (timer: ReturnType<typeof setInterval>) => void;
  withApplyLock?: WithApplyLock;
}

const E2EE_WAKE_INTERVAL_MS = 2_000;
const APPLY_LEASE_MS = 30_000;
const APPLY_LEASE_RENEW_MS = 10_000;

interface ActivationSnapshot {
  fingerprint: string;
  budgetId: string;
  tier: "plain" | "e2ee";
  epoch: number;
}

interface ActivationResult {
  active: boolean;
  generation: number;
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
  private readonly applyOwnerId: string;
  private readonly deriveRowToken: NonNullable<ImportJobManagerOptions["deriveRowToken"]>;
  private readonly durableTransactionProof: NonNullable<ImportJobManagerOptions["durableTransactionProof"]>;
  private readonly nowMs: () => number;
  private readonly scheduleApplyLeaseInterval: NonNullable<ImportJobManagerOptions["scheduleApplyLeaseInterval"]>;
  private readonly clearApplyLeaseInterval: NonNullable<ImportJobManagerOptions["clearApplyLeaseInterval"]>;
  private readonly withApplyLock: WithApplyLock;
  private readonly activity = createImportActivityStore();
  private readonly progressWrites = new Map<string, Promise<void>>();
  private scope: ImportJobStorageScope | null = null;
  private plain: ImportJobManagerPlainPort | null = null;
  private local: ImportJobManagerE2eePort | null = null;
  private started = false;
  private stateUnsubscribe: (() => void) | null = null;
  private wakeTimer: ReturnType<typeof setInterval> | null = null;
  private activation: Promise<ActivationResult> | null = null;
  private generation = 0;
  private fingerprint: string | null = null;

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
      ((scope, activity, capability) =>
        new PlainImportJobAdapter({
          scope,
          activity,
          capability,
          // The manager owns foreground wake listeners; the adapter still owns its visible
          // polling timer and keeps server execution independent from observation.
          windowTarget: null,
          documentTarget: null,
        }));
    this.createE2ee = options.createE2ee ?? ((scope, activity, capability) => new E2eeImportJobRunner({ scope, activity, capability }));
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    this.visible = options.visible ?? (() => typeof document === "undefined" || document.visibilityState === "visible");
    this.windowTarget = options.windowTarget ?? (typeof window === "undefined" ? undefined : window);
    this.documentTarget = options.documentTarget ?? (typeof document === "undefined" ? undefined : document);
    this.scheduleInterval = options.scheduleInterval ?? ((callback, delay) => setInterval(callback, delay));
    this.clearScheduledInterval = options.clearScheduledInterval ?? ((timer) => clearInterval(timer));
    this.applyOwnerId = (options.applyOwnerId ?? (() => crypto.randomUUID()))();
    this.deriveRowToken =
      options.deriveRowToken ??
      (async (item, rowId) => {
        if (item.tier === "plain") return plainImportApplyRowToken(item.budgetId, item.id, rowId);
        const key = e2ee.requireValidatedDek(item.epoch);
        try {
          return await importApplyRowToken(key, item.budgetId, item.epoch, item.id, rowId);
        } finally {
          key.fill(0);
        }
      });
    this.durableTransactionProof =
      options.durableTransactionProof ?? ((scope, transactionId) => importJobStorage.durableTransactionProof(scope, transactionId));
    this.nowMs = options.nowMs ?? Date.now;
    this.scheduleApplyLeaseInterval = options.scheduleApplyLeaseInterval ?? ((callback, delay) => setInterval(callback, delay));
    this.clearApplyLeaseInterval = options.clearApplyLeaseInterval ?? ((timer) => clearInterval(timer));
    this.withApplyLock = options.withApplyLock ?? withBrowserApplyLock;
  }

  private deactivate(clear: boolean): void {
    this.plain?.stop();
    this.local?.stop();
    this.plain = null;
    this.local = null;
    this.scope = null;
    if (clear) {
      this.activity.clear();
      this.progressWrites.clear();
    }
  }

  private snapshot(): ActivationSnapshot | null {
    if (this.state.getBootStatus() !== "ready") return null;
    const budgetId = this.state.getBudgetId();
    if (!budgetId || !this.state.getLedger()) return null;
    const meta = this.tierMeta();
    return {
      budgetId,
      tier: meta.tier,
      epoch: meta.epoch,
      fingerprint: JSON.stringify(["ready", budgetId, meta.tier, meta.epoch]),
    };
  }

  private isActivationCurrent(generation: number, snapshot: ActivationSnapshot): boolean {
    return this.started && this.generation === generation && this.snapshot()?.fingerprint === snapshot.fingerprint;
  }

  private activateOnce(): Promise<ActivationResult> {
    if (this.activation) return this.activation;
    const generation = this.generation;
    const work = (async () => {
      const snapshot = this.snapshot();
      if (!this.started || !snapshot || snapshot.fingerprint !== this.fingerprint) return { active: false, generation };
      const ownerId = await this.ownerId();
      if (!ownerId || !this.isActivationCurrent(generation, snapshot)) return { active: false, generation };
      const nextScope = { ownerId, budgetId: snapshot.budgetId };
      if (this.scope?.ownerId === ownerId && this.scope.budgetId === snapshot.budgetId && (this.plain || this.local)) {
        return { active: true, generation };
      }

      const capability: ImportJobScopeCapability = {
        isCurrent: () => this.isActivationCurrent(generation, snapshot) && this.scope?.ownerId === ownerId && this.scope.budgetId === snapshot.budgetId,
      };
      this.scope = nextScope;
      if (snapshot.tier === "plain") {
        if (!this.isActivationCurrent(generation, snapshot)) return { active: false, generation };
        this.plain = this.createPlain(nextScope, this.activity, capability);
        if (!this.isActivationCurrent(generation, snapshot)) {
          this.plain.stop();
          this.plain = null;
          this.scope = null;
          return { active: false, generation };
        }
        this.plain.start();
      } else {
        // Plaintext screenshot payloads cannot become E2EE input. Remove them without
        // constructing the network adapter, so a tier flip can never upload them.
        const drafts = await importJobStorage.listDrafts(nextScope);
        if (!this.isActivationCurrent(generation, snapshot)) return { active: false, generation };
        for (const draft of drafts) {
          if (!this.isActivationCurrent(generation, snapshot)) return { active: false, generation };
          await importJobStorage.deleteDraft(nextScope, draft.id, draft.requestHash);
        }
        if (!this.isActivationCurrent(generation, snapshot)) return { active: false, generation };
        this.local = this.createE2ee(nextScope, this.activity, capability);
      }
      return { active: true, generation };
    })();
    this.activation = work.finally(() => {
      this.activation = null;
    });
    return this.activation;
  }

  private async activate(): Promise<boolean> {
    this.reconcileConfiguration();
    let result = await this.activateOnce();
    while (!result.active && this.started && result.generation !== this.generation && this.snapshot()?.fingerprint === this.fingerprint) {
      result = await this.activateOnce();
    }
    return result.active;
  }

  private reconcileConfiguration(): { active: boolean; changed: boolean } {
    const snapshot = this.snapshot();
    const nextFingerprint = snapshot?.fingerprint ?? `inactive:${this.state.getBootStatus()}`;
    if (nextFingerprint === this.fingerprint) return { active: snapshot !== null, changed: false };
    this.fingerprint = nextFingerprint;
    this.generation++;
    this.deactivate(true);
    return { active: snapshot !== null, changed: true };
  }

  private readonly handleState = () => {
    const configuration = this.reconcileConfiguration();
    if (configuration.active && configuration.changed) void this.resume().catch(() => {});
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
    this.generation++;
    this.fingerprint = null;
    this.stateUnsubscribe?.();
    this.stateUnsubscribe = null;
    this.windowTarget?.removeEventListener("online", this.wake);
    this.windowTarget?.removeEventListener("focus", this.wake);
    this.documentTarget?.removeEventListener("visibilitychange", this.wake);
    if (this.wakeTimer !== null) this.clearScheduledInterval(this.wakeTimer);
    this.wakeTimer = null;
    this.deactivate(true);
  }

  async resume(): Promise<void> {
    if (!(await this.activate())) return;
    const generation = this.generation;
    if (this.local) await this.local.resume();
    else if (this.visible() && this.plain) await this.plain.refresh(false);
    if (generation !== this.generation) return;
  }

  async create(input: ImportJobManagerCreateInput, onCreated?: ImportActivityListener): Promise<ImportActivityItem> {
    if (!(await this.activate()) || !this.scope) throw new Error("import_manager_not_ready");
    const generation = this.generation;
    const currentLedger = this.state.getLedger();
    const budget = currentLedger?.budgets.find((candidate) => candidate.id === this.scope?.budgetId);
    if (!budget) throw new Error("budget_mismatch");
    const id = this.randomId();
    const meta = this.tierMeta();
    if (meta.tier === "plain") {
      if (!this.plain || budget.preferences.aiProvider === "rules") throw new Error("ai_capability_unsupported");
      const created = await this.plain.create({ id, accountId: input.accountId, locale: input.locale, images: [...input.images] }, onCreated);
      if (generation !== this.generation) throw new Error("stale_import_job_manager");
      return created;
    }
    if (!this.local || budget.preferences.aiProvider !== "openai") throw new Error("ai_capability_unsupported");
    const created = await this.local.create({
      id,
      accountId: input.accountId,
      locale: input.locale,
      images: [...input.images],
      provider: { provider: "openai", model: budget.preferences.openaiModel as OpenAiModel },
    });
    if (generation !== this.generation) throw new Error("stale_import_job_manager");
    onCreated?.(created);
    void this.local.resume().catch(() => {});
    return created;
  }

  observe(id: string, listener: ImportActivityListener): () => void {
    return this.activity.observe(id, listener);
  }

  private async rowTokens(id: string, rowIds: readonly string[]): Promise<Map<string, string>> {
    const current = this.activity.get(id);
    if (!current) throw new Error("import_manager_not_ready");
    const pairs = await Promise.all(
      [...new Set(rowIds)].map(async (rowId) => {
        const token = await this.deriveRowToken(current, rowId);
        if (!token || token === rowId) throw new Error("invalid_import_row_token");
        return [rowId, token] as const;
      }),
    );
    return new Map(pairs);
  }

  async recordSkipped(id: string, rowIds: readonly string[]): Promise<void> {
    const scope = this.scope;
    if (!scope || !this.activity.get(id)) return;
    const tokens = [...(await this.rowTokens(id, rowIds)).values()];
    await this.withProgressLock(id, async () => {
      await importJobStorage.mergeApplyProgress(scope, id, { skippedRowIds: tokens });
    });
  }

  private async withProgressLock<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.progressWrites.get(id) ?? Promise.resolve();
    let result!: T;
    const write = previous
      .catch(() => {})
      .then(async () => {
        result = await task();
      });
    this.progressWrites.set(id, write);
    try {
      await write;
      return result;
    } finally {
      if (this.progressWrites.get(id) === write) this.progressWrites.delete(id);
    }
  }

  async applyRow(id: string, rowId: string, mutation: (transactionId: string, assertCurrent: ApplyLockAssertion) => Promise<void> | void): Promise<void> {
    const scope = this.scope;
    if (!scope || !this.activity.get(id)) throw new Error("import_manager_not_ready");
    const rowToken = (await this.rowTokens(id, [rowId])).get(rowId);
    if (!rowToken) throw new Error("invalid_import_row_token");
    const lockName = JSON.stringify(["enveo-import-apply", 1, scope.ownerId, scope.budgetId, id, rowToken]);
    await this.withApplyLock(lockName, async () => {
      const existing = await importJobStorage.getApplyProgressRecord(scope, id);
      const prepared = existing.preparedRows.find((candidate) => candidate.rowToken === rowToken);
      if (prepared) {
        const proof = await this.durableTransactionProof(scope, prepared.transactionId);
        if (proof === "durable") {
          await importJobStorage.promoteDurableApplyRow(scope, id, rowToken, prepared.transactionId);
          return;
        }
      }
      const ownerToken = this.applyOwnerId;
      const claimedAt = this.nowMs();
      const claim = await importJobStorage.claimApplyRow(scope, id, {
        rowToken,
        transactionId: this.randomId(),
        ownerToken,
        now: claimedAt,
        leaseUntil: claimedAt + APPLY_LEASE_MS,
      });
      if (claim.kind === "applied") return;
      if (claim.kind === "busy") throw new Error("import_row_busy");
      let leaseLost = false;
      const renew = async (): Promise<boolean> => {
        if (leaseLost) return false;
        const now = this.nowMs();
        const renewed = await importJobStorage.renewApplyRow(scope, id, {
          rowToken,
          ownerToken,
          fence: claim.fence,
          now,
          leaseUntil: now + APPLY_LEASE_MS,
        });
        if (!renewed) leaseLost = true;
        return renewed;
      };
      const assertCurrent = async (): Promise<void> => {
        if (!(await renew())) throw new Error("import_row_lease_lost");
      };
      const timer = this.scheduleApplyLeaseInterval(() => {
        void renew().catch(() => {
          leaseLost = true;
        });
      }, APPLY_LEASE_RENEW_MS);
      try {
        await assertCurrent();
        await mutation(claim.transactionId, assertCurrent);
        await assertCurrent();
        const proof = await this.durableTransactionProof(scope, claim.transactionId);
        await assertCurrent();
        if (proof !== "durable") throw new Error("local_persistence_failed");
        if (!(await importJobStorage.completeApplyRow(scope, id, { rowToken, ownerToken, fence: claim.fence }))) {
          throw new Error("import_row_lease_lost");
        }
      } catch (error) {
        const proof = await this.durableTransactionProof(scope, claim.transactionId).catch(() => "absent" as const);
        if (proof === "durable") await importJobStorage.promoteDurableApplyRow(scope, id, rowToken, claim.transactionId);
        else await importJobStorage.releaseApplyRow(scope, id, { rowToken, ownerToken, fence: claim.fence });
        throw error;
      } finally {
        this.clearApplyLeaseInterval(timer);
      }
    });
  }

  async appliedProgress(id: string, rowIds: readonly string[] = []): Promise<ImportApplyProgress> {
    const scope = this.scope;
    if (!scope) return { appliedRowIds: [], appliedCount: 0, skippedRowIds: [], skippedCount: 0 };
    const tokensByRow = await this.rowTokens(id, rowIds);
    return this.withProgressLock(id, async () => {
      let progress = await importJobStorage.getApplyProgressRecord(scope, id);
      for (const prepared of progress.preparedRows) {
        if ((await this.durableTransactionProof(scope, prepared.transactionId)) !== "durable") continue;
        await importJobStorage.promoteDurableApplyRow(scope, id, prepared.rowToken, prepared.transactionId);
      }
      progress = await importJobStorage.getApplyProgressRecord(scope, id);
      const appliedTokens = new Set(progress.appliedRowIds);
      const skippedTokens = new Set(progress.skippedRowIds);
      const appliedRowIds = [...tokensByRow].flatMap(([rowId, token]) => (appliedTokens.has(token) ? [rowId] : []));
      const skippedRowIds = [...tokensByRow].flatMap(([rowId, token]) => (skippedTokens.has(token) ? [rowId] : []));
      return { appliedRowIds, appliedCount: appliedRowIds.length, skippedRowIds, skippedCount: skippedRowIds.length };
    });
  }

  private async clearApplied(id: string, scope: ImportJobStorageScope | null): Promise<void> {
    await this.progressWrites.get(id)?.catch(() => {});
    this.progressWrites.delete(id);
    if (scope) await importJobStorage.deleteApplyProgress(scope, id);
  }

  async list(): Promise<ImportActivityItem[]> {
    if (!(await this.activate())) return [];
    if (this.local) await this.local.list();
    else if (this.visible()) await this.plain?.refresh(true);
    return this.activity.list();
  }

  subscribe = (listener: () => void): (() => void) => this.activity.subscribe(listener);

  activityVersion = (): number => this.activity.getVersion();

  activityItems = (): ImportActivityItem[] => this.activity.list();

  private async item(id: string): Promise<ImportActivityItem | undefined> {
    const known = this.activity.get(id);
    if (known) return known;
    if (!(await this.activate())) return undefined;
    await this.local?.list();
    const local = this.activity.get(id);
    if (local) return local;
    if (this.visible()) await this.plain?.refresh(true);
    return this.activity.get(id);
  }

  private async mutationItem(id: string): Promise<{ item: ImportActivityItem; scope: ImportJobStorageScope; generation: number } | null> {
    if (!(await this.activate()) || !this.scope) return null;
    const generation = this.generation;
    const scope = this.scope;
    const snapshot = this.snapshot();
    if (!snapshot || snapshot.budgetId !== scope.budgetId) return null;
    const item = await this.item(id);
    if (
      !item ||
      !this.isActivationCurrent(generation, snapshot) ||
      this.scope !== scope ||
      item.budgetId !== scope.budgetId ||
      item.source === "plain-draft" ||
      (item.source === "e2ee") !== (this.local !== null)
    ) {
      return null;
    }
    return { item, scope, generation };
  }

  async cancel(id: string): Promise<void> {
    const target = await this.mutationItem(id);
    if (!target) return;
    if (target.item.source === "e2ee") await this.local?.cancel(id);
    else await this.plain?.cancel(id);
    if (target.generation === this.generation && target.scope === this.scope) await this.clearApplied(id, target.scope);
  }

  async retry(id: string): Promise<void> {
    const target = await this.mutationItem(id);
    if (!target) return;
    if (target.item.source === "e2ee") await this.local?.retry(id);
    else await this.plain?.retry(id);
  }

  async complete(id: string, counts: { appliedCount: number; skippedCount: number }): Promise<void> {
    const target = await this.mutationItem(id);
    if (!target) return;
    if (target.item.source === "e2ee") await this.local?.complete(id, counts);
    else await this.plain?.complete(id, counts);
    if (target.generation === this.generation && target.scope === this.scope) await this.clearApplied(id, target.scope);
  }

  async dismiss(id: string): Promise<void> {
    const current = await this.item(id);
    if (!current) return;
    const scope = this.scope;
    if (current.source === "e2ee") await this.local?.dismiss(id);
    else this.plain?.dismiss(id);
    await this.clearApplied(id, scope);
  }
}

export const importJobManager = new ImportJobManager();
