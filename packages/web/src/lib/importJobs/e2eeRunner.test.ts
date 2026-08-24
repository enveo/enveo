import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type ClientLedger, createDefaultBudgetPreferences, type ImportRecognitionResult } from "@enveo/shared";
import { IDBFactory } from "fake-indexeddb";
import { generateDek } from "../crypto";
import { __resetStorageForTests, storageMode } from "../idb";
import { type ImportJobStorageScope, importJobStorage } from "../importJobStorage";
import { type E2eeImportJobExecutionProvider, E2eeImportJobRunner, type E2eeImportJobRunnerOptions } from "./e2eeRunner";
import { createImportActivityStore } from "./store";

const ID = "11111111-1111-1111-1111-111111111111";
const BUDGET = "22222222-2222-2222-2222-222222222222";
const ACCOUNT = "33333333-3333-3333-3333-333333333333";
const SCOPE = { ownerId: "user-a", budgetId: BUDGET } satisfies ImportJobStorageScope;
const IMAGE = "data:image/png;base64,cHJpdmF0ZS1zY3JlZW5zaG90";
const EXTRACTION: ImportRecognitionResult = { rows: [], proposals: [] };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const ledger = (): ClientLedger => ({
  budgets: [{ id: BUDGET, name: "Budget", currency: "EUR", preferences: { ...createDefaultBudgetPreferences(), aiProvider: "openai" } }],
  accounts: [
    {
      id: ACCOUNT,
      name: "Checking",
      color: "#000000",
      icon: "wallet",
      type: "checking",
      onBudget: true,
      initialBalance: 0,
      archived: false,
      sort: 0,
      automaticEnvelopeId: null,
    },
  ],
  groups: [],
  envelopes: [],
  categories: [],
  places: [],
  transactions: [],
  allocations: [],
});

type DurableInput = Parameters<E2eeImportJobExecutionProvider["runDurableImport"]>[0];

function provider(run: (input: DurableInput) => Promise<void>): E2eeImportJobExecutionProvider {
  return {
    async runDurableImport(input) {
      await run(input);
      return EXTRACTION;
    },
  };
}

function setup(
  overrides: Partial<E2eeImportJobRunnerOptions> & {
    key?: Uint8Array;
    unlocked?: () => boolean;
    online?: () => boolean;
    tier?: () => { tier: "plain" | "e2ee"; epoch: number };
  } = {},
) {
  const key = overrides.key ?? generateDek();
  const isUnlocked = overrides.unlocked ?? (() => true);
  const options: E2eeImportJobRunnerOptions = {
    scope: SCOPE,
    activity: createImportActivityStore(),
    ledger,
    tierMeta: overrides.tier ?? (() => ({ tier: "e2ee", epoch: 3 })),
    requireDek: (epoch) => {
      if (epoch !== 3 || !isUnlocked()) throw new Error("locked");
      return key.slice();
    },
    online: overrides.online ?? (() => true),
    visible: () => true,
    canRun: () => true,
    provider: overrides.provider ?? (() => provider(async (input) => input.lifecycle.saveResult?.(EXTRACTION))),
    now: overrides.now ?? (() => new Date("2026-08-24T10:00:00.000Z")),
    ...overrides,
  };
  return { runner: new E2eeImportJobRunner(options), key, activity: options.activity };
}

const createInput = () => ({
  id: ID,
  accountId: ACCOUNT,
  locale: "en-US",
  images: [IMAGE],
  provider: { provider: "openai" as const, model: "gpt-5.6-luna" as const },
});

beforeEach(() => {
  (globalThis as Record<string, unknown>).indexedDB = new IDBFactory();
  (globalThis as Record<string, unknown>).localStorage = { getItem: () => "persistent" };
  __resetStorageForTests();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).indexedDB;
  delete (globalThis as Record<string, unknown>).localStorage;
  __resetStorageForTests();
});

describe("device-local E2EE import runner", () => {
  it("completes locally with counts and removes encrypted detail without any server boundary", async () => {
    // given: Own OpenAI recognition produced a ready device-local result
    const { runner, activity } = setup();
    await runner.create(createInput());
    await runner.resume();
    expect(await importJobStorage.getJob(SCOPE, ID)).toMatchObject({ status: "ready", resultCiphertext: expect.stringMatching(/^v2\./) });

    // when: every reviewed row has been applied or explicitly skipped
    await runner.complete(ID, { appliedCount: 1, skippedCount: 2 });

    // then: only the encrypted local record changes and retained activity contains counts, not result detail
    expect(await importJobStorage.getJob(SCOPE, ID)).toMatchObject({
      status: "completed",
      phase: "completed",
      resultCiphertext: null,
      checkpointCiphertext: null,
      inputCiphertext: null,
      appliedCount: 1,
      skippedCount: 2,
    });
    expect(activity.get(ID)).toMatchObject({ status: "completed", result: null, appliedCount: 1, skippedCount: 2 });
  });

  it("starts seven-day retention when a delayed result becomes ready", async () => {
    let currentTime = new Date("2026-08-20T10:00:00.000Z");
    const fixture = setup({ now: () => currentTime });
    await fixture.runner.create(createInput());
    currentTime = new Date("2026-08-24T10:00:00.000Z");

    await fixture.runner.resume();

    expect(await importJobStorage.getJob(SCOPE, ID)).toMatchObject({
      status: "ready",
      updatedAt: "2026-08-24T10:00:00.000Z",
      expiresAt: "2026-08-31T10:00:00.000Z",
    });
  });

  it("deletes encrypted screenshots as soon as extraction is durably checkpointed", async () => {
    const fixture = setup({
      provider: () =>
        provider(async (input) => {
          await input.lifecycle.saveExtraction?.(EXTRACTION);
        }),
    });
    await fixture.runner.create(createInput());

    await fixture.runner.resume();

    expect(await importJobStorage.getJob(SCOPE, ID)).toMatchObject({
      phase: "validating",
      inputCiphertext: null,
      checkpointCiphertext: expect.stringMatching(/^v2\./),
    });
  });

  it("deletes every encrypted payload immediately when cancellation becomes durable", async () => {
    const fixture = setup();
    await fixture.runner.create(createInput());

    await fixture.runner.cancel(ID);

    expect(await importJobStorage.getJob(SCOPE, ID)).toMatchObject({
      status: "cancelled",
      inputCiphertext: null,
      checkpointCiphertext: null,
      resultCiphertext: null,
    });
  });

  it("deletes every encrypted payload immediately after a permanent provider failure", async () => {
    const fixture = setup({
      provider: () =>
        provider(async () => {
          throw new Error("ai_key_invalid");
        }),
    });
    await fixture.runner.create(createInput());

    await fixture.runner.resume();

    expect(await importJobStorage.getJob(SCOPE, ID)).toMatchObject({
      status: "failed",
      errorCode: "ai_key_invalid",
      retryAt: null,
      inputCiphertext: null,
      checkpointCiphertext: null,
      resultCiphertext: null,
    });
  });

  it("treats an explicit budget mismatch as permanent and deletes ciphertext", async () => {
    const fixture = setup({
      provider: () =>
        provider(async () => {
          throw new Error("budget_mismatch");
        }),
    });
    await fixture.runner.create(createInput());

    await fixture.runner.resume();

    expect(await importJobStorage.getJob(SCOPE, ID)).toMatchObject({
      status: "failed",
      errorCode: "budget_mismatch",
      retryAt: null,
      inputCiphertext: null,
      checkpointCiphertext: null,
      resultCiphertext: null,
    });
  });

  it("recovers a stale running job through waiting_for_device and resumes from its encrypted extraction checkpoint", async () => {
    let unblockFirst: (() => void) | undefined;
    const firstStopped = new Promise<void>((resolve) => {
      unblockFirst = resolve;
    });
    let extractionRuns = 0;
    const first = setup({
      provider: () =>
        provider(async (input) => {
          extractionRuns++;
          await input.lifecycle.saveExtraction?.(EXTRACTION);
          await firstStopped;
        }),
    });
    await first.runner.create(createInput());
    void first.runner.resume();
    while ((await importJobStorage.getJob(SCOPE, ID))?.checkpointCiphertext === null) await Promise.resolve();

    let unlocked = false;
    const phases: string[] = [];
    const unsubscribe = importJobStorage.subscribe(SCOPE, async () => {
      const current = await importJobStorage.getJob(SCOPE, ID);
      if (current) phases.push(current.phase);
    });
    const second = setup({
      key: first.key,
      unlocked: () => unlocked,
      provider: () =>
        provider(async (input) => {
          expect(input.checkpoint).toEqual(EXTRACTION);
          await input.lifecycle.advancePhase?.("enriching");
          await input.lifecycle.advancePhase?.("reconciling");
          await input.lifecycle.saveResult?.(EXTRACTION);
        }),
    });

    await second.runner.resume();
    expect((await importJobStorage.getJob(SCOPE, ID))?.phase).toBe("waiting_for_unlock");
    expect(phases).toContain("waiting_for_device");

    unlocked = true;
    await second.runner.resume();
    unsubscribe();
    unblockFirst?.();

    expect(extractionRuns).toBe(1);
    expect(await importJobStorage.getJob(SCOPE, ID)).toMatchObject({ status: "ready", phase: "ready", checkpointCiphertext: expect.stringMatching(/^v2\./) });
  });

  it("persists waiting_for_network and waiting_for_unlock without starting the provider", async () => {
    let online = false;
    let unlocked = true;
    let providerRuns = 0;
    const fixture = setup({
      online: () => online,
      unlocked: () => unlocked,
      provider: () =>
        provider(async () => {
          providerRuns++;
        }),
    });
    await fixture.runner.create(createInput());

    await fixture.runner.resume();
    expect((await importJobStorage.getJob(SCOPE, ID))?.phase).toBe("waiting_for_network");
    online = true;
    unlocked = false;
    await fixture.runner.resume();

    expect((await importJobStorage.getJob(SCOPE, ID))?.phase).toBe("waiting_for_unlock");
    expect(providerRuns).toBe(0);
  });

  it("uses the worker retry schedule for strict upstream failures and stops after three attempts", async () => {
    let currentTime = new Date("2026-08-24T10:00:00.000Z");
    let providerRuns = 0;
    const fixture = setup({
      now: () => currentTime,
      provider: () =>
        provider(async () => {
          providerRuns++;
          throw new Error("ai_timeout");
        }),
    });
    await fixture.runner.create(createInput());

    await fixture.runner.resume();
    expect(await importJobStorage.getJob(SCOPE, ID)).toMatchObject({
      status: "failed",
      phase: "retry_scheduled",
      attempt: 1,
      errorCode: "ai_timeout",
      retryAt: "2026-08-24T10:00:30.000Z",
    });

    currentTime = new Date("2026-08-24T10:00:29.000Z");
    await fixture.runner.resume();
    expect(providerRuns).toBe(1);

    currentTime = new Date("2026-08-24T10:00:30.000Z");
    await fixture.runner.resume();
    expect(await importJobStorage.getJob(SCOPE, ID)).toMatchObject({
      status: "failed",
      phase: "retry_scheduled",
      attempt: 2,
      errorCode: "ai_timeout",
      retryAt: "2026-08-24T10:02:30.000Z",
    });

    currentTime = new Date("2026-08-24T10:02:30.000Z");
    await fixture.runner.resume();
    expect(await importJobStorage.getJob(SCOPE, ID)).toMatchObject({ status: "failed", attempt: 3, errorCode: "ai_timeout", retryAt: null });
    expect(providerRuns).toBe(3);
  });

  it("retains retryable encrypted input before 24 hours and expires it at the exact boundary", async () => {
    const startedAt = Date.parse("2026-08-24T10:00:00.000Z");
    let currentTime = new Date(startedAt);
    let providerRuns = 0;
    const fixture = setup({
      now: () => currentTime,
      provider: () =>
        provider(async () => {
          providerRuns++;
          throw new Error("ai_timeout");
        }),
    });
    await fixture.runner.create(createInput());
    await fixture.runner.resume();

    currentTime = new Date(startedAt + 24 * 60 * 60 * 1000 - 1);
    await fixture.runner.list();
    expect(await importJobStorage.getJob(SCOPE, ID)).toMatchObject({ inputCiphertext: expect.stringMatching(/^v2\./) });

    currentTime = new Date(startedAt + 24 * 60 * 60 * 1000);
    await fixture.runner.list();
    expect(await importJobStorage.getJob(SCOPE, ID)).toMatchObject({
      status: "failed",
      errorCode: "expired",
      retryAt: null,
      inputCiphertext: null,
      checkpointCiphertext: null,
      resultCiphertext: null,
    });
    expect(providerRuns).toBe(1);
  });

  it("keeps a retryable extraction checkpoint after 24 hours because screenshots were already deleted", async () => {
    const startedAt = Date.parse("2026-08-24T10:00:00.000Z");
    let currentTime = new Date(startedAt);
    const fixture = setup({
      now: () => currentTime,
      provider: () =>
        provider(async (input) => {
          await input.lifecycle.saveExtraction?.(EXTRACTION);
          throw new Error("ai_timeout");
        }),
    });
    await fixture.runner.create(createInput());
    await fixture.runner.resume();

    currentTime = new Date(startedAt + 24 * 60 * 60 * 1000);
    await fixture.runner.list();

    expect(await importJobStorage.getJob(SCOPE, ID)).toMatchObject({
      status: "failed",
      errorCode: "ai_timeout",
      retryAt: "2026-08-24T10:00:30.000Z",
      inputCiphertext: null,
      checkpointCiphertext: expect.stringMatching(/^v2\./),
    });
  });

  it("expires ciphertext and apply progress before provider resume and evicts absent activity in every tab", async () => {
    // given: two tabs have observed the same local encrypted job and its apply metadata
    let currentTime = new Date("2026-08-24T10:00:00.000Z");
    let providerRuns = 0;
    const first = setup({
      now: () => currentTime,
      provider: () =>
        provider(async () => {
          providerRuns++;
        }),
    });
    await first.runner.create(createInput());
    const peer = setup({ key: first.key, now: () => currentTime, canRun: () => false });
    await peer.runner.list();
    await importJobStorage.putApplyProgress(SCOPE, ID, { appliedRowIds: ["h1.opaque-row"], skippedRowIds: [] });
    expect(first.activity.get(ID)).toBeDefined();
    expect(peer.activity.get(ID)).toBeDefined();

    // when: retention expires and each tab reconciles its view with durable storage
    currentTime = new Date("2026-08-31T10:00:00.000Z");
    await first.runner.resume();
    await peer.runner.list();

    // then: expiry wins before decrypt/provider and removes every local recovery artifact
    expect(providerRuns).toBe(0);
    expect(await importJobStorage.getJob(SCOPE, ID)).toBeUndefined();
    expect(await importJobStorage.getApplyProgress(SCOPE, ID)).toEqual({ appliedRowIds: [], appliedCount: 0, skippedRowIds: [], skippedCount: 0 });
    expect(first.activity.get(ID)).toBeUndefined();
    expect(peer.activity.get(ID)).toBeUndefined();
  });

  it("does not let a revoked runner delete an expired job", async () => {
    let current = true;
    let currentTime = new Date("2026-08-24T10:00:00.000Z");
    const fixture = setup({ capability: { isCurrent: () => current }, now: () => currentTime });
    await fixture.runner.create(createInput());

    current = false;
    currentTime = new Date("2026-08-31T10:00:00.000Z");
    await fixture.runner.resume();

    expect(await importJobStorage.getJob(SCOPE, ID)).toBeDefined();
  });

  it("blocks a stale generation before decrypting input or contacting a provider", async () => {
    let epoch = 3;
    let decryptions = 0;
    let providerRuns = 0;
    const fixture = setup({
      tier: () => ({ tier: "e2ee", epoch }),
      decrypt: async () => {
        decryptions++;
        return JSON.stringify({ images: [IMAGE] });
      },
      provider: () =>
        provider(async () => {
          providerRuns++;
        }),
    });
    await fixture.runner.create(createInput());
    decryptions = 0;
    epoch = 4;

    await fixture.runner.resume();

    expect(await importJobStorage.getJob(SCOPE, ID)).toMatchObject({ status: "failed", errorCode: "tier_mismatch" });
    expect(decryptions).toBe(0);
    expect(providerRuns).toBe(0);
  });

  it("keeps the provider/model snapshot immutable when live preferences change", async () => {
    const currentLedger = ledger();
    const models: string[] = [];
    const fixture = setup({
      ledger: () => currentLedger,
      provider: (snapshot) => {
        models.push(snapshot.model);
        return provider(async (input) => input.lifecycle.saveResult?.(EXTRACTION));
      },
    });
    await fixture.runner.create(createInput());
    currentLedger.budgets[0]!.preferences.aiProvider = "enveo";
    currentLedger.budgets[0]!.preferences.openaiModel = "gpt-5.6-sol";

    await fixture.runner.resume();

    expect(models).toEqual(["gpt-5.6-luna"]);
    expect((await importJobStorage.getJob(SCOPE, ID))?.provider).toEqual({ provider: "openai", model: "gpt-5.6-luna" });
  });

  it("uses the memory-session backend without opening IndexedDB", async () => {
    const factory = new IDBFactory();
    (globalThis as Record<string, unknown>).indexedDB = factory;
    (globalThis as Record<string, unknown>).localStorage = { getItem: () => "session" };
    __resetStorageForTests();
    const fixture = setup();

    await fixture.runner.create(createInput());

    expect(storageMode()).toBe("memory-session");
    expect(await factory.databases()).toEqual([]);
  });

  it("keeps a non-leader tab read-only while another tab owns execution", async () => {
    const fixture = setup({ canRun: () => false });
    await fixture.runner.create(createInput());

    await fixture.runner.resume();

    expect(await importJobStorage.getJob(SCOPE, ID)).toMatchObject({ status: "queued", phase: "queued", checkpointRevision: 0 });
  });

  it("does not let a stale duplicate runner overwrite the winning CAS checkpoint", async () => {
    let releaseFirst: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let providerRuns = 0;
    const key = generateDek();
    const first = setup({
      key,
      provider: () =>
        provider(async (input) => {
          providerRuns++;
          markStarted?.();
          await firstBlocked;
          await input.lifecycle.saveResult?.(EXTRACTION);
        }),
    }).runner;
    const second = setup({
      key,
      provider: () =>
        provider(async (input) => {
          providerRuns++;
          await input.lifecycle.saveResult?.(EXTRACTION);
        }),
    }).runner;
    await first.create(createInput());

    const firstRun = first.resume();
    await firstStarted;
    await second.resume();
    const winner = await importJobStorage.getJob(SCOPE, ID);
    releaseFirst?.();
    await firstRun;

    expect(providerRuns).toBe(2);
    expect(await importJobStorage.getJob(SCOPE, ID)).toEqual(winner);
    expect(winner).toMatchObject({ status: "ready", phase: "ready" });
  });

  it("does not persist or publish provider completion after the runner is stopped", async () => {
    const release = deferred<void>();
    const providerStarted = deferred<void>();
    const fixture = setup({
      provider: () =>
        provider(async (input) => {
          providerStarted.resolve();
          await release.promise;
          await input.lifecycle.saveResult?.(EXTRACTION);
        }),
    });
    await fixture.runner.create(createInput());
    const run = fixture.runner.resume();
    await providerStarted.promise;

    const stop = (fixture.runner as E2eeImportJobRunner & { stop?: () => void }).stop;
    if (!stop) {
      release.resolve();
      await run;
      expect(stop).toBeFunction();
      return;
    }
    stop.call(fixture.runner);
    fixture.activity.clear();
    release.resolve();
    await run;

    expect(fixture.activity.list()).toEqual([]);
    expect(await importJobStorage.getJob(SCOPE, ID)).toMatchObject({ status: "running", phase: "extracting" });
  });

  it("does not persist or publish provider completion after its manager scope is revoked", async () => {
    const release = deferred<void>();
    const providerStarted = deferred<void>();
    let current = true;
    const fixture = setup({
      capability: { isCurrent: () => current },
      provider: () =>
        provider(async (input) => {
          providerStarted.resolve();
          await release.promise;
          await input.lifecycle.saveResult?.(EXTRACTION);
        }),
    });
    await fixture.runner.create(createInput());
    const run = fixture.runner.resume();
    await providerStarted.promise;

    current = false;
    fixture.activity.clear();
    release.resolve();
    await run;

    expect(fixture.activity.list()).toEqual([]);
    expect(await importJobStorage.getJob(SCOPE, ID)).toMatchObject({ status: "running", phase: "extracting" });
  });
});
