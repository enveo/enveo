import { describe, expect, it } from "bun:test";
import { type ClientLedger, createDefaultBudgetPreferences } from "@enveo/shared";
import type { ImportJobStorageScope } from "../importJobStorage";
import { ImportJobManager, type ImportJobManagerE2eePort, type ImportJobManagerPlainPort, type ImportJobManagerState } from "./manager";
import type { ImportActivityItem, ImportActivityStore } from "./store";

const BUDGET = "22222222-2222-2222-2222-222222222222";
const ACCOUNT = "33333333-3333-3333-3333-333333333333";
const ID = "11111111-1111-1111-1111-111111111111";

function ledger(provider: "rules" | "enveo" | "openai" = "openai", model = "gpt-5.6-luna"): ClientLedger {
  return {
    budgets: [
      {
        id: BUDGET,
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
    for (const listener of this.listeners) listener();
  }
}

function ports(calls: string[]) {
  const plain = (_scope: ImportJobStorageScope, activity: ImportActivityStore): ImportJobManagerPlainPort => ({
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
    dismiss: () => calls.push("plain.dismiss"),
  });
  const e2ee = (_scope: ImportJobStorageScope, activity: ImportActivityStore): ImportJobManagerE2eePort => ({
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
    dismiss: async () => void calls.push("e2ee.dismiss"),
  });
  return { plain, e2ee };
}

describe("import job manager", () => {
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
    expect(calls.filter((call) => call === "plain.start")).toEqual(["plain.start"]);
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
    expect(calls).toContain("plain.stop");
    expect(calls).toContain("timer.clear");
    expect(calls.filter((call) => call === "e2ee.resume")).toHaveLength(resumesBeforeStop);
  });
});
