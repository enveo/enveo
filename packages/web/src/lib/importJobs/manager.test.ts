import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type ClientLedger, createDefaultBudgetPreferences } from "@enveo/shared";
import { IDBFactory } from "fake-indexeddb";
import { __resetStorageForTests } from "../idb";
import { type ImportJobStorageScope, importJobStorage } from "../importJobStorage";
import { ImportJobManager, type ImportJobManagerE2eePort, type ImportJobManagerPlainPort, type ImportJobManagerState } from "./manager";
import type { ImportActivityItem, ImportActivityStore, ImportJobScopeCapability } from "./store";

const BUDGET = "22222222-2222-2222-2222-222222222222";
const ACCOUNT = "33333333-3333-3333-3333-333333333333";
const ID = "11111111-1111-1111-1111-111111111111";
const OTHER_BUDGET = "44444444-4444-4444-4444-444444444444";
const OTHER_ID = "55555555-5555-5555-5555-555555555555";
const TXN_ID = "66666666-6666-4666-8666-666666666666";
const IMAGE = "data:image/png;base64,AA==";

function ledger(provider: "rules" | "enveo" | "openai" = "openai", model = "gpt-5.6-luna", budgetId = BUDGET): ClientLedger {
  return {
    budgets: [
      {
        id: budgetId,
        name: "Budget",
        currency: "EUR",
        preferences: { ...createDefaultBudgetPreferences(), aiProvider: provider, openaiModel: model as "gpt-5.6-luna" },
      },
    ],
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
  };
}

function item(source: "plain" | "e2ee" = "plain"): ImportActivityItem {
  return {
    id: ID,
    budgetId: BUDGET,
    accountId: ACCOUNT,
    provider: { provider: "openai", model: "gpt-5.6-luna" },
    locale: "en-US",
    tier: source === "e2ee" ? "e2ee" : "plain",
    epoch: source === "e2ee" ? 3 : 0,
    source,
    status: "queued",
    phase: "queued",
    resumePhase: null,
    cancelRequested: false,
    attempt: 0,
    errorCode: null,
    retryAt: null,
    result: null,
    proposalCount: 0,
    appliedCount: 0,
    skippedCount: 0,
    createdAt: "2026-08-24T10:00:00.000Z",
    updatedAt: "2026-08-24T10:00:00.000Z",
    expiresAt: "2026-08-31T10:00:00.000Z",
  };
}

class FakeState implements ImportJobManagerState {
  status: ReturnType<ImportJobManagerState["getBootStatus"]> = "booting";
  budgetId: string | null = BUDGET;
  currentLedger: ClientLedger | null = ledger();
  listeners = new Set<() => void>();
  getBootStatus = () => this.status;
  getBudgetId = () => this.budgetId;
  getLedger = () => this.currentLedger;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  set(status: typeof this.status) {
    this.status = status;
    this.notify();
  }
  notify() {
    for (const listener of this.listeners) listener();
  }
}

function ports(calls: string[]) {
  const plain = (_scope: ImportJobStorageScope, activity: ImportActivityStore, _capability?: ImportJobScopeCapability): ImportJobManagerPlainPort => ({
    start: () => calls.push("plain.start"),
    stop: () => calls.push("plain.stop"),
    create: async () => {
      calls.push("plain.create");
      const value = item("plain");
      activity.upsert(value);
      return value;
    },
    refresh: async () => void calls.push("plain.refresh"),
    cancel: async () => void calls.push("plain.cancel"),
    retry: async () => void calls.push("plain.retry"),
    complete: async () => void calls.push("plain.complete"),
    dismiss: () => calls.push("plain.dismiss"),
  });
  const e2ee = (_scope: ImportJobStorageScope, activity: ImportActivityStore): ImportJobManagerE2eePort => ({
    stop: () => calls.push("e2ee.stop"),
    create: async () => {
      calls.push("e2ee.create");
      const value = item("e2ee");
      activity.upsert(value);
      return value;
    },
    resume: async () => void calls.push("e2ee.resume"),
    list: async () => [],
    cancel: async () => void calls.push("e2ee.cancel"),
    retry: async () => void calls.push("e2ee.retry"),
    complete: async () => void calls.push("e2ee.complete"),
    dismiss: async () => void calls.push("e2ee.dismiss"),
  });
  return { plain, e2ee };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushMicrotasks(count = 12): Promise<void> {
  for (let index = 0; index < count; index++) await Promise.resolve();
}

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

describe("import job manager", () => {
  it("retains exact applied and skipped identities across a manager reload and clears them only after completion", async () => {
    // given: a ready job remains owned by the active manager scope
    const state = new FakeState();
    state.status = "ready";
    const manager = new ImportJobManager({
      state,
      ownerId: async () => "user-a",
      tierMeta: () => ({ tier: "plain", epoch: 0 }),
      ...(() => {
        const adapters = ports([]);
        return { createPlain: adapters.plain, createE2ee: adapters.e2ee };
      })(),
      randomId: () => ID,
      visible: () => true,
    });
    manager.start();
    await manager.create({ accountId: ACCOUNT, locale: "en-US", images: [IMAGE] });

    // when: two interrupted attempts report an overlapping applied row
    await manager.recordApplied(ID, ["row-one"]);
    await manager.recordApplied(ID, ["row-one", "row-two"]);
    await manager.recordSkipped(ID, ["row-three"]);

    // then: a newly constructed manager receives stable distinct identities/counts from storage
    manager.stop();
    const restarted = new ImportJobManager({
      state,
      ownerId: async () => "user-a",
      tierMeta: () => ({ tier: "plain", epoch: 0 }),
      ...(() => {
        const adapters = ports([]);
        return { createPlain: adapters.plain, createE2ee: adapters.e2ee };
      })(),
      randomId: () => ID,
      visible: () => true,
    });
    restarted.start();
    await restarted.create({ accountId: ACCOUNT, locale: "en-US", images: [IMAGE] });
    expect(await restarted.appliedProgress(ID)).toEqual({
      appliedRowIds: ["row-one", "row-two"],
      appliedCount: 2,
      skippedRowIds: ["row-three"],
      skippedCount: 1,
    });
    expect(await importJobStorage.getApplyProgress({ ownerId: "user-a", budgetId: BUDGET }, ID)).toEqual({
      appliedRowIds: ["row-one", "row-two"],
      appliedCount: 2,
      skippedRowIds: ["row-three"],
      skippedCount: 1,
    });

    // and: successful completion ends the recovery record
    await restarted.complete(ID, { appliedCount: 2, skippedCount: 1 });
    expect(await restarted.appliedProgress(ID)).toEqual({ appliedRowIds: [], appliedCount: 0, skippedRowIds: [], skippedCount: 0 });
    expect(await importJobStorage.getApplyProgress({ ownerId: "user-a", budgetId: BUDGET }, ID)).toEqual({
      appliedRowIds: [],
      appliedCount: 0,
      skippedRowIds: [],
      skippedCount: 0,
    });
    restarted.stop();
  });

  it("routes completion counts to the job's owning plain or encrypted adapter", async () => {
    // given: the active replica has one job in the merged activity view
    for (const tier of ["plain", "e2ee"] as const) {
      const state = new FakeState();
      state.status = "ready";
      const calls: string[] = [];
      const adapters = ports(calls);
      const manager = new ImportJobManager({
        state,
        ownerId: async () => "user-a",
        tierMeta: () => ({ tier, epoch: tier === "e2ee" ? 3 : 0 }),
        createPlain: adapters.plain,
        createE2ee: adapters.e2ee,
        randomId: () => ID,
        visible: () => true,
      });
      manager.start();
      await manager.create({ accountId: ACCOUNT, locale: "en-US", images: [IMAGE] });

      // when: the UI accounts for every selected or skipped proposal
      await manager.complete(ID, { appliedCount: 1, skippedCount: 2 });

      // then: only the adapter that owns the job receives completion
      expect(calls).toContain(`${tier}.complete`);
      expect(calls).not.toContain(`${tier === "plain" ? "e2ee" : "plain"}.complete`);
      manager.stop();
    }
  });

  it("recovers the transaction/progress interruption boundary by durable transaction identity", async () => {
    // given: a blank-source row receives a durable transaction id before local mutation
    const state = new FakeState();
    state.status = "ready";
    const ids = [ID, TXN_ID];
    const adapters = ports([]);
    const manager = new ImportJobManager({
      state,
      ownerId: async () => "user-a",
      tierMeta: () => ({ tier: "plain", epoch: 0 }),
      createPlain: adapters.plain,
      createE2ee: adapters.e2ee,
      randomId: () => ids.shift()!,
      visible: () => true,
    });
    manager.start();
    await manager.create({ accountId: ACCOUNT, locale: "en-US", images: [IMAGE] });
    expect(await manager.prepareAppliedRow(ID, "blank-row")).toBe(TXN_ID);

    // when: the transaction becomes durable but the final applied-progress write is interrupted
    state.currentLedger!.transactions.push({
      id: TXN_ID,
      type: "expense",
      accountId: ACCOUNT,
      toAccountId: null,
      amount: 1200,
      date: "2026-08-24",
      isRefund: false,
      envelopeId: null,
      placeId: null,
      categoryId: null,
      name: "Blank source",
      note: null,
      tag: null,
      sourceRef: null,
      allocationFromEnvelopeId: null,
      allocationToEnvelopeId: null,
      items: [],
      createdAt: "2026-08-24T10:00:00.000Z",
    });
    manager.stop();
    const restarted = new ImportJobManager({
      state,
      ownerId: async () => "user-a",
      tierMeta: () => ({ tier: "plain", epoch: 0 }),
      createPlain: adapters.plain,
      createE2ee: adapters.e2ee,
      randomId: () => ID,
      visible: () => true,
    });
    restarted.start();
    await restarted.create({ accountId: ACCOUNT, locale: "en-US", images: [IMAGE] });

    // then: reload promotes the prepared row to applied without source_ref evidence
    expect(await restarted.appliedProgress(ID)).toMatchObject({ appliedRowIds: ["blank-row"], appliedCount: 1 });
    restarted.stop();
  });

  it("starts once but does not derive a scope or resume jobs until replica boot is ready", async () => {
    const state = new FakeState();
    const calls: string[] = [];
    const adapters = ports(calls);
    let ownerReads = 0;
    const manager = new ImportJobManager({
      state,
      ownerId: async () => {
        ownerReads++;
        return "user-a";
      },
      tierMeta: () => ({ tier: "e2ee", epoch: 3 }),
      createPlain: adapters.plain,
      createE2ee: adapters.e2ee,
      visible: () => true,
      scheduleInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearScheduledInterval: () => {},
    });

    manager.start();
    manager.start();
    await manager.resume();
    expect(ownerReads).toBe(0);
    expect(calls).toEqual([]);

    state.set("ready");
    await manager.resume();

    expect(ownerReads).toBeGreaterThan(0);
    expect(calls).not.toContain("plain.start");
    expect(calls).toContain("e2ee.resume");
    manager.stop();
  });

  it("routes creation by current tier and snapshots the E2EE Own OpenAI model", async () => {
    const state = new FakeState();
    state.status = "ready";
    const calls: string[] = [];
    const adapters = ports(calls);
    let capturedModel = "";
    const manager = new ImportJobManager({
      state,
      ownerId: async () => "user-a",
      tierMeta: () => ({ tier: "e2ee", epoch: 3 }),
      createPlain: adapters.plain,
      createE2ee: (scope, activity) => ({
        ...adapters.e2ee(scope, activity),
        create: async (input) => {
          capturedModel = input.provider.model;
          return item("e2ee");
        },
      }),
      randomId: () => ID,
      visible: () => true,
    });
    manager.start();

    await manager.create({ accountId: ACCOUNT, locale: "en-US", images: ["data:image/png;base64,AA=="] });

    expect(capturedModel).toBe("gpt-5.6-luna");
    expect(calls).not.toContain("plain.create");
    manager.stop();
  });

  it("periodically wakes local execution without polling an idle server queue", async () => {
    const state = new FakeState();
    state.status = "ready";
    const calls: string[] = [];
    const adapters = ports(calls);
    let interval: (() => void) | undefined;
    const manager = new ImportJobManager({
      state,
      ownerId: async () => "user-a",
      tierMeta: () => ({ tier: "e2ee", epoch: 3 }),
      createPlain: adapters.plain,
      createE2ee: adapters.e2ee,
      visible: () => true,
      scheduleInterval: (callback) => {
        interval = callback;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearScheduledInterval: () => {},
    });
    manager.start();
    await manager.resume();
    const plainRefreshes = calls.filter((call) => call === "plain.refresh").length;
    const localResumes = calls.filter((call) => call === "e2ee.resume").length;

    interval?.();
    while (calls.filter((call) => call === "e2ee.resume").length === localResumes) await Promise.resolve();

    expect(calls.filter((call) => call === "plain.refresh")).toHaveLength(plainRefreshes);
    manager.stop();
  });

  it("cleans up state, browser, and polling listeners on stop", async () => {
    const state = new FakeState();
    state.status = "ready";
    const calls: string[] = [];
    const adapters = ports(calls);
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    let interval: (() => void) | undefined;
    const manager = new ImportJobManager({
      state,
      ownerId: async () => "user-a",
      tierMeta: () => ({ tier: "e2ee", epoch: 3 }),
      createPlain: adapters.plain,
      createE2ee: adapters.e2ee,
      visible: () => true,
      windowTarget,
      documentTarget,
      scheduleInterval: (callback) => {
        interval = callback;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearScheduledInterval: () => void calls.push("timer.clear"),
    });
    manager.start();
    await manager.resume();
    const resumesBeforeStop = calls.filter((call) => call === "e2ee.resume").length;

    manager.stop();
    windowTarget.dispatchEvent(new Event("online"));
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    interval?.();
    await Promise.resolve();

    expect(state.listeners.size).toBe(0);
    expect(calls).toContain("e2ee.stop");
    expect(calls).toContain("timer.clear");
    expect(calls.filter((call) => call === "e2ee.resume")).toHaveLength(resumesBeforeStop);
  });

  it("does not refresh an idle plain import queue for an ordinary ledger bump", async () => {
    const state = new FakeState();
    state.status = "ready";
    const calls: string[] = [];
    const adapters = ports(calls);
    const manager = new ImportJobManager({
      state,
      ownerId: async () => "user-a",
      tierMeta: () => ({ tier: "plain", epoch: 0 }),
      createPlain: adapters.plain,
      createE2ee: adapters.e2ee,
      visible: () => true,
    });
    manager.start();
    await manager.resume();
    const refreshes = calls.filter((call) => call === "plain.refresh").length;

    state.currentLedger = { ...state.currentLedger!, transactions: [] };
    state.notify();
    await flushMicrotasks();

    expect(calls.filter((call) => call === "plain.refresh")).toHaveLength(refreshes);
    manager.stop();
  });

  it("deletes an incompatible plain draft without constructing a plain adapter or uploading images", async () => {
    await importJobStorage.createDraft(
      { ownerId: "user-a", budgetId: BUDGET },
      { id: ID, ownerId: "user-a", budgetId: BUDGET, accountId: ACCOUNT, locale: "en-US", images: [IMAGE] },
    );
    const state = new FakeState();
    state.status = "ready";
    let plainFactories = 0;
    const calls: string[] = [];
    const adapters = ports(calls);
    const manager = new ImportJobManager({
      state,
      ownerId: async () => "user-a",
      tierMeta: () => ({ tier: "e2ee", epoch: 3 }),
      createPlain: (...args) => {
        plainFactories++;
        return adapters.plain(...args);
      },
      createE2ee: adapters.e2ee,
      visible: () => true,
    });

    manager.start();
    await manager.resume();

    expect(plainFactories).toBe(0);
    expect(await importJobStorage.getDraft({ ownerId: "user-a", budgetId: BUDGET }, ID)).toBeUndefined();
    manager.stop();
  });

  it("revokes scope A before a delayed adapter completion can publish into scope B", async () => {
    const state = new FakeState();
    state.status = "ready";
    const scopes: string[] = [];
    const capabilities = new Map<string, ImportJobScopeCapability | undefined>();
    let sharedActivity: ImportActivityStore | undefined;
    const seen: Array<string | undefined> = [];
    const manager = new ImportJobManager({
      state,
      ownerId: async () => "user-a",
      tierMeta: () => ({ tier: "plain", epoch: 0 }),
      createPlain: (scope, activity, capability?: ImportJobScopeCapability) => {
        scopes.push(scope.budgetId);
        capabilities.set(scope.budgetId, capability);
        sharedActivity = activity;
        return {
          start: () => {},
          stop: () => {},
          create: async () => item("plain"),
          refresh: async () => {},
          cancel: async () => {},
          retry: async () => {},
          complete: async () => {},
          dismiss: () => {},
        };
      },
      createE2ee: () => {
        throw new Error("unexpected_e2ee_factory");
      },
      visible: () => true,
    });
    manager.observe(OTHER_ID, (value) => seen.push(value?.budgetId));
    manager.start();
    await manager.resume();

    state.budgetId = OTHER_BUDGET;
    state.currentLedger = ledger("openai", "gpt-5.6-luna", OTHER_BUDGET);
    state.notify();
    await manager.resume();
    if (capabilities.get(BUDGET)?.isCurrent() ?? true) {
      sharedActivity?.upsert({ ...item("plain"), id: OTHER_ID, budgetId: BUDGET });
    }

    expect(scopes).toContain(OTHER_BUDGET);
    expect(seen).toEqual([undefined]);
    manager.stop();
  });

  it("does not construct an adapter when stopped during deferred owner resolution", async () => {
    const state = new FakeState();
    state.status = "ready";
    const owner = deferred<string | null>();
    let ownerStarted = false;
    let factories = 0;
    let clearedTimers = 0;
    const manager = new ImportJobManager({
      state,
      ownerId: () => {
        ownerStarted = true;
        return owner.promise;
      },
      tierMeta: () => ({ tier: "plain", epoch: 0 }),
      createPlain: () => {
        factories++;
        throw new Error("stale_factory");
      },
      createE2ee: () => {
        factories++;
        throw new Error("stale_factory");
      },
      scheduleInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearScheduledInterval: () => clearedTimers++,
    });
    manager.start();
    await flushMicrotasks();
    expect(ownerStarted).toBe(true);

    manager.stop();
    owner.resolve("user-a");
    await Promise.resolve();
    await Promise.resolve();

    expect(factories).toBe(0);
    expect(clearedTimers).toBe(1);
  });

  it("restarts activation for the new scope when the budget changes during owner resolution", async () => {
    const state = new FakeState();
    state.status = "ready";
    const owners = [deferred<string | null>(), deferred<string | null>()];
    let reads = 0;
    const scopes: string[] = [];
    const manager = new ImportJobManager({
      state,
      ownerId: () => owners[reads++]!.promise,
      tierMeta: () => ({ tier: "plain", epoch: 0 }),
      createPlain: (scope) => {
        scopes.push(scope.budgetId);
        return {
          start: () => {},
          stop: () => {},
          create: async () => item("plain"),
          refresh: async () => {},
          cancel: async () => {},
          retry: async () => {},
          complete: async () => {},
          dismiss: () => {},
        };
      },
      createE2ee: () => {
        throw new Error("unexpected_e2ee_factory");
      },
      visible: () => true,
    });
    manager.start();
    await flushMicrotasks();
    expect(reads).toBe(1);

    state.budgetId = OTHER_BUDGET;
    state.currentLedger = ledger("openai", "gpt-5.6-luna", OTHER_BUDGET);
    state.notify();
    owners[0]!.resolve("user-a");
    await flushMicrotasks();
    owners[1]!.resolve("user-a");
    await flushMicrotasks();

    expect(reads).toBe(2);
    expect(scopes).toEqual([OTHER_BUDGET]);
    manager.stop();
  });
});
