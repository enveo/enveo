import { readdirSync, readFileSync } from "node:fs";
import type postgres from "postgres";
import { assertThrowawayDb, emitChildResult } from "../api.test-support";

export const SENTINEL = "__IMPORT_JOBS_MIGRATION_CHILD__";

export interface ImportJobsMigrationOutput {
  foreignKeys: {
    accountDeleteClearedSelection: boolean;
    budgetDeleteRemovedJobAndImages: boolean;
    userDeleteRemovedJobAndImages: boolean;
  };
  constraints: {
    duplicateUserJobRejected: boolean;
    duplicateImagePositionRejected: boolean;
    invalidStatusRejected: boolean;
    invalidPhaseRejected: boolean;
    invalidProviderRejected: boolean;
    invalidTierRejected: boolean;
    negativeEpochRejected: boolean;
    negativeCountersRejected: boolean;
  };
  readyWithImagesRejected: boolean;
  changeTriggerCount: number;
  chunkBackfill: {
    legacyWindowsCreated: boolean;
    screenshotTotalsFilled: boolean;
    checkpointedJobUntouched: boolean;
  };
}

const rejected = async (run: () => Promise<unknown>): Promise<boolean> => {
  try {
    await run();
    return false;
  } catch {
    return true;
  }
};

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
  const dbName = `enveo_import_jobs_migration_${crypto.randomUUID().replaceAll("-", "")}`;
  const derived = new URL(testUrl);
  derived.pathname = `/${dbName}`;
  let isolated: ReturnType<typeof postgres> | undefined;

  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    isolated = postgres(derived.toString(), { max: 1, onnotice: () => {} });
    const migrationsDir = new URL("../../drizzle", import.meta.url).pathname;
    const previous = readdirSync(migrationsDir)
      .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < "0026_")
      .sort();
    for (const name of previous) await applyMigration(isolated, `${migrationsDir}/${name}`);

    const userId = crypto.randomUUID();
    const budgetId = crypto.randomUUID();
    const accountId = crypto.randomUUID();
    await isolated`insert into users (id, email) values (${userId}, ${`jobs-${userId}@test.local`})`;
    await isolated`insert into budgets (id, user_id, name, currency) values (${budgetId}, ${userId}, 'Import jobs', 'EUR')`;
    await isolated`insert into accounts (id, budget_id, name) values (${accountId}, ${budgetId}, 'Selected')`;

    await applyMigration(isolated, `${migrationsDir}/0026_import_jobs.sql`);

    const insertJob = async (id: string) => {
      await isolated!.unsafe(
        `insert into import_jobs
          (id, client_id, user_id, budget_id, account_id, provider, model, locale, tier, epoch, request_hash, status, phase, expires_at)
         values ($1, 'client-1', $2, $3, $4, 'enveo', 'gpt-test', 'en', 'plain', 0, repeat('a', 64), 'queued', 'queued', now() + interval '7 days')`,
        [id, userId, budgetId, accountId],
      );
    };

    const selectedJobId = crypto.randomUUID();
    await insertJob(selectedJobId);
    await isolated`delete from accounts where id = ${accountId}`;
    const [afterAccountDelete] = await isolated<{ accountId: string | null }[]>`
      select account_id as "accountId" from import_jobs where id = ${selectedJobId}`;

    const budgetCascadeJobId = crypto.randomUUID();
    await isolated`insert into accounts (id, budget_id, name) values (${accountId}, ${budgetId}, 'Selected again')`;
    await insertJob(budgetCascadeJobId);
    await isolated`insert into import_job_images (job_id, position, mime_type, sha256, byte_length, content)
      values (${budgetCascadeJobId}, 0, 'image/png', repeat('b', 64), 3, ${new Uint8Array([1, 2, 3])})`;
    await isolated`delete from budgets where id = ${budgetId}`;
    const [afterBudgetDelete] = await isolated<{ jobs: number; images: number }[]>`
      select (select count(*)::int from import_jobs where id = ${budgetCascadeJobId}) as jobs,
             (select count(*)::int from import_job_images where job_id = ${budgetCascadeJobId}) as images`;

    const secondUserId = crypto.randomUUID();
    const secondBudgetId = crypto.randomUUID();
    const userCascadeJobId = crypto.randomUUID();
    await isolated`insert into users (id, email) values (${secondUserId}, ${`jobs-${secondUserId}@test.local`})`;
    await isolated`insert into budgets (id, user_id, name, currency) values (${secondBudgetId}, ${secondUserId}, 'User cascade', 'EUR')`;
    await isolated`insert into import_jobs
      (id, client_id, user_id, budget_id, provider, model, locale, tier, epoch, request_hash, status, phase, expires_at)
      values (${userCascadeJobId}, 'client-2', ${secondUserId}, ${secondBudgetId}, 'openai', 'gpt-test', 'pl-PL', 'plain', 0, ${"c".repeat(64)}, 'queued', 'queued', now() + interval '7 days')`;
    await isolated`insert into import_job_images (job_id, position, mime_type, sha256, byte_length, content)
      values (${userCascadeJobId}, 0, 'image/jpeg', ${"d".repeat(64)}, 2, ${new Uint8Array([4, 5])})`;
    await isolated`delete from users where id = ${secondUserId}`;
    const [afterUserDelete] = await isolated<{ jobs: number; images: number }[]>`
      select (select count(*)::int from import_jobs where id = ${userCascadeJobId}) as jobs,
             (select count(*)::int from import_job_images where job_id = ${userCascadeJobId}) as images`;

    const constraintUserId = crypto.randomUUID();
    const constraintBudgetId = crypto.randomUUID();
    const constrainedJobId = crypto.randomUUID();
    await isolated`insert into users (id, email) values (${constraintUserId}, ${`jobs-${constraintUserId}@test.local`})`;
    await isolated`insert into budgets (id, user_id, name, currency) values (${constraintBudgetId}, ${constraintUserId}, 'Constraints', 'EUR')`;
    await isolated`insert into import_jobs
      (id, client_id, user_id, budget_id, provider, model, locale, tier, epoch, request_hash, status, phase, expires_at)
      values (${constrainedJobId}, 'client-3', ${constraintUserId}, ${constraintBudgetId}, 'enveo', 'gpt-test', 'en', 'plain', 0, ${"e".repeat(64)}, 'queued', 'queued', now() + interval '7 days')`;
    await isolated`insert into import_job_images (job_id, position, mime_type, sha256, byte_length, content)
      values (${constrainedJobId}, 0, 'image/png', ${"f".repeat(64)}, 1, ${new Uint8Array([9])})`;

    const duplicateUserJobRejected = await rejected(
      () => isolated!`insert into import_jobs
      (id, client_id, user_id, budget_id, provider, model, locale, tier, epoch, request_hash, status, phase, expires_at)
      values (${constrainedJobId}, 'another-client', ${constraintUserId}, ${constraintBudgetId}, 'enveo', 'gpt-test', 'en', 'plain', 0, ${"1".repeat(64)}, 'queued', 'queued', now() + interval '7 days')`,
    );
    const duplicateImagePositionRejected = await rejected(
      () => isolated!`insert into import_job_images
      (job_id, position, mime_type, sha256, byte_length, content) values (${constrainedJobId}, 0, 'image/png', ${"2".repeat(64)}, 1, ${new Uint8Array([8])})`,
    );
    const invalidStatusRejected = await rejected(() => isolated!`update import_jobs set status = 'unknown' where id = ${constrainedJobId}`);
    const invalidPhaseRejected = await rejected(() => isolated!`update import_jobs set phase = 'halfway' where id = ${constrainedJobId}`);
    const invalidProviderRejected = await rejected(() => isolated!`update import_jobs set provider = 'rules' where id = ${constrainedJobId}`);
    const invalidTierRejected = await rejected(() => isolated!`update import_jobs set tier = 'server' where id = ${constrainedJobId}`);
    const negativeEpochRejected = await rejected(() => isolated!`update import_jobs set epoch = -1 where id = ${constrainedJobId}`);
    const negativeCountersRejected = await rejected(
      () => isolated!`update import_jobs set attempt = -1, proposal_count = -1, applied_count = -1, skipped_count = -1 where id = ${constrainedJobId}`,
    );
    const readyWithImagesRejected = await rejected(() => isolated!`update import_jobs set status = 'ready', phase = 'ready' where id = ${constrainedJobId}`);
    const [triggerCount] = await isolated<{ count: number }[]>`
      select count(*)::int as count
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_proc p on p.oid = t.tgfoid
       where c.relname in ('import_jobs', 'import_job_images') and p.proname = 'log_change'`;

    // A job created before chunking, still waiting for cycle one with seven retained
    // screenshots, must resume on the chunked worker after 0027 without a re-upload.
    const legacyJobId = crypto.randomUUID();
    const checkpointedJobId = crypto.randomUUID();
    for (const [id, client] of [
      [legacyJobId, "client-legacy"],
      [checkpointedJobId, "client-checkpointed"],
    ] as const) {
      await isolated`insert into import_jobs
        (id, client_id, user_id, budget_id, provider, model, locale, tier, epoch, request_hash, status, phase, expires_at)
        values (${id}, ${client}, ${constraintUserId}, ${constraintBudgetId}, 'enveo', 'gpt-test', 'en', 'plain', 0, ${"7".repeat(64)}, 'failed', 'retry_scheduled', now() + interval '7 days')`;
    }
    await isolated`update import_jobs set error_code = 'network', retry_at = now() where id in (${legacyJobId}, ${checkpointedJobId})`;
    for (let position = 0; position < 7; position += 1) {
      await isolated`insert into import_job_images (job_id, position, mime_type, sha256, byte_length, content)
        values (${legacyJobId}, ${position}, 'image/png', ${"8".repeat(64)}, 1, ${new Uint8Array([position])})`;
    }
    await isolated.unsafe("update import_jobs set extraction = $1::jsonb where id = $2", [JSON.stringify({ rows: [], proposals: [] }), checkpointedJobId]);
    await applyMigration(isolated, `${migrationsDir}/0027_import_job_chunks.sql`);
    const [backfill] = await isolated<
      { legacyChunks: string; legacyTotal: number; constrainedChunks: number; checkpointedChunks: number; checkpointedTotal: number }[]
    >`
      select (select string_agg(chunk_index || ':' || image_start || '-' || image_end || ':' || status, '|' order by chunk_index)
                from import_job_chunks where job_id = ${legacyJobId}) as "legacyChunks",
             (select screenshot_total from import_jobs where id = ${legacyJobId}) as "legacyTotal",
             (select count(*)::int from import_job_chunks where job_id = ${constrainedJobId}) as "constrainedChunks",
             (select count(*)::int from import_job_chunks where job_id = ${checkpointedJobId}) as "checkpointedChunks",
             (select screenshot_total from import_jobs where id = ${checkpointedJobId}) as "checkpointedTotal"`;

    await emitChildResult(SENTINEL, {
      foreignKeys: {
        accountDeleteClearedSelection: afterAccountDelete?.accountId === null,
        budgetDeleteRemovedJobAndImages: afterBudgetDelete?.jobs === 0 && afterBudgetDelete.images === 0,
        userDeleteRemovedJobAndImages: afterUserDelete?.jobs === 0 && afterUserDelete.images === 0,
      },
      constraints: {
        duplicateUserJobRejected,
        duplicateImagePositionRejected,
        invalidStatusRejected,
        invalidPhaseRejected,
        invalidProviderRejected,
        invalidTierRejected,
        negativeEpochRejected,
        negativeCountersRejected,
      },
      readyWithImagesRejected,
      changeTriggerCount: triggerCount?.count ?? -1,
      chunkBackfill: {
        legacyWindowsCreated: backfill?.legacyChunks === "0:0-6:pending|1:6-7:pending",
        screenshotTotalsFilled: backfill?.legacyTotal === 7 && backfill.constrainedChunks === 1,
        checkpointedJobUntouched: backfill?.checkpointedChunks === 0 && backfill.checkpointedTotal === 0,
      },
    } satisfies ImportJobsMigrationOutput);
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
