import { readdirSync, readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import { assertThrowawayDb, emitChildResult } from "../api.test-support";
import * as schema from "../db/schema";
import { createImportJobRepository, ImportJobConflict } from "./repository";

export const SENTINEL = "__IMPORT_JOB_REPOSITORY_CHILD__";

export interface ImportJobRepositoryOutput {
  creation: {
    firstCreated: boolean;
    replayCreated: boolean;
    conflictRejected: boolean;
    failedImageRolledBack: boolean;
    storedImages: number;
    publicReadSafe: boolean;
    foreignUserCannotRead: boolean;
    listScopedAndSafe: boolean;
  };
  leasing: {
    concurrentClaimsDistinct: boolean;
    expiredLeaseReclaimedOnce: boolean;
    staleTokenRejected: boolean;
    currentTokenAccepted: boolean;
  };
  checkpoint: {
    extractionSaved: boolean;
    invalidExtractionRejected: boolean;
    imagesDeleted: boolean;
    readyBeforeExtractionRejected: boolean;
    repeatedExtractionRejected: boolean;
    wrongLeaseChangedNothing: boolean;
    phaseAdvanced: boolean;
    resultReady: boolean;
  };
  cancellationRace: {
    cancellationRequested: boolean;
    extractionRejected: boolean;
    readyRejected: boolean;
    sameLeaseFinished: boolean;
    cancelledStateCleared: boolean;
  };
  transitions: {
    retryScheduled: boolean;
    retryQueued: boolean;
    permanentFailureDeletedImages: boolean;
    completedCountsSaved: boolean;
  };
  cleanup: {
    retryImagesDeleted: boolean;
    terminalDetailsCleared: boolean;
    expiredJobsDeleted: boolean;
    reportedCounts: boolean;
  };
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

const emptyResult = { rows: [], proposals: [] };

async function main() {
  const testUrl = process.env.DATABASE_URL ?? "";
  assertThrowawayDb(testUrl);
  const postgres = (await import("postgres")).default;
  const admin = postgres(testUrl, { max: 1, onnotice: () => {} });
  const dbName = `enveo_import_job_repository_${crypto.randomUUID().replaceAll("-", "")}`;
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
    const db = drizzle(isolated, { schema });
    const repository = createImportJobRepository(db);
    const userId = crypto.randomUUID();
    const foreignUserId = crypto.randomUUID();
    const budgetId = crypto.randomUUID();
    const accountId = crypto.randomUUID();
    await isolated`insert into users (id, email) values
      (${userId}, ${`jobs-${userId}@test.local`}), (${foreignUserId}, ${`jobs-${foreignUserId}@test.local`})`;
    await isolated`insert into budgets (id, user_id, name, currency) values (${budgetId}, ${userId}, 'Repository', 'EUR')`;
    await isolated`insert into accounts (id, budget_id, name) values (${accountId}, ${budgetId}, 'Selected')`;

    const at = (value: string) => new Date(value);
    const createInput = (id = crypto.randomUUID()) => ({
      id,
      userId,
      budgetId,
      accountId,
      provider: { provider: "enveo" as const, model: "gpt-test" },
      locale: "pl-PL",
      tier: "plain" as const,
      epoch: 0,
      images: [
        { mimeType: "image/png", content: new Uint8Array([1, 2, 3]) },
        { mimeType: "image/jpeg", content: new Uint8Array([4, 5]) },
      ],
    });

    const createdId = crypto.randomUUID();
    const initialInput = createInput(createdId);
    const first = await repository.create(initialInput, at("2026-08-24T12:00:00.000Z"));
    const replay = await repository.create(initialInput, at("2026-08-24T12:01:00.000Z"));
    let conflictRejected = false;
    try {
      await repository.create({ ...initialInput, locale: "en-GB" }, at("2026-08-24T12:02:00.000Z"));
    } catch (error) {
      conflictRejected = error instanceof ImportJobConflict;
    }
    const invalidImageJobId = crypto.randomUUID();
    try {
      await repository.create(
        { ...createInput(invalidImageJobId), images: [{ mimeType: "image/png", content: new Uint8Array() }] },
        at("2026-08-24T12:02:30.000Z"),
      );
    } catch {
      // The image CHECK is expected to roll back the surrounding job insert.
    }
    const [invalidImageJob] = await isolated<{ count: number }[]>`select count(*)::int as count from import_jobs where id = ${invalidImageJobId}`;
    const [stored] = await isolated<{ count: number }[]>`select count(*)::int as count from import_job_images where job_id = ${createdId}`;
    const publicDetail = await repository.getForUser(userId, createdId);
    const publicKeys = publicDetail ? Object.keys(publicDetail) : [];
    const publicReadSafe =
      publicDetail !== null && !publicKeys.some((key) => ["images", "requestHash", "leaseOwner", "leaseToken", "leaseExpiresAt", "extraction"].includes(key));
    const ownerList = await repository.listForUser(userId);
    const foreignList = await repository.listForUser(foreignUserId);
    const listScopedAndSafe = ownerList.some((job) => job.id === createdId) && foreignList.length === 0 && !Object.hasOwn(ownerList[0] ?? {}, "result");
    await repository.requestCancel(userId, createdId, at("2026-08-24T12:03:00.000Z"));

    const claimIds = [crypto.randomUUID(), crypto.randomUUID()];
    for (const id of claimIds) await repository.create(createInput(id), at("2026-08-24T12:10:00.000Z"));
    const [claimA, claimB] = await Promise.all([
      repository.claimNext("worker-a", at("2026-08-24T12:11:00.000Z")),
      repository.claimNext("worker-b", at("2026-08-24T12:11:00.000Z")),
    ]);
    const concurrentClaimsDistinct = Boolean(claimA && claimB && claimA.id !== claimB.id);
    if (!claimA || !claimB) throw new Error("expected two concurrent claims");
    await repository.requestCancel(userId, claimA.id, at("2026-08-24T12:12:00.000Z"));
    await repository.requestCancel(userId, claimB.id, at("2026-08-24T12:12:00.000Z"));
    await repository.finishCancellation(claimA.id, claimA.leaseToken, at("2026-08-24T12:13:00.000Z"));
    await repository.finishCancellation(claimB.id, claimB.leaseToken, at("2026-08-24T12:13:00.000Z"));

    const expiringId = crypto.randomUUID();
    await repository.create(createInput(expiringId), at("2026-08-24T12:20:00.000Z"));
    const originalLease = await repository.claimNext("worker-old", at("2026-08-24T12:21:00.000Z"));
    if (!originalLease || originalLease.id !== expiringId) throw new Error("expected expiring job claim");
    const reclaimed = await Promise.all([
      repository.claimNext("worker-new-a", at("2026-08-24T12:30:00.000Z")),
      repository.claimNext("worker-new-b", at("2026-08-24T12:30:00.000Z")),
    ]);
    const reclaimedLeases = reclaimed.filter((lease) => lease?.id === expiringId);
    const expiredLeaseReclaimedOnce = reclaimedLeases.length === 1;
    const currentLease = reclaimedLeases[0];
    if (!currentLease) throw new Error("expected reclaimed lease");
    const staleTokenRejected = !(await repository.heartbeat(expiringId, originalLease.leaseToken, at("2026-08-24T12:30:01.000Z")));
    const currentTokenAccepted = await repository.heartbeat(expiringId, currentLease.leaseToken, at("2026-08-24T12:30:02.000Z"));
    await repository.failPermanently(expiringId, currentLease.leaseToken, "ai_timeout", at("2026-08-24T12:30:03.000Z"));

    const checkpointId = crypto.randomUUID();
    await repository.create(createInput(checkpointId), at("2026-08-24T13:00:00.000Z"));
    const checkpointLease = await repository.claimNext("worker-checkpoint", at("2026-08-24T13:01:00.000Z"));
    if (!checkpointLease || checkpointLease.id !== checkpointId) throw new Error("expected checkpoint job claim");
    const wrongLeaseChangedNothing = !(await repository.saveExtractionAndDeleteImages(
      checkpointId,
      crypto.randomUUID(),
      emptyResult,
      at("2026-08-24T13:02:00.000Z"),
    ));
    let invalidExtractionRejected = false;
    try {
      await repository.saveExtractionAndDeleteImages(checkpointId, checkpointLease.leaseToken, { rows: [] } as never, at("2026-08-24T13:02:30.000Z"));
    } catch {
      invalidExtractionRejected = true;
    }
    const readyBeforeExtractionRejected = !(await repository.saveReadyResult(
      checkpointId,
      checkpointLease.leaseToken,
      emptyResult,
      at("2026-08-24T13:02:45.000Z"),
    ));
    const extractionSaved = await repository.saveExtractionAndDeleteImages(
      checkpointId,
      checkpointLease.leaseToken,
      emptyResult,
      at("2026-08-24T13:03:00.000Z"),
    );
    const repeatedExtractionRejected = !(await repository.saveExtractionAndDeleteImages(
      checkpointId,
      checkpointLease.leaseToken,
      emptyResult,
      at("2026-08-24T13:03:15.000Z"),
    ));
    const [checkpointRow] = await isolated<{ extraction: unknown; imageCount: number }[]>`
      select extraction, (select count(*)::int from import_job_images where job_id = ${checkpointId}) as "imageCount"
        from import_jobs where id = ${checkpointId}`;
    const phaseAdvanced =
      (await repository.advancePhase(checkpointId, checkpointLease.leaseToken, "enriching", at("2026-08-24T13:03:30.000Z"))) &&
      (await repository.advancePhase(checkpointId, checkpointLease.leaseToken, "reconciling", at("2026-08-24T13:03:45.000Z")));
    const resultReady = await repository.saveReadyResult(checkpointId, checkpointLease.leaseToken, emptyResult, at("2026-08-24T13:04:00.000Z"));

    const cancelId = crypto.randomUUID();
    await repository.create(createInput(cancelId), at("2026-08-24T14:00:00.000Z"));
    const cancelLease = await repository.claimNext("worker-cancel", at("2026-08-24T14:01:00.000Z"));
    if (!cancelLease || cancelLease.id !== cancelId) throw new Error("expected cancellation job claim");
    await isolated.unsafe("update import_jobs set extraction = $1::jsonb, result = $1::jsonb where id = $2", [JSON.stringify(emptyResult), cancelId]);
    const cancelRequested = await repository.requestCancel(userId, cancelId, at("2026-08-24T14:02:00.000Z"));
    const cancelledExtractionRejected = !(await repository.saveExtractionAndDeleteImages(
      cancelId,
      cancelLease.leaseToken,
      emptyResult,
      at("2026-08-24T14:02:10.000Z"),
    ));
    const cancelledReadyRejected = !(await repository.saveReadyResult(cancelId, cancelLease.leaseToken, emptyResult, at("2026-08-24T14:02:20.000Z")));
    const cancellationFinished = await repository.finishCancellation(cancelId, cancelLease.leaseToken, at("2026-08-24T14:03:00.000Z"));
    const [afterCancellation] = await isolated<{ status: string; extraction: unknown; result: unknown; leaseToken: string | null; imageCount: number }[]>`
      select status, extraction, result, lease_token as "leaseToken",
             (select count(*)::int from import_job_images where job_id = ${cancelId}) as "imageCount"
        from import_jobs where id = ${cancelId}`;

    const retryId = crypto.randomUUID();
    await repository.create(createInput(retryId), at("2026-08-24T15:00:00.000Z"));
    const retryLease = await repository.claimNext("worker-retry", at("2026-08-24T15:01:00.000Z"));
    if (!retryLease || retryLease.id !== retryId) throw new Error("expected retry job claim");
    const retryScheduled = await repository.scheduleRetry(
      retryId,
      retryLease.leaseToken,
      "network",
      at("2026-08-24T16:00:00.000Z"),
      at("2026-08-24T15:02:00.000Z"),
    );
    const retried = await repository.retry(userId, retryId, at("2026-08-24T15:03:00.000Z"));
    await repository.requestCancel(userId, retryId, at("2026-08-24T15:04:00.000Z"));

    const permanentId = crypto.randomUUID();
    await repository.create(createInput(permanentId), at("2026-08-24T16:00:00.000Z"));
    const permanentLease = await repository.claimNext("worker-fail", at("2026-08-24T16:01:00.000Z"));
    if (!permanentLease || permanentLease.id !== permanentId) throw new Error("expected permanent failure job claim");
    await repository.failPermanently(permanentId, permanentLease.leaseToken, "malformed_model_response", at("2026-08-24T16:02:00.000Z"));
    const [permanentImages] = await isolated<{ count: number }[]>`select count(*)::int as count from import_job_images where job_id = ${permanentId}`;

    const completedId = crypto.randomUUID();
    await repository.create(createInput(completedId), at("2026-08-24T17:00:00.000Z"));
    const completedLease = await repository.claimNext("worker-complete", at("2026-08-24T17:01:00.000Z"));
    if (!completedLease || completedLease.id !== completedId) throw new Error("expected completed job claim");
    await repository.saveExtractionAndDeleteImages(completedId, completedLease.leaseToken, emptyResult, at("2026-08-24T17:02:00.000Z"));
    await repository.advancePhase(completedId, completedLease.leaseToken, "reconciling", at("2026-08-24T17:02:30.000Z"));
    await repository.saveReadyResult(completedId, completedLease.leaseToken, emptyResult, at("2026-08-24T17:03:00.000Z"));
    const completed = await repository.markCompleted(userId, completedId, 3, 1, at("2026-08-24T17:04:00.000Z"));
    await isolated.unsafe("update import_jobs set extraction = $1::jsonb, result = $1::jsonb where id = $2", [JSON.stringify(emptyResult), completedId]);

    const cleanupRetryId = crypto.randomUUID();
    await repository.create(createInput(cleanupRetryId), at("2026-08-20T10:00:00.000Z"));
    const cleanupRetryLease = await repository.claimNext("worker-cleanup", at("2026-08-20T10:01:00.000Z"));
    if (!cleanupRetryLease || cleanupRetryLease.id !== cleanupRetryId) throw new Error("expected cleanup retry job claim");
    await repository.scheduleRetry(cleanupRetryId, cleanupRetryLease.leaseToken, "network", at("2026-08-30T10:00:00.000Z"), at("2026-08-20T10:02:00.000Z"));
    const expiredId = crypto.randomUUID();
    await repository.create(createInput(expiredId), at("2026-08-10T10:00:00.000Z"));
    const cleanup = await repository.cleanupExpired(at("2026-08-24T18:00:00.000Z"));
    const [afterCleanup] = await isolated<{ retryImages: number; terminalDetails: number; expiredJobs: number }[]>`
      select
        (select count(*)::int from import_job_images where job_id = ${cleanupRetryId}) as "retryImages",
        (select count(*)::int from import_jobs where id = ${completedId} and extraction is null and result is null) as "terminalDetails",
        (select count(*)::int from import_jobs where id = ${expiredId}) as "expiredJobs"`;

    await emitChildResult(SENTINEL, {
      creation: {
        firstCreated: first.created,
        replayCreated: replay.created,
        conflictRejected,
        failedImageRolledBack: invalidImageJob?.count === 0,
        storedImages: stored?.count ?? -1,
        publicReadSafe,
        foreignUserCannotRead: (await repository.getForUser(foreignUserId, createdId)) === null,
        listScopedAndSafe,
      },
      leasing: { concurrentClaimsDistinct, expiredLeaseReclaimedOnce, staleTokenRejected, currentTokenAccepted },
      checkpoint: {
        extractionSaved: extractionSaved && checkpointRow?.extraction !== null,
        invalidExtractionRejected,
        imagesDeleted: checkpointRow?.imageCount === 0,
        readyBeforeExtractionRejected,
        repeatedExtractionRejected,
        wrongLeaseChangedNothing,
        phaseAdvanced,
        resultReady,
      },
      cancellationRace: {
        cancellationRequested: cancelRequested?.status === "running" && cancelRequested.cancelRequested,
        extractionRejected: cancelledExtractionRejected,
        readyRejected: cancelledReadyRejected,
        sameLeaseFinished: cancellationFinished,
        cancelledStateCleared:
          afterCancellation?.status === "cancelled" &&
          afterCancellation.extraction === null &&
          afterCancellation.result === null &&
          afterCancellation.leaseToken === null &&
          afterCancellation.imageCount === 0,
      },
      transitions: {
        retryScheduled,
        retryQueued: retried?.status === "queued",
        permanentFailureDeletedImages: permanentImages?.count === 0,
        completedCountsSaved: completed?.status === "completed" && completed.appliedCount === 3 && completed.skippedCount === 1,
      },
      cleanup: {
        retryImagesDeleted: afterCleanup?.retryImages === 0,
        terminalDetailsCleared: afterCleanup?.terminalDetails === 1,
        expiredJobsDeleted: afterCleanup?.expiredJobs === 0,
        reportedCounts: cleanup.imagesDeleted >= 2 && cleanup.detailsCleared >= 1 && cleanup.jobsDeleted >= 1,
      },
    } satisfies ImportJobRepositoryOutput);
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
