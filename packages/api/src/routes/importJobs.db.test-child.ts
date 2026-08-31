import { readdirSync, readFileSync } from "node:fs";
import { reconcileBudgetPreferences } from "@enveo/shared";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import { assertThrowawayDb, emitChildResult } from "../api.test-support";
import * as schema from "../db/schema";

export const SENTINEL = "__IMPORT_JOB_ROUTES_CHILD__";

export interface ImportJobRoutesOutput {
  creation: { firstStatus: number; replayStatus: number; conflictStatus: number; jobs: number; images: number; provider: string | null; model: string | null };
  guards: { budgetStatus: number; accountStatus: number; tierStatus: number; rulesStatus: number; rejectedJobs: number; rejectedImages: number };
  ownership: {
    foreignListHasJob: boolean;
    foreignGetStatus: number;
    foreignCancelStatus: number;
    foreignRetryStatus: number;
    ownerCancelStatus: number;
    ownerRetryStatus: number;
  };
  completion: {
    notReadyStatus: number;
    mismatchStatus: number;
    readyStatus: number;
    status: string | null;
    appliedCount: number | null;
    skippedCount: number | null;
  };
  publicReadSafe: boolean;
}

async function applyMigration(sql: ReturnType<typeof postgres>, path: string): Promise<void> {
  const source = readFileSync(path, "utf8");
  for (const statement of source
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter(Boolean)) {
    await sql.unsafe(statement);
  }
}

async function main() {
  const testUrl = process.env.DATABASE_URL ?? "";
  assertThrowawayDb(testUrl);
  const postgres = (await import("postgres")).default;
  const admin = postgres(testUrl, { max: 1, onnotice: () => {} });
  const dbName = `enveo_import_job_routes_${crypto.randomUUID().replaceAll("-", "")}`;
  const derived = new URL(testUrl);
  derived.pathname = `/${dbName}`;
  let isolated: ReturnType<typeof postgres> | undefined;

  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    isolated = postgres(derived.toString(), { max: 10, onnotice: () => {} });
    const migrationsDir = new URL("../../drizzle", import.meta.url).pathname;
    for (const name of readdirSync(migrationsDir)
      .filter((entry) => /^\d{4}_.+\.sql$/.test(entry))
      .sort()) {
      await applyMigration(isolated, `${migrationsDir}/${name}`);
    }

    const { Hono } = await import("hono");
    const { ZodError } = await import("zod");
    const { TierMismatch } = await import("../context");
    const { createImportJobRoutes } = await import("./importJobs");
    const database = drizzle(isolated, { schema });
    const [userA, userB, userE] = await database
      .insert(schema.users)
      .values([
        { email: `jobs-a-${crypto.randomUUID()}@test.local` },
        { email: `jobs-b-${crypto.randomUUID()}@test.local` },
        { email: `jobs-e-${crypto.randomUUID()}@test.local` },
      ])
      .returning({ id: schema.users.id });
    const openaiPreferences = { ...reconcileBudgetPreferences(undefined), aiProvider: "openai" as const, openaiModel: "gpt-5.6-sol" as const };
    const [budgetA] = await database
      .insert(schema.budgets)
      .values({ userId: userA!.id, name: "A", preferences: openaiPreferences })
      .returning({ id: schema.budgets.id });
    const [budgetB] = await database
      .insert(schema.budgets)
      .values({ userId: userB!.id, name: "B", preferences: openaiPreferences })
      .returning({ id: schema.budgets.id });
    const [budgetE] = await database
      .insert(schema.budgets)
      .values({ userId: userE!.id, name: "E", tier: "e2ee", epoch: 1, preferences: openaiPreferences })
      .returning({ id: schema.budgets.id });
    const [accountA] = await database.insert(schema.accounts).values({ budgetId: budgetA!.id, name: "A" }).returning({ id: schema.accounts.id });
    const [accountB] = await database.insert(schema.accounts).values({ budgetId: budgetB!.id, name: "B" }).returning({ id: schema.accounts.id });

    let sessionUser = userA!.id;
    let wakes = 0;
    const app = new Hono<{ Variables: { userId?: string } }>();
    app.use("*", async (c, next) => {
      c.set("userId", sessionUser);
      await next();
    });
    app.route("/api", createImportJobRoutes({ database, operatorModel: "operator-model", wake: () => (wakes += 1) }));
    app.onError((error, c) => {
      if (error instanceof ZodError) return c.json({ error: "validation" }, 400);
      if (error instanceof TierMismatch) return c.json({ error: "tier_mismatch" }, 409);
      return c.json({ error: "internal" }, 500);
    });

    const png = "data:image/png;base64,iVBORw0KGgo=";
    const jpeg = "data:image/jpeg;base64,/9j/2w==";
    const request = (id: string, budgetId = budgetA!.id, accountId = accountA!.id, images = [png]) => ({ id, budgetId, accountId, locale: "pl-PL", images });
    const post = (path: string, body: unknown) =>
      app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const createId = crypto.randomUUID();
    const first = await post("/api/import/jobs", request(createId));
    const firstBody = (await first.json()) as Record<string, unknown>;
    const replay = await post("/api/import/jobs", request(createId));
    const conflict = await post("/api/import/jobs", request(createId, budgetA!.id, accountA!.id, [jpeg]));
    const [creationCounts] = await isolated<{ jobs: number; images: number; provider: string | null; model: string | null }[]>`
      select (select count(*)::int from import_jobs where id = ${createId}) as jobs,
             (select count(*)::int from import_job_images where job_id = ${createId}) as images,
             (select provider from import_jobs where id = ${createId}) as provider,
             (select model from import_jobs where id = ${createId}) as model`;

    const budgetGuardId = crypto.randomUUID();
    const budgetGuard = await post("/api/import/jobs", request(budgetGuardId, budgetB!.id));
    const accountGuardId = crypto.randomUUID();
    const accountGuard = await post("/api/import/jobs", request(accountGuardId, budgetA!.id, accountB!.id));
    sessionUser = userE!.id;
    const tierGuardId = crypto.randomUUID();
    const tierGuard = await post("/api/import/jobs", request(tierGuardId, budgetE!.id, accountB!.id));
    sessionUser = userA!.id;
    await database
      .update(schema.budgets)
      .set({ preferences: { ...openaiPreferences, aiProvider: "rules" } })
      .where(eq(schema.budgets.id, budgetA!.id));
    const rulesGuardId = crypto.randomUUID();
    const rulesGuard = await post("/api/import/jobs", request(rulesGuardId));
    await database.update(schema.budgets).set({ preferences: openaiPreferences }).where(eq(schema.budgets.id, budgetA!.id));
    const rejectedIds = [budgetGuardId, accountGuardId, tierGuardId, rulesGuardId];
    const [guardCounts] = await isolated<{ jobs: number; images: number }[]>`
      select (select count(*)::int from import_jobs where id = any(${rejectedIds})) as jobs,
             (select count(*)::int from import_job_images where job_id = any(${rejectedIds})) as images`;

    const cancelId = crypto.randomUUID();
    const retryId = crypto.randomUUID();
    await post("/api/import/jobs", request(cancelId));
    await post("/api/import/jobs", request(retryId));
    await isolated`update import_jobs set status = 'failed', phase = 'extracting', error_code = 'ai_timeout' where id = ${retryId}`;
    sessionUser = userB!.id;
    const foreignList = (await (await app.request("/api/import/jobs")).json()) as Array<{ id?: string }>;
    const foreignGet = await app.request(`/api/import/jobs/${createId}`);
    const foreignCancel = await post(`/api/import/jobs/${cancelId}/cancel`, { budgetId: budgetB!.id });
    const foreignRetry = await post(`/api/import/jobs/${retryId}/retry`, { budgetId: budgetB!.id });
    sessionUser = userA!.id;
    const ownerCancel = await post(`/api/import/jobs/${cancelId}/cancel`, { budgetId: budgetA!.id });
    const ownerRetry = await post(`/api/import/jobs/${retryId}/retry`, { budgetId: budgetA!.id });

    const notReady = await post(`/api/import/jobs/${retryId}/complete`, { budgetId: budgetA!.id, appliedCount: 2, skippedCount: 1 });
    await isolated`delete from import_job_images where job_id = ${createId}`;
    await database
      .update(schema.importJobs)
      .set({ status: "ready", phase: "ready", result: { rows: [], proposals: [] } })
      .where(eq(schema.importJobs.id, createId));
    const mismatchComplete = await post(`/api/import/jobs/${createId}/complete`, { budgetId: budgetB!.id, appliedCount: 2, skippedCount: 1 });
    const readyComplete = await post(`/api/import/jobs/${createId}/complete`, { budgetId: budgetA!.id, appliedCount: 2, skippedCount: 1 });
    const [completed] = await isolated<{ status: string; appliedCount: number; skippedCount: number }[]>`
      select status, applied_count as "appliedCount", skipped_count as "skippedCount" from import_jobs where id = ${createId}`;

    const serialized = JSON.stringify(firstBody).toLowerCase();
    const forbidden = ["images", "requesthash", "leasetoken", "leaseowner", "leaseexpires", "extraction", "credential", "ciphertext"];

    await emitChildResult(SENTINEL, {
      creation: {
        firstStatus: first.status,
        replayStatus: replay.status,
        conflictStatus: conflict.status,
        jobs: creationCounts?.jobs ?? 0,
        images: creationCounts?.images ?? 0,
        provider: creationCounts?.provider ?? null,
        model: creationCounts?.model ?? null,
      },
      guards: {
        budgetStatus: budgetGuard.status,
        accountStatus: accountGuard.status,
        tierStatus: tierGuard.status,
        rulesStatus: rulesGuard.status,
        rejectedJobs: guardCounts?.jobs ?? 0,
        rejectedImages: guardCounts?.images ?? 0,
      },
      ownership: {
        foreignListHasJob: foreignList.some((item) => item.id === createId),
        foreignGetStatus: foreignGet.status,
        foreignCancelStatus: foreignCancel.status,
        foreignRetryStatus: foreignRetry.status,
        ownerCancelStatus: ownerCancel.status,
        ownerRetryStatus: ownerRetry.status,
      },
      completion: {
        notReadyStatus: notReady.status,
        mismatchStatus: mismatchComplete.status,
        readyStatus: readyComplete.status,
        status: completed?.status ?? null,
        appliedCount: completed?.appliedCount ?? null,
        skippedCount: completed?.skippedCount ?? null,
      },
      publicReadSafe: forbidden.every((key) => !serialized.includes(key)) && wakes === 4,
    } satisfies ImportJobRoutesOutput);
  } finally {
    if (isolated) await isolated.end({ timeout: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end({ timeout: 1 });
  }
}

if (import.meta.main) await main();
