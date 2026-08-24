import {
  advanceImportJob,
  type ClientLedger,
  type ImportJobErrorCode,
  type ImportJobProviderSnapshot,
  type ImportRecognitionPipelineInput,
  type ImportRecognitionResult,
  importJobResultSchema,
  OPENAI_MODELS,
  type OpenAiModel,
} from "@enveo/shared";
import { createE2eeByokProvider, type E2eeDurableImportInput } from "../aiProvider/e2eeByok";
import { decryptPayload, encryptPayload, importJobAadContext } from "../crypto";
import * as e2ee from "../e2ee";
import { type ImportJobStorageScope, importJobStorage, type StoredE2eeImportJob } from "../importJobStorage";
import { store } from "../store";
import { isLeaderTab } from "../sync/multitab";
import { type ImportActivityItem, type ImportActivityStore, type ImportJobScopeCapability, importActivityFromE2ee } from "./store";

const IMPORT_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_BACKOFF_MS = [30_000, 120_000] as const;

type DurableLifecycle = NonNullable<ImportRecognitionPipelineInput["lifecycle"]>;

export interface E2eeImportJobExecutionProvider {
  runDurableImport(input: E2eeDurableImportInput): Promise<ImportRecognitionResult>;
}

export interface E2eeImportJobCreateInput {
  id: string;
  accountId: string;
  locale: string;
  images: string[];
  provider: { provider: "openai"; model: OpenAiModel };
}

export interface E2eeImportJobRunnerOptions {
  scope: ImportJobStorageScope;
  activity: ImportActivityStore;
  capability?: ImportJobScopeCapability;
  ledger?: () => ClientLedger | null;
  tierMeta?: () => { tier: "plain" | "e2ee"; epoch: number };
  requireDek?: (epoch: number) => Uint8Array;
  online?: () => boolean;
  visible?: () => boolean;
  canRun?: () => boolean;
  provider?: (snapshot: ImportJobProviderSnapshot & { provider: "openai" }) => E2eeImportJobExecutionProvider;
  encrypt?: typeof encryptPayload;
  decrypt?: typeof decryptPayload;
  now?: () => Date;
}

class StaleImportJobRunner extends Error {
  constructor() {
    super("stale_import_job_runner");
  }
}

class ImportJobGenerationChanged extends Error {
  constructor() {
    super("tier_mismatch");
  }
}

function isOpenAiModel(model: string): model is OpenAiModel {
  return OPENAI_MODELS.includes(model as OpenAiModel);
}

function failureCode(error: unknown): ImportJobErrorCode {
  const code = error instanceof Error ? error.message : "";
  if (code === "ai_timeout") return "ai_timeout";
  if (["ai_unreachable", "ai_upstream_error", "network"].includes(code)) return "network";
  if (code === "ai_key_invalid" || code === "credential_not_configured") return "ai_key_invalid";
  if (code === "ai_model_unavailable") return "ai_model_unavailable";
  if (code === "account_unavailable") return "account_unavailable";
  if (code === "tier_mismatch") return "tier_mismatch";
  if (code.includes("invalid import enrichment") || code.includes("invalid import") || error instanceof SyntaxError) return "malformed_model_response";
  return "network";
}

function isOfflineFailure(error: unknown): boolean {
  return error instanceof Error && error.message === "ai_offline";
}

function isPermanentFailure(error: unknown): boolean {
  const code = error instanceof Error ? error.message : "";
  return ["ai_key_invalid", "credential_not_configured", "ai_model_unavailable", "account_unavailable", "tier_mismatch"].includes(code);
}

function activePhase(job: StoredE2eeImportJob): "extracting" | "validating" | "enriching" | "reconciling" {
  if (["extracting", "validating", "enriching", "reconciling"].includes(job.phase)) {
    return job.phase as "extracting" | "validating" | "enriching" | "reconciling";
  }
  return job.resumePhase ?? "extracting";
}

function parseInput(value: string): { images: string[] } {
  const parsed = JSON.parse(value) as { images?: unknown };
  if (!Array.isArray(parsed.images) || parsed.images.length < 1 || parsed.images.length > 6 || parsed.images.some((image) => typeof image !== "string")) {
    throw new Error("invalid_import_input");
  }
  return { images: [...parsed.images] } as { images: string[] };
}

export class E2eeImportJobRunner {
  private readonly ledger: () => ClientLedger | null;
  private readonly tierMeta: () => { tier: "plain" | "e2ee"; epoch: number };
  private readonly requireDek: (epoch: number) => Uint8Array;
  private readonly online: () => boolean;
  private readonly visible: () => boolean;
  private readonly canRun: () => boolean;
  private readonly provider: NonNullable<E2eeImportJobRunnerOptions["provider"]>;
  private readonly encrypt: typeof encryptPayload;
  private readonly decrypt: typeof decryptPayload;
  private readonly now: () => Date;
  private recoveryDone = false;
  private resumePromise: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly options: E2eeImportJobRunnerOptions) {
    this.ledger = options.ledger ?? store.getLedger;
    this.tierMeta = options.tierMeta ?? e2ee.getTierMeta;
    this.requireDek = options.requireDek ?? e2ee.requireValidatedDek;
    this.online = options.online ?? (() => typeof navigator === "undefined" || navigator.onLine !== false);
    this.visible = options.visible ?? (() => typeof document === "undefined" || document.visibilityState === "visible");
    this.canRun =
      options.canRun ??
      (() => {
        const locks = typeof navigator === "undefined" ? undefined : (navigator as Navigator & { locks?: unknown }).locks;
        return !locks || isLeaderTab();
      });
    this.provider =
      options.provider ??
      ((snapshot) => {
        if (!isOpenAiModel(snapshot.model)) throw new Error("ai_model_unavailable");
        return createE2eeByokProvider(this.options.scope.budgetId, snapshot.model, true);
      });
    this.encrypt = options.encrypt ?? encryptPayload;
    this.decrypt = options.decrypt ?? decryptPayload;
    this.now = options.now ?? (() => new Date());
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private isCurrent(): boolean {
    return !this.stopped && (this.options.capability?.isCurrent() ?? true);
  }

  private assertCurrent(): void {
    if (!this.isCurrent()) throw new StaleImportJobRunner();
  }

  stop(): void {
    this.stopped = true;
  }

  private generationMatches(job: StoredE2eeImportJob): boolean {
    if (!this.isCurrent()) return false;
    const current = this.tierMeta();
    return current.tier === "e2ee" && current.epoch === job.epoch && job.budgetId === this.options.scope.budgetId;
  }

  private async write(
    current: StoredE2eeImportJob,
    change: Partial<StoredE2eeImportJob>,
    result: ImportRecognitionResult | null = null,
  ): Promise<StoredE2eeImportJob> {
    this.assertCurrent();
    const next = {
      ...current,
      ...change,
      checkpointRevision: current.checkpointRevision + 1,
      updatedAt: change.updatedAt ?? this.timestamp(),
    } satisfies StoredE2eeImportJob;
    if (!(await importJobStorage.putJobIfRevision(this.options.scope, next, current.checkpointRevision))) throw new StaleImportJobRunner();
    this.assertCurrent();
    this.options.activity.upsert(importActivityFromE2ee(next, result));
    return next;
  }

  private async transition(
    current: StoredE2eeImportJob,
    event: Parameters<typeof advanceImportJob>[1],
    change: Partial<StoredE2eeImportJob> = {},
    result: ImportRecognitionResult | null = null,
  ): Promise<StoredE2eeImportJob> {
    return this.write(current, { ...advanceImportJob(current, event), ...change }, result);
  }

  private async wait(current: StoredE2eeImportJob, phase: "waiting_for_network" | "waiting_for_device" | "waiting_for_unlock") {
    if (current.status === "queued") current = await this.transition(current, { type: "claimed", at: this.timestamp() });
    if (current.status !== "running") return current;
    if (current.phase === phase) return current;
    if (["waiting_for_network", "waiting_for_device", "waiting_for_unlock"].includes(current.phase)) {
      return this.write(current, { phase, resumePhase: current.resumePhase ?? activePhase(current) });
    }
    return this.transition(current, { type: "wait", phase, at: this.timestamp() });
  }

  private async fail(current: StoredE2eeImportJob, errorCode: ImportJobErrorCode): Promise<void> {
    if (current.status !== "queued" && current.status !== "running") return;
    await this.transition(current, { type: "failed", errorCode, retryAt: null, at: this.timestamp() });
  }

  private async recordFailure(current: StoredE2eeImportJob, error: unknown): Promise<void> {
    const errorCode = failureCode(error);
    if (isPermanentFailure(error) || current.attempt >= 3) {
      await this.fail(current, errorCode);
      return;
    }
    const delay = RETRY_BACKOFF_MS[Math.max(0, current.attempt - 1)] ?? RETRY_BACKOFF_MS.at(-1)!;
    const retryAt = new Date(this.now().getTime() + delay).toISOString();
    await this.transition(current, { type: "failed", errorCode, retryAt, at: this.timestamp() });
  }

  async create(input: E2eeImportJobCreateInput): Promise<ImportActivityItem> {
    this.assertCurrent();
    const meta = this.tierMeta();
    if (meta.tier !== "e2ee" || meta.epoch < 1) throw new Error("tier_mismatch");
    if (input.provider.provider !== "openai" || !isOpenAiModel(input.provider.model)) throw new Error("ai_capability_unsupported");
    const currentLedger = this.ledger();
    const budget = currentLedger?.budgets.find((candidate) => candidate.id === this.options.scope.budgetId);
    const account = currentLedger?.accounts.find((candidate) => candidate.id === input.accountId && !candidate.archived);
    if (!budget || !account) throw new Error("account_unavailable");

    const key = this.requireDek(meta.epoch);
    let inputCiphertext: string;
    try {
      inputCiphertext = await this.encrypt(
        JSON.stringify({ images: [...input.images] }),
        key,
        importJobAadContext(this.options.scope.budgetId, meta.epoch, input.id, "input"),
      );
      this.assertCurrent();
    } finally {
      key.fill(0);
    }
    const now = this.now();
    const timestamp = now.toISOString();
    const job = {
      id: input.id,
      ownerId: this.options.scope.ownerId,
      budgetId: this.options.scope.budgetId,
      accountId: input.accountId,
      provider: { ...input.provider },
      locale: input.locale,
      tier: "e2ee" as const,
      epoch: meta.epoch,
      status: "queued" as const,
      phase: "queued" as const,
      resumePhase: null,
      cancelRequested: false,
      attempt: 0,
      errorCode: null,
      retryAt: null,
      inputCiphertext,
      checkpointCiphertext: null,
      resultCiphertext: null,
      checkpointRevision: 0,
      proposalCount: 0,
      appliedCount: 0,
      skippedCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: new Date(now.getTime() + IMPORT_JOB_RETENTION_MS).toISOString(),
    } satisfies StoredE2eeImportJob;
    this.assertCurrent();
    await importJobStorage.putJob(this.options.scope, job);
    this.assertCurrent();
    const item = importActivityFromE2ee(job);
    this.options.activity.upsert(item);
    return item;
  }

  private async recoverInterrupted(): Promise<void> {
    this.assertCurrent();
    if (this.recoveryDone) return;
    this.recoveryDone = true;
    for (const job of await importJobStorage.listJobs(this.options.scope)) {
      this.assertCurrent();
      if (job.status !== "running") continue;
      try {
        if (["waiting_for_network", "waiting_for_device", "waiting_for_unlock"].includes(job.phase)) {
          await this.write(job, { phase: "waiting_for_device", resumePhase: job.resumePhase ?? activePhase(job) });
        } else {
          await this.transition(job, { type: "wait", phase: "waiting_for_device", at: this.timestamp() });
        }
      } catch (error) {
        if (!(error instanceof StaleImportJobRunner)) throw error;
      }
    }
  }

  private async fence(current: StoredE2eeImportJob): Promise<void> {
    this.assertCurrent();
    const durable = await importJobStorage.getJob(this.options.scope, current.id);
    this.assertCurrent();
    if (!durable || durable.checkpointRevision !== current.checkpointRevision || durable.cancelRequested || durable.status === "cancelled") {
      throw new StaleImportJobRunner();
    }
    if (!this.generationMatches(current)) throw new ImportJobGenerationChanged();
  }

  private async run(job: StoredE2eeImportJob): Promise<void> {
    if (!this.isCurrent()) return;
    if (job.status === "queued") {
      try {
        job = await this.transition(job, { type: "claimed", at: this.timestamp() });
      } catch (error) {
        if (error instanceof StaleImportJobRunner) return;
        throw error;
      }
    }
    if (job.status !== "running") return;

    try {
      if (!this.generationMatches(job)) {
        await this.fail(job, "tier_mismatch");
        return;
      }
      if (!this.canRun() || !this.visible()) {
        await this.wait(job, "waiting_for_device");
        return;
      }
      if (!this.online()) {
        await this.wait(job, "waiting_for_network");
        return;
      }

      let key: Uint8Array;
      try {
        key = this.requireDek(job.epoch);
      } catch {
        await this.wait(job, "waiting_for_unlock");
        return;
      }
      try {
        if (["waiting_for_network", "waiting_for_device", "waiting_for_unlock"].includes(job.phase)) {
          job = await this.transition(job, { type: "resume", at: this.timestamp() });
        }
        const currentLedger = this.ledger();
        if (!currentLedger?.budgets.some((candidate) => candidate.id === job.budgetId)) throw new Error("tier_mismatch");
        if (!currentLedger.accounts.some((candidate) => candidate.id === job.accountId && !candidate.archived)) throw new Error("account_unavailable");
        if (!isOpenAiModel(job.provider.model)) throw new Error("ai_model_unavailable");

        let checkpoint: ImportRecognitionResult | undefined;
        let images: string[] = [];
        if (job.checkpointCiphertext) {
          checkpoint = importJobResultSchema.parse(
            JSON.parse(await this.decrypt(job.checkpointCiphertext, key, importJobAadContext(job.budgetId, job.epoch, job.id, "checkpoint"))),
          );
          this.assertCurrent();
        } else {
          if (!job.inputCiphertext) throw new Error("invalid_import_input");
          images = parseInput(await this.decrypt(job.inputCiphertext, key, importJobAadContext(job.budgetId, job.epoch, job.id, "input"))).images;
          this.assertCurrent();
        }

        const lifecycle: DurableLifecycle = {
          beforeUpstream: () => this.fence(job),
          afterUpstream: () => this.fence(job),
          saveExtraction: async (result) => {
            await this.fence(job);
            const checkpointCiphertext = await this.encrypt(JSON.stringify(result), key, importJobAadContext(job.budgetId, job.epoch, job.id, "checkpoint"));
            this.assertCurrent();
            job = await this.transition(job, { type: "phase", phase: "validating", at: this.timestamp() }, { checkpointCiphertext });
          },
          advancePhase: async (phase) => {
            await this.fence(job);
            job = await this.transition(job, { type: "phase", phase, at: this.timestamp() });
          },
          saveResult: async (result) => {
            await this.fence(job);
            const resultCiphertext = await this.encrypt(JSON.stringify(result), key, importJobAadContext(job.budgetId, job.epoch, job.id, "result"));
            this.assertCurrent();
            job = await this.transition(
              job,
              { type: "result_ready", at: this.timestamp() },
              { resultCiphertext, proposalCount: result.proposals.length },
              result,
            );
          },
        };
        this.assertCurrent();
        const executionProvider = this.provider(job.provider);
        this.assertCurrent();
        await executionProvider.runDurableImport({
          images,
          locale: job.locale,
          ledger: currentLedger,
          accountId: job.accountId,
          checkpoint,
          lifecycle,
        });
        this.assertCurrent();
      } finally {
        key.fill(0);
      }
    } catch (error) {
      if (error instanceof StaleImportJobRunner) return;
      if (!this.isCurrent()) return;
      const current = await importJobStorage.getJob(this.options.scope, job.id);
      if (!this.isCurrent()) return;
      if (current?.status !== "running") return;
      try {
        if (error instanceof ImportJobGenerationChanged || !this.generationMatches(current)) await this.fail(current, "tier_mismatch");
        else if (isOfflineFailure(error)) await this.wait(current, "waiting_for_network");
        else if (error instanceof Error && error.message === "locked") await this.wait(current, "waiting_for_unlock");
        else await this.recordFailure(current, error);
      } catch (writeError) {
        if (!(writeError instanceof StaleImportJobRunner)) throw writeError;
      }
    }
  }

  resume(): Promise<void> {
    if (!this.isCurrent()) return Promise.resolve();
    if (this.resumePromise) return this.resumePromise;
    const work = (async () => {
      let jobs = await importJobStorage.listJobs(this.options.scope);
      this.assertCurrent();
      for (const job of jobs) {
        this.assertCurrent();
        this.options.activity.upsert(importActivityFromE2ee(job));
      }
      // A tab that can see the shared replica but does not own the execution lock must
      // remain observational. Even stale-running recovery is an execution mutation:
      // performing it here would fence the active leader out through revision CAS.
      if (!this.canRun()) return;
      await this.recoverInterrupted();
      this.assertCurrent();
      jobs = await importJobStorage.listJobs(this.options.scope);
      this.assertCurrent();
      for (let job of jobs) {
        this.assertCurrent();
        this.options.activity.upsert(importActivityFromE2ee(job));
        if (job.status === "failed" && job.retryAt !== null && job.retryAt <= this.timestamp()) {
          try {
            job = await this.transition(job, { type: "retry", at: this.timestamp() });
          } catch (error) {
            if (error instanceof StaleImportJobRunner) continue;
            throw error;
          }
        }
        if (job.status === "queued" || job.status === "running") await this.run(job);
      }
    })().catch((error) => {
      if (!(error instanceof StaleImportJobRunner)) throw error;
    });
    this.resumePromise = work.finally(() => {
      this.resumePromise = null;
    });
    return this.resumePromise;
  }

  async list(): Promise<ImportActivityItem[]> {
    if (!this.isCurrent()) return [];
    const items: ImportActivityItem[] = [];
    for (const job of await importJobStorage.listJobs(this.options.scope)) {
      if (!this.isCurrent()) return items;
      let result: ImportRecognitionResult | null = null;
      if (job.resultCiphertext && this.generationMatches(job)) {
        try {
          const key = this.requireDek(job.epoch);
          try {
            result = importJobResultSchema.parse(
              JSON.parse(await this.decrypt(job.resultCiphertext, key, importJobAadContext(job.budgetId, job.epoch, job.id, "result"))),
            );
            this.assertCurrent();
          } finally {
            key.fill(0);
          }
        } catch {
          result = null;
        }
      }
      const item = importActivityFromE2ee(job, result);
      items.push(item);
      if (this.isCurrent()) this.options.activity.upsert(item);
    }
    return items;
  }

  async cancel(id: string): Promise<void> {
    if (!this.isCurrent()) return;
    let job = await importJobStorage.getJob(this.options.scope, id);
    if (!this.isCurrent()) return;
    if (!job || job.status === "cancelled" || job.status === "completed") return;
    try {
      job = await this.transition(job, { type: "cancel", at: this.timestamp() });
      if (job.status === "running") await this.transition(job, { type: "cancelled", at: this.timestamp() });
    } catch (error) {
      if (!(error instanceof StaleImportJobRunner)) throw error;
    }
  }

  async retry(id: string): Promise<void> {
    if (!this.isCurrent()) return;
    const job = await importJobStorage.getJob(this.options.scope, id);
    if (!this.isCurrent()) return;
    if (job?.status !== "failed") return;
    try {
      await this.transition(job, { type: "retry", at: this.timestamp() });
      await this.resume();
    } catch (error) {
      if (!(error instanceof StaleImportJobRunner)) throw error;
    }
  }

  async complete(id: string, counts: { appliedCount: number; skippedCount: number }): Promise<void> {
    if (!this.isCurrent()) return;
    let job = await importJobStorage.getJob(this.options.scope, id);
    if (!this.isCurrent() || job?.status !== "ready") return;
    try {
      if (job.phase === "ready") job = await this.transition(job, { type: "begin_apply", at: this.timestamp() });
      if (job.phase !== "applying") return;
      await this.transition(
        job,
        { type: "completed", at: this.timestamp() },
        {
          inputCiphertext: null,
          checkpointCiphertext: null,
          resultCiphertext: null,
          appliedCount: counts.appliedCount,
          skippedCount: counts.skippedCount,
        },
        null,
      );
    } catch (error) {
      if (!(error instanceof StaleImportJobRunner)) throw error;
    }
  }

  async dismiss(id: string): Promise<void> {
    if (!this.isCurrent()) return;
    if (await importJobStorage.deleteJob(this.options.scope, id)) {
      if (this.isCurrent()) this.options.activity.remove(id);
    }
  }
}
