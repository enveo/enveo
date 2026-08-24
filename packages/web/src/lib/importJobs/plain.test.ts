import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ImportJobDetail, ImportJobSummary } from "@enveo/shared";
import { IDBFactory } from "fake-indexeddb";
import { __resetStorageForTests } from "../idb";
import { type ImportJobStorageScope, importJobStorage } from "../importJobStorage";
import { type PlainImportCreateInput, PlainImportJobAdapter, type PlainImportJobRemote } from "./plain";
import { createImportActivityStore, type ImportActivityItem, importActivityFromServer } from "./store";

const ID = "11111111-1111-1111-1111-111111111111";
const BUDGET = "22222222-2222-2222-2222-222222222222";
const ACCOUNT = "33333333-3333-3333-3333-333333333333";
const SCOPE = { ownerId: "user-a", budgetId: BUDGET } satisfies ImportJobStorageScope;
const IMAGE = "data:image/png;base64,AA==";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function detail(overrides: Partial<ImportJobDetail> = {}): ImportJobDetail {
  return {
    id: ID,
    budgetId: BUDGET,
    accountId: ACCOUNT,
    provider: { provider: "enveo", model: "gpt-5.6-luna" },
    locale: "en-US",
    tier: "plain",
    epoch: 0,
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
    ...overrides,
  };
}

function remote(overrides: Partial<PlainImportJobRemote> = {}): PlainImportJobRemote & { cancellations: string[] } {
  const cancellations: string[] = [];
  return {
    create: async () => detail(),
    list: async () => [],
    get: async () => detail(),
    cancel: async (id) => {
      cancellations.push(id);
      return detail({ status: "cancelled", cancelRequested: true });
    },
    retry: async () => detail(),
    complete: async (_id, input) => detail({ status: "completed", phase: "completed", appliedCount: input.appliedCount, skippedCount: input.skippedCount }),
    ...overrides,
    cancellations,
  };
}

function input(): PlainImportCreateInput {
  return { id: ID, accountId: ACCOUNT, locale: "en-US", images: [IMAGE] };
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

describe("plain durable import adapter", () => {
  it("completes only through the tenant-asserted remote boundary and publishes the minimal summary", async () => {
    // given: a ready plain job and a remote completion boundary
    const calls: Array<{ id: string; budgetId: string; appliedCount: number; skippedCount: number }> = [];
    const api = remote({
      complete: async (id, input) => {
        calls.push({ id, ...input });
        return detail({
          status: "completed",
          phase: "completed",
          result: null,
          proposalCount: 2,
          appliedCount: input.appliedCount,
          skippedCount: input.skippedCount,
        });
      },
    });
    const activity = createImportActivityStore();
    activity.upsert(
      // use the real create mapping before the server transitions the job
      {
        ...importActivityFromServer(detail({ status: "ready", phase: "ready", result: { rows: [], proposals: [] }, proposalCount: 2 })),
      },
    );
    const adapter = new PlainImportJobAdapter({ scope: SCOPE, activity, remote: api });

    // when: the reviewed rows have all been applied or skipped locally
    await adapter.complete(ID, { appliedCount: 1, skippedCount: 1 });

    // then: counts cross the server boundary with the manager-owned budget assertion, never result data
    expect(calls).toEqual([{ id: ID, budgetId: BUDGET, appliedCount: 1, skippedCount: 1 }]);
    expect(activity.get(ID)).toMatchObject({ status: "completed", result: null, appliedCount: 1, skippedCount: 1 });
  });

  it("persists the upload draft before the first server request and removes it only after acknowledgement", async () => {
    let draftAtRequest = false;
    const api = remote({
      create: async () => {
        draftAtRequest = Boolean(await importJobStorage.getDraft(SCOPE, ID));
        return detail();
      },
    });
    const adapter = new PlainImportJobAdapter({ scope: SCOPE, activity: createImportActivityStore(), remote: api });

    await adapter.create(input());

    expect(draftAtRequest).toBe(true);
    expect(await importJobStorage.getDraft(SCOPE, ID)).toBeUndefined();
  });

  it("exposes the durable uploading item before the server acknowledges creation", async () => {
    // given: the create request remains in flight after its local draft is durable
    const response = deferred<ImportJobDetail>();
    const adapter = new PlainImportJobAdapter({
      scope: SCOPE,
      activity: createImportActivityStore(),
      remote: remote({ create: () => response.promise }),
    });
    const observed: ImportActivityItem[] = [];

    // when: foreground creation supplies the manager-owned observer
    const creation = adapter.create(input(), (created) => observed.push(created));
    while (observed.length === 0 && !(await importJobStorage.getDraft(SCOPE, ID))) await Promise.resolve();

    // then: the sheet can attach/background/cancel without owning the pending request
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ id: ID, source: "plain-draft", status: "queued", phase: "uploading" });

    response.resolve(detail());
    await creation;
  });

  it("retries the identical id and images after a lost acknowledgement", async () => {
    const requests: Array<{ id: string; images: string[] }> = [];
    let attempt = 0;
    const api = remote({
      create: async (request) => {
        requests.push({ id: request.id, images: [...request.images] });
        attempt++;
        if (attempt === 1) throw new Error("ai_unreachable");
        return detail();
      },
    });
    const adapter = new PlainImportJobAdapter({ scope: SCOPE, activity: createImportActivityStore(), remote: api });

    await expect(adapter.create(input())).rejects.toThrow("ai_unreachable");
    expect(await importJobStorage.getDraft(SCOPE, ID)).toBeDefined();
    await adapter.resumeDrafts();

    expect(requests).toEqual([
      { id: ID, images: [IMAGE] },
      { id: ID, images: [IMAGE] },
    ]);
    expect(await importJobStorage.getDraft(SCOPE, ID)).toBeUndefined();
  });

  it("polls active jobs only while visible and publishes a ready detail to an open observer", async () => {
    let visible = false;
    let tick: (() => void) | undefined;
    let listCalls = 0;
    let getCalls = 0;
    const queued = detail();
    const ready = detail({ status: "ready", phase: "ready", result: { rows: [], proposals: [] }, updatedAt: "2026-08-24T10:01:00.000Z" });
    const api = remote({
      list: async (): Promise<ImportJobSummary[]> => {
        listCalls++;
        return [listCalls > 1 ? ready : queued];
      },
      get: async () => {
        getCalls++;
        return ready;
      },
    });
    const activity = createImportActivityStore();
    const adapter = new PlainImportJobAdapter({
      scope: SCOPE,
      activity,
      remote: api,
      visible: () => visible,
      scheduleInterval: (callback) => {
        tick = callback;
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearScheduledInterval: () => {},
    });
    const phases: string[] = [];
    const unsubscribe = adapter.observe(ID, (item) => phases.push(item?.phase ?? "missing"));
    adapter.start();

    tick?.();
    await Promise.resolve();
    expect(listCalls).toBe(0);

    visible = true;
    await adapter.refresh();
    tick?.();
    for (let attempt = 0; attempt < 50 && listCalls < 2; attempt++) await new Promise((resolve) => setTimeout(resolve, 0));

    unsubscribe();
    adapter.stop();
    expect(listCalls).toBe(2);
    expect(getCalls).toBe(1);
    expect(phases.at(-1)).toBe("ready");
  });

  it("does not cancel server work when the last observer unsubscribes", async () => {
    const api = remote();
    const adapter = new PlainImportJobAdapter({ scope: SCOPE, activity: createImportActivityStore(), remote: api });
    const unsubscribe = adapter.observe(ID, () => {});

    unsubscribe();
    await Promise.resolve();

    expect(api.cancellations).toEqual([]);
  });

  it("does not publish a delayed refresh after the adapter is stopped", async () => {
    const response = deferred<ImportJobSummary[]>();
    const activity = createImportActivityStore();
    const adapter = new PlainImportJobAdapter({
      scope: SCOPE,
      activity,
      remote: remote({ list: () => response.promise }),
    });

    const refresh = adapter.refresh(true);
    adapter.stop();
    response.resolve([detail()]);
    await refresh;

    expect(activity.list()).toEqual([]);
  });

  it("does not republish a delayed upload after its scope capability is revoked", async () => {
    const response = deferred<ImportJobDetail>();
    let current = true;
    const activity = createImportActivityStore();
    const adapter = new PlainImportJobAdapter({
      scope: SCOPE,
      activity,
      capability: { isCurrent: () => current },
      remote: remote({ create: () => response.promise }),
    });

    const creation = adapter.create(input());
    while (!(await importJobStorage.getDraft(SCOPE, ID))) await Promise.resolve();
    current = false;
    activity.clear();
    response.resolve(detail());
    await creation;

    expect(activity.list()).toEqual([]);
  });

  it("persists cancellation across a delayed 202, cancels the accepted job, and never republishes it", async () => {
    const response = deferred<ImportJobDetail>();
    const api = remote({
      create: () => response.promise,
      list: async () => [detail({ status: "cancelled", cancelRequested: true })],
    });
    const activity = createImportActivityStore();
    const adapter = new PlainImportJobAdapter({ scope: SCOPE, activity, remote: api });

    const creation = adapter.create(input());
    while (!(await importJobStorage.getDraft(SCOPE, ID))) await Promise.resolve();
    const cancellation = adapter.cancel(ID);
    response.resolve(detail());
    await Promise.allSettled([creation, cancellation]);
    await adapter.refresh(true);

    expect(api.cancellations).toEqual([ID]);
    expect(await importJobStorage.getDraft(SCOPE, ID)).toBeUndefined();
    expect(activity.get(ID)).toBeUndefined();
  });

  it("cancels the accepted server job when acknowledgement wins the cancellation-marker race", async () => {
    const response = deferred<ImportJobDetail>();
    const cancellationStarted = deferred<void>();
    const releaseCancellation = deferred<void>();
    const originalRequestCancellation = importJobStorage.requestDraftCancellation;
    importJobStorage.requestDraftCancellation = async (...args) => {
      cancellationStarted.resolve();
      await releaseCancellation.promise;
      return originalRequestCancellation(...args);
    };
    const api = remote({ create: () => response.promise });
    const activity = createImportActivityStore();
    const adapter = new PlainImportJobAdapter({ scope: SCOPE, activity, remote: api });

    try {
      const creation = adapter.create(input());
      while (!(await importJobStorage.getDraft(SCOPE, ID))?.uploadAttemptedAt) await Promise.resolve();
      const cancellation = adapter.cancel(ID);
      await cancellationStarted.promise;
      response.resolve(detail());
      await creation;
      releaseCancellation.resolve();
      await cancellation;
    } finally {
      importJobStorage.requestDraftCancellation = originalRequestCancellation;
    }

    expect(api.cancellations).toEqual([ID]);
    expect(activity.get(ID)).toBeUndefined();
  });

  it("cancels by deterministic id when another adapter acknowledges between get and the cancel marker", async () => {
    const response = deferred<ImportJobDetail>();
    const cancellationStarted = deferred<void>();
    const releaseCancellation = deferred<void>();
    const originalRequestCancellation = importJobStorage.requestDraftCancellation;
    importJobStorage.requestDraftCancellation = async (...args) => {
      cancellationStarted.resolve();
      await releaseCancellation.promise;
      return originalRequestCancellation(...args);
    };
    const uploader = new PlainImportJobAdapter({
      scope: SCOPE,
      activity: createImportActivityStore(),
      remote: remote({ create: () => response.promise }),
    });
    const api = remote({ list: async () => [detail({ status: "cancelled", cancelRequested: true })] });
    const activity = createImportActivityStore();
    const canceller = new PlainImportJobAdapter({ scope: SCOPE, activity, remote: api });

    try {
      const creation = uploader.create(input());
      while (!(await importJobStorage.getDraft(SCOPE, ID))?.uploadAttemptedAt) await Promise.resolve();
      const cancellation = canceller.cancel(ID);
      await cancellationStarted.promise;
      response.resolve(detail());
      await creation;
      releaseCancellation.resolve();
      await cancellation;
      await canceller.refresh(true);
    } finally {
      importJobStorage.requestDraftCancellation = originalRequestCancellation;
    }

    expect(api.cancellations).toEqual([ID]);
    expect(activity.get(ID)).toBeUndefined();
  });

  it("treats a definitive 404 as safely cancelled after another adapter deletes the draft", async () => {
    const cancellationStarted = deferred<void>();
    const releaseCancellation = deferred<void>();
    const originalRequestCancellation = importJobStorage.requestDraftCancellation;
    importJobStorage.requestDraftCancellation = async (...args) => {
      cancellationStarted.resolve();
      await releaseCancellation.promise;
      return originalRequestCancellation(...args);
    };
    const draft = await importJobStorage.createDraft(SCOPE, { ...input(), ownerId: SCOPE.ownerId, budgetId: SCOPE.budgetId });
    let cancelAttempts = 0;
    const activity = createImportActivityStore();
    const adapter = new PlainImportJobAdapter({
      scope: SCOPE,
      activity,
      remote: remote({
        cancel: async () => {
          cancelAttempts++;
          throw new Error('404 {"error":"not_found"}');
        },
      }),
    });

    try {
      const cancellation = adapter.cancel(ID);
      await cancellationStarted.promise;
      await importJobStorage.deleteDraft(SCOPE, ID, draft.requestHash);
      releaseCancellation.resolve();
      await cancellation;
    } finally {
      importJobStorage.requestDraftCancellation = originalRequestCancellation;
    }

    expect(cancelAttempts).toBe(1);
    expect(activity.get(ID)).toBeUndefined();
  });

  it("reconciles a lost create response from a durable cancel tombstone after restart", async () => {
    const requests: string[][] = [];
    const first = new PlainImportJobAdapter({
      scope: SCOPE,
      activity: createImportActivityStore(),
      remote: remote({
        create: async (request) => {
          requests.push([...request.images]);
          throw new Error("ai_unreachable");
        },
      }),
    });
    await expect(first.create(input())).rejects.toThrow("ai_unreachable");
    const draft = await importJobStorage.getDraft(SCOPE, ID);
    expect(draft?.uploadAttemptedAt).not.toBeNull();
    await importJobStorage.requestDraftCancellation(SCOPE, ID, draft!.requestHash);
    first.stop();

    const api = remote({
      create: async (request) => {
        requests.push([...request.images]);
        return detail();
      },
    });
    const restarted = new PlainImportJobAdapter({ scope: SCOPE, activity: createImportActivityStore(), remote: api });
    await restarted.resumeDrafts();

    expect(requests).toEqual([[IMAGE], [IMAGE]]);
    expect(api.cancellations).toEqual([ID]);
    expect(await importJobStorage.getDraft(SCOPE, ID)).toBeUndefined();
  });
});
