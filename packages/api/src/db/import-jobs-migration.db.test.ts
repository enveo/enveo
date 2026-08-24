import { beforeAll, describe, expect, test } from "bun:test";
import { runChild } from "../api.test-support";
import { type ImportJobsMigrationOutput, SENTINEL } from "./import-jobs-migration.db.test-child";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "";
if (TEST_URL && TEST_URL === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL — this suite writes to the DB.");
const CHILD = new URL("./import-jobs-migration.db.test-child.ts", import.meta.url).pathname;

describe.skipIf(!TEST_URL)("import jobs migration", () => {
  let output: ImportJobsMigrationOutput;

  beforeAll(async () => {
    output = await runChild<ImportJobsMigrationOutput>({
      path: CHILD,
      testUrl: TEST_URL,
      sentinel: SENTINEL,
      cwd: new URL("../..", import.meta.url).pathname,
    });
  }, 120_000);

  test("keeps jobs tenant-owned while cascading disposable data", () => {
    expect(output.foreignKeys).toEqual({
      accountDeleteClearedSelection: true,
      budgetDeleteRemovedJobAndImages: true,
      userDeleteRemovedJobAndImages: true,
    });
  });

  test("rejects duplicate identities, image positions, and unsupported snapshots", () => {
    expect(output.constraints).toEqual({
      duplicateUserJobRejected: true,
      duplicateImagePositionRejected: true,
      invalidStatusRejected: true,
      invalidPhaseRejected: true,
      invalidProviderRejected: true,
      invalidTierRejected: true,
      negativeEpochRejected: true,
      negativeCountersRejected: true,
    });
  });

  test("never allows a ready job to retain uploaded image bytes", () => {
    expect(output.readyWithImagesRejected).toBe(true);
  });

  test("does not attach ledger change-log triggers to operational job tables", () => {
    expect(output.changeTriggerCount).toBe(0);
  });
});
