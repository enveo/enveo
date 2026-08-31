import { describe, expect, it } from "bun:test";
import { createDefaultBudgetPreferences, type ImportJobDetail, type ImportJobSummary } from "@enveo/shared";
import { Hono } from "hono";
import { type CreateImportJobInput, ImportJobConflict } from "../importJobs/repository";
import { createImportJobRoutes, type ImportJobRouteRepository } from "./importJobs";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const BUDGET_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BUDGET_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACCOUNT_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const JOB_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PNG_URL = "data:image/png;base64,iVBORw0KGgo=";

function job(overrides: Partial<ImportJobDetail> = {}): ImportJobDetail {
  return {
    id: JOB_ID,
    budgetId: BUDGET_A,
    accountId: ACCOUNT_A,
    provider: { provider: "enveo", model: "operator-model" },
    tier: "plain",
    status: "queued",
    phase: "queued",
    resumePhase: null,
    cancelRequested: false,
    attempt: 0,
    errorCode: null,
    retryAt: null,
    createdAt: "2026-08-24T12:00:00.000Z",
    updatedAt: "2026-08-24T12:00:00.000Z",
    expiresAt: "2026-08-31T12:00:00.000Z",
    proposalCount: 0,
    locale: "pl-PL",
    epoch: 0,
    result: null,
    appliedCount: 0,
    skippedCount: 0,
    ...overrides,
  };
}

function summary(overrides: Partial<ImportJobSummary> = {}): ImportJobSummary {
  const detail = job();
  return {
    id: detail.id,
    budgetId: detail.budgetId,
    accountId: detail.accountId,
    provider: detail.provider,
    tier: detail.tier,
    status: detail.status,
    phase: detail.phase,
    resumePhase: detail.resumePhase,
    cancelRequested: detail.cancelRequested,
    attempt: detail.attempt,
    errorCode: detail.errorCode,
    retryAt: detail.retryAt,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    expiresAt: detail.expiresAt,
    proposalCount: detail.proposalCount,
    ...overrides,
  };
}

function createBody(overrides: Record<string, unknown> = {}) {
  return { id: JOB_ID, budgetId: BUDGET_A, accountId: ACCOUNT_A, locale: "pl-PL", images: [PNG_URL], ...overrides };
}

function mutationBody(overrides: Record<string, unknown> = {}) {
  return { budgetId: BUDGET_A, ...overrides };
}

function harness(
  overrides: {
    sessionUser?: string;
    repository?: Partial<ImportJobRouteRepository>;
    resolvedBudgetId?: string;
    accountAllowed?: boolean;
    provider?: "rules" | "enveo" | "openai";
    wake?: () => void;
  } = {},
) {
  const calls = { creates: [] as CreateImportJobInput[], users: [] as string[], mutationBudgets: [] as string[], completes: 0 };
  const repository: ImportJobRouteRepository = {
    create: async (input) => {
      calls.creates.push(input);
      return { created: true, job: job({ provider: input.provider }) };
    },
    listForUser: async (userId) => {
      calls.users.push(userId);
      return [summary()];
    },
    getForUser: async (userId) => {
      calls.users.push(userId);
      return job();
    },
    getForBudget: async (userId, budgetId) => {
      calls.users.push(userId);
      calls.mutationBudgets.push(budgetId);
      return job();
    },
    requestCancel: async (userId, budgetId) => {
      calls.users.push(userId);
      calls.mutationBudgets.push(budgetId);
      return job({ status: "cancelled", cancelRequested: true });
    },
    retry: async (userId, budgetId) => {
      calls.users.push(userId);
      calls.mutationBudgets.push(budgetId);
      return job();
    },
    markCompleted: async (userId, budgetId, _id, appliedCount, skippedCount) => {
      calls.users.push(userId);
      calls.mutationBudgets.push(budgetId);
      calls.completes += 1;
      return job({ status: "completed", phase: "completed", appliedCount, skippedCount });
    },
    ...overrides.repository,
  };
  const app = new Hono<{ Variables: { userId?: string } }>();
  app.use("*", async (c, next) => {
    if (overrides.sessionUser !== "") c.set("userId", overrides.sessionUser ?? USER_A);
    await next();
  });
  app.route(
    "/api",
    createImportJobRoutes({
      repository,
      operatorModel: "operator-model",
      wake: overrides.wake,
      resolvePlainBudget: async () => ({ id: overrides.resolvedBudgetId ?? BUDGET_A, tier: "plain", epoch: 0, cipherVersion: 2 }),
      readPreferences: async () => ({
        ...createDefaultBudgetPreferences(),
        aiProvider: overrides.provider ?? "enveo",
        openaiModel: "gpt-5.6-sol",
        customProfiles: [],
        startWidgets: [],
      }),
      accountBelongsToBudget: async () => overrides.accountAllowed ?? true,
    }),
  );
  app.onError((_error, c) => c.json({ error: "internal" }, 500));
  return { app, calls };
}

async function post(app: Hono<{ Variables: { userId?: string } }>, path: string, body: unknown): Promise<Response> {
  return app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("plain durable import job routes", () => {
  it("returns 202 only after durable creation and snapshots server-side provider preferences", async () => {
    let persist = (_value: { created: boolean; job: ImportJobDetail }) => {};
    let wakeCount = 0;
    const repository = {
      create: (input: CreateImportJobInput) =>
        new Promise<{ created: boolean; job: ImportJobDetail }>((resolve) => {
          expect(input.provider).toEqual({ provider: "openai", model: "gpt-5.6-sol" });
          persist = resolve;
        }),
    };
    const { app } = harness({ provider: "openai", repository, wake: () => (wakeCount += 1) });
    let settled = false;
    const pending = post(app, "/api/import/jobs", createBody()).then((response) => {
      settled = true;
      return response;
    });
    await Bun.sleep(0);
    expect(settled).toBe(false);
    expect(wakeCount).toBe(0);

    persist({ created: true, job: job({ provider: { provider: "openai", model: "gpt-5.6-sol" } }) });
    const response = await pending;

    expect(response.status).toBe(202);
    expect(wakeCount).toBe(1);
    expect(await response.json()).toEqual(job({ provider: { provider: "openai", model: "gpt-5.6-sol" } }));
  });

  it("maps conflicting reuse to 409 without waking work", async () => {
    let wakeCount = 0;
    const { app } = harness({
      repository: {
        create: async () => {
          throw new ImportJobConflict();
        },
      },
      wake: () => (wakeCount += 1),
    });

    const response = await post(app, "/api/import/jobs", createBody());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "import_job_conflict" });
    expect(wakeCount).toBe(0);
  });

  it("rejects budget mismatch, foreign selected account, and rules before repository insertion", async () => {
    const mismatch = harness({ resolvedBudgetId: BUDGET_B });
    const foreignAccount = harness({ accountAllowed: false });
    const rules = harness({ provider: "rules" });

    const [mismatchResponse, accountResponse, rulesResponse] = await Promise.all([
      post(mismatch.app, "/api/import/jobs", createBody({ images: ["not-base64"] })),
      post(foreignAccount.app, "/api/import/jobs", createBody()),
      post(rules.app, "/api/import/jobs", createBody()),
    ]);

    expect([mismatchResponse.status, accountResponse.status, rulesResponse.status]).toEqual([409, 400, 409]);
    expect(mismatch.calls.creates).toHaveLength(0);
    expect(foreignAccount.calls.creates).toHaveLength(0);
    expect(rules.calls.creates).toHaveLength(0);
  });

  it("scopes list, get, cancel, and retry to the authenticated user", async () => {
    const { app, calls } = harness({ sessionUser: USER_B });

    const responses = await Promise.all([
      app.request("/api/import/jobs"),
      app.request(`/api/import/jobs/${JOB_ID}`),
      post(app, `/api/import/jobs/${JOB_ID}/cancel`, mutationBody()),
      post(app, `/api/import/jobs/${JOB_ID}/retry`, mutationBody()),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
    expect(calls.users).toEqual([USER_B, USER_B, USER_B, USER_B]);
    expect(calls.mutationBudgets).toEqual([BUDGET_A, BUDGET_A]);
  });

  it("completes only a ready owned job under the current budget assertion", async () => {
    const notReady = harness({ repository: { getForBudget: async () => job({ status: "failed", phase: "extracting", errorCode: "ai_timeout" }) } });
    const ready = harness({ repository: { getForBudget: async () => job({ status: "ready", phase: "ready", result: { rows: [], proposals: [] } }) } });

    const rejected = await post(notReady.app, `/api/import/jobs/${JOB_ID}/complete`, mutationBody({ appliedCount: 2, skippedCount: 1 }));
    const accepted = await post(ready.app, `/api/import/jobs/${JOB_ID}/complete`, mutationBody({ appliedCount: 2, skippedCount: 1 }));

    expect(rejected.status).toBe(409);
    expect(notReady.calls.completes).toBe(0);
    expect(accepted.status).toBe(200);
    expect(ready.calls.completes).toBe(1);
    expect(ready.calls.mutationBudgets).toEqual([BUDGET_A]);
  });

  it("rejects malformed public output from every response-producing endpoint", async () => {
    const malformed = (overrides: Partial<ImportJobDetail> = {}) => ({ ...job(overrides), requestHash: "must-not-leak" }) as ImportJobDetail;
    const create = harness({ repository: { create: async () => ({ created: true, job: malformed() }) } });
    const list = harness({ repository: { listForUser: async () => [{ ...summary(), requestHash: "must-not-leak" } as ImportJobSummary] } });
    const get = harness({ repository: { getForUser: async () => malformed() } });
    const cancel = harness({ repository: { requestCancel: async () => malformed({ status: "cancelled", cancelRequested: true }) } });
    const retry = harness({ repository: { retry: async () => malformed() } });
    const complete = harness({
      repository: {
        getForBudget: async () => job({ status: "ready", phase: "ready", result: { rows: [], proposals: [] } }),
        markCompleted: async () => malformed({ status: "completed", phase: "completed" }),
      },
    });

    const responses = await Promise.all([
      post(create.app, "/api/import/jobs", createBody()),
      list.app.request("/api/import/jobs"),
      get.app.request(`/api/import/jobs/${JOB_ID}`),
      post(cancel.app, `/api/import/jobs/${JOB_ID}/cancel`, mutationBody()),
      post(retry.app, `/api/import/jobs/${JOB_ID}/retry`, mutationBody()),
      post(complete.app, `/api/import/jobs/${JOB_ID}/complete`, mutationBody({ appliedCount: 1, skippedCount: 0 })),
    ]);

    expect(responses.map((response) => response.status)).toEqual([500, 500, 500, 500, 500, 500]);
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual(Array.from({ length: 6 }, () => ({ error: "internal" })));
  });
});
