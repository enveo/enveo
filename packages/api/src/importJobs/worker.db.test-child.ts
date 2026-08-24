import { readdirSync, readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import { assertThrowawayDb, emitChildResult } from "../api.test-support";
import * as schema from "../db/schema";
import { createImportJobRepository } from "./repository";
import { startImportJobWorker } from "./worker";

export const SENTINEL = "__IMPORT_JOB_WORKER_CHILD__";

export interface ImportJobWorkerDbOutput {
  concurrency: { processors: number; status: string | null; attempts: number | null; ledgerRowsBefore: number; ledgerRowsAfter: number };
  restart: { crashClaimed: boolean; reclaimed: boolean; resumedWithoutImages: boolean; attempts: number | null; status: string | null };
  images: { concurrentJobImages: number; restartedJobImages: number };
}

const EMPTY_RESULT = { rows: [], proposals: [] };

async function applyMigration(sql: ReturnType<typeof postgres>, path: string): Promise<void> {
  const source = readFileSync(path, "utf8");
  for (const statement of source
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter(Boolean)) {
    await sql.unsafe(statement);
  }
}

async function crashAfterClaim(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  assertThrowawayDb(url);
  const postgres = (await import("postgres")).default;
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const repository = createImportJobRepository(drizzle(sql, { schema }));
  const claimed = await repository.claimNext("worker-that-exits", new Date("2026-08-24T13:01:00.000Z"));
  if (claimed) {
    await repository.saveExtractionAndDeleteImages(claimed.id, claimed.leaseToken, EMPTY_RESULT, new Date("2026-08-24T13:01:10.000Z"));
    await repository.advancePhase(claimed.id, claimed.leaseToken, "reconciling", new Date("2026-08-24T13:01:20.000Z"));
  }
  process.stdout.write(claimed ? claimed.id : "none");
  await sql.end({ timeout: 1 });
}

async function eventually<T>(probe: () => Promise<T | null>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== null) return result;
    await Bun.sleep(10);
  }
  throw new Error("condition_not_met");
}

async function main() {
  if (process.env.IMPORT_WORKER_CRASH_ONLY === "1") {
    await crashAfterClaim();
    return;
  }

  const testUrl = process.env.DATABASE_URL ?? "";
  assertThrowawayDb(testUrl);
  const postgres = (await import("postgres")).default;
  const admin = postgres(testUrl, { max: 1, onnotice: () => {} });
  const dbName = `enveo_import_worker_${crypto.randomUUID().replaceAll("-", "")}`;
  const derived = new URL(testUrl);
  derived.pathname = `/${dbName}`;
  let isolated: ReturnType<typeof postgres> | undefined;

  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    isolated = postgres(derived.toString(), { max: 12, onnotice: () => {} });
    const migrationsDir = new URL("../../drizzle", import.meta.url).pathname;
    for (const name of readdirSync(migrationsDir)
      .filter((entry) => /^\d{4}_.+\.sql$/.test(entry))
      .sort()) {
      await applyMigration(isolated, `${migrationsDir}/${name}`);
    }

    const database = drizzle(isolated, { schema });
    const repository = createImportJobRepository(database);
    const [user] = await database
      .insert(schema.users)
      .values({ email: `worker-${crypto.randomUUID()}@test.local` })
      .returning({ id: schema.users.id });
    const [budget] = await database.insert(schema.budgets).values({ userId: user!.id, name: "Worker", currency: "EUR" }).returning({ id: schema.budgets.id });
    const [account] = await database.insert(schema.accounts).values({ budgetId: budget!.id, name: "Selected" }).returning({ id: schema.accounts.id });
    const createInput = (id: string) => ({
      id,
      userId: user!.id,
      budgetId: budget!.id,
      accountId: account!.id,
      provider: { provider: "enveo" as const, model: "gpt-test" },
      locale: "en",
      tier: "plain" as const,
      epoch: 0,
      images: [{ mimeType: "image/png", content: new Uint8Array([1, 2, 3]) }],
    });

    const [ledgerBefore] = await isolated<{ count: number }[]>`select count(*)::int as count from transactions`;
    const concurrentId = crypto.randomUUID();
    await repository.create(createInput(concurrentId), new Date("2026-08-24T12:00:00.000Z"));
    const processors: string[] = [];
    const processClaim = (workerId: string) => async (job: Awaited<ReturnType<typeof repository.claimNext>> & {}) => {
      if (!job) return;
      processors.push(workerId);
      await Bun.sleep(20);
      await repository.saveExtractionAndDeleteImages(job.id, job.leaseToken, EMPTY_RESULT, new Date("2026-08-24T12:01:10.000Z"));
      await repository.advancePhase(job.id, job.leaseToken, "reconciling", new Date("2026-08-24T12:01:20.000Z"));
      await repository.saveReadyResult(job.id, job.leaseToken, EMPTY_RESULT, new Date("2026-08-24T12:01:30.000Z"));
    };
    const workerA = startImportJobWorker({
      workerId: "worker-a",
      repository,
      processJob: processClaim("worker-a"),
      idleMs: 10,
      now: () => new Date("2026-08-24T12:01:00.000Z"),
    });
    const workerB = startImportJobWorker({
      workerId: "worker-b",
      repository,
      processJob: processClaim("worker-b"),
      idleMs: 10,
      now: () => new Date("2026-08-24T12:01:00.000Z"),
    });
    const concurrentRow = await eventually(async () => {
      const [row] = await isolated!<{ status: string; attempt: number }[]>`select status, attempt from import_jobs where id = ${concurrentId}`;
      return row?.status === "ready" ? row : null;
    });
    await Promise.all([workerA.stop(), workerB.stop()]);
    const [concurrentImages] = await isolated<{ count: number }[]>`select count(*)::int as count from import_job_images where job_id = ${concurrentId}`;
    const [ledgerAfter] = await isolated<{ count: number }[]>`select count(*)::int as count from transactions`;

    const restartId = crypto.randomUUID();
    await repository.create(createInput(restartId), new Date("2026-08-24T13:00:00.000Z"));
    const crash = Bun.spawn([process.execPath, import.meta.path], {
      cwd: new URL("../..", import.meta.url).pathname,
      env: { ...process.env, DATABASE_URL: derived.toString(), EXPECT_DATABASE_URL: derived.toString(), IMPORT_WORKER_CRASH_ONLY: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [crashStdout, crashStderr, crashCode] = await Promise.all([new Response(crash.stdout).text(), new Response(crash.stderr).text(), crash.exited]);
    if (crashCode !== 0) throw new Error(`crash worker failed: ${crashStderr}`);
    const crashClaimed = crashStdout === restartId;
    let reclaimed = false;
    let resumedWithoutImages = false;
    const restarted = startImportJobWorker({
      workerId: "worker-restarted",
      repository,
      processJob: async (job) => {
        reclaimed = job.id === restartId && job.attempt === 2;
        resumedWithoutImages = job.extraction !== null && job.images.length === 0 && job.phase === "validating";
        await repository.advancePhase(job.id, job.leaseToken, "reconciling", new Date("2026-08-24T13:07:20.000Z"));
        await repository.saveReadyResult(job.id, job.leaseToken, EMPTY_RESULT, new Date("2026-08-24T13:07:30.000Z"));
      },
      idleMs: 10,
      now: () => new Date("2026-08-24T13:07:00.000Z"),
    });
    const restartRow = await eventually(async () => {
      const [row] = await isolated!<{ status: string; attempt: number }[]>`select status, attempt from import_jobs where id = ${restartId}`;
      return row?.status === "ready" ? row : null;
    });
    await restarted.stop();
    const [restartImages] = await isolated<{ count: number }[]>`select count(*)::int as count from import_job_images where job_id = ${restartId}`;

    emitChildResult(SENTINEL, {
      concurrency: {
        processors: processors.length,
        status: concurrentRow.status,
        attempts: concurrentRow.attempt,
        ledgerRowsBefore: ledgerBefore?.count ?? -1,
        ledgerRowsAfter: ledgerAfter?.count ?? -1,
      },
      restart: { crashClaimed, reclaimed, resumedWithoutImages, attempts: restartRow.attempt, status: restartRow.status },
      images: { concurrentJobImages: concurrentImages?.count ?? -1, restartedJobImages: restartImages?.count ?? -1 },
    } satisfies ImportJobWorkerDbOutput);
  } finally {
    if (isolated) await isolated.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
