import { beforeAll, describe, expect, test } from "bun:test";
import { runChild } from "../api.test-support";
import { type ImportJobWorkerDbOutput, SENTINEL } from "./worker.db.test-child";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "";
if (TEST_URL && TEST_URL === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL — this suite writes to the DB.");
const CHILD = new URL("./worker.db.test-child.ts", import.meta.url).pathname;

describe.skipIf(!TEST_URL)("database-backed import worker", () => {
  let output: ImportJobWorkerDbOutput;

  beforeAll(async () => {
    output = await runChild<ImportJobWorkerDbOutput>({
      path: CHILD,
      testUrl: TEST_URL,
      sentinel: SENTINEL,
      cwd: new URL("../..", import.meta.url).pathname,
    });
  }, 120_000);

  test("two workers execute one queued job exactly once without writing the ledger", () => {
    expect(output.concurrency).toEqual({ processors: 1, status: "ready", attempts: 1, ledgerRowsBefore: 0, ledgerRowsAfter: 0 });
  });

  test("a process exit leaves an expired lease reclaimable by a restarted worker", () => {
    expect(output.restart).toEqual({ crashClaimed: true, reclaimed: true, resumedWithoutImages: true, attempts: 2, status: "ready" });
  });

  test("successful extraction removes every stored screenshot before later phases", () => {
    expect(output.images).toEqual({ concurrentJobImages: 0, restartedJobImages: 0 });
  });

  test("three crashed leases fail retryably without a fourth provider call", () => {
    expect(output.exhausted).toEqual({ providerCalls: 3, fourthClaimRejected: true, attempts: 3, status: "failed", errorCode: "network" });
  });

  test("missing retry input terminally expires before provider dispatch", () => {
    expect(output.missingInput).toEqual({ providerCalls: 0, status: "failed", errorCode: "expired", retryAt: null });
  });

  test("account archival during an upstream boundary retains retry input without reclaim or another call", () => {
    expect(output.accountInvalidation).toEqual({
      providerCalls: 1,
      outcome: "failed",
      status: "failed",
      errorCode: "account_unavailable",
      images: 1,
      detailsCleared: false,
      reclaimed: false,
    });
  });
});
