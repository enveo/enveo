import { beforeAll, describe, expect, test } from "bun:test";
import { runChild } from "../api.test-support";
import { type ImportJobRepositoryOutput, SENTINEL } from "./repository.db.test-child";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "";
if (TEST_URL && TEST_URL === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL — this suite writes to the DB.");
const CHILD = new URL("./repository.db.test-child.ts", import.meta.url).pathname;

describe.skipIf(!TEST_URL)("import job repository", () => {
  let output: ImportJobRepositoryOutput;

  beforeAll(async () => {
    output = await runChild<ImportJobRepositoryOutput>({
      path: CHILD,
      testUrl: TEST_URL,
      sentinel: SENTINEL,
      cwd: new URL("../..", import.meta.url).pathname,
    });
  }, 120_000);

  test("creates one atomic job for an idempotent request and rejects conflicting reuse", () => {
    expect(output.creation).toEqual({
      firstCreated: true,
      replayCreated: false,
      conflictRejected: true,
      failedImageRolledBack: true,
      storedImages: 2,
      publicReadSafe: true,
      foreignUserCannotRead: true,
      listScopedAndSafe: true,
    });
  });

  test("claims queued work exclusively and fences stale lease holders", () => {
    expect(output.leasing).toEqual({
      concurrentClaimsDistinct: true,
      expiredLeaseReclaimedOnce: true,
      staleTokenRejected: true,
      currentTokenAccepted: true,
    });
  });

  test("checkpoints extraction and removes image bytes in one transaction", () => {
    expect(output.checkpoint).toEqual({
      extractionSaved: true,
      invalidExtractionRejected: true,
      imagesDeleted: true,
      readyBeforeExtractionRejected: true,
      repeatedExtractionRejected: true,
      wrongLeaseChangedNothing: true,
      resultReady: true,
    });
  });

  test("lets cancellation fence worker checkpoints while preserving cleanup authority", () => {
    expect(output.cancellationRace).toEqual({
      cancellationRequested: true,
      extractionRejected: true,
      readyRejected: true,
      sameLeaseFinished: true,
      cancelledStateCleared: true,
    });
  });

  test("persists cancellation, retry, failure, and completion transitions", () => {
    expect(output.transitions).toEqual({
      retryScheduled: true,
      retryQueued: true,
      permanentFailureDeletedImages: true,
      completedCountsSaved: true,
    });
  });

  test("applies bounded retention without exposing or logging payloads", () => {
    expect(output.cleanup).toEqual({
      retryImagesDeleted: true,
      terminalDetailsCleared: true,
      expiredJobsDeleted: true,
      reportedCounts: true,
    });
  });
});
