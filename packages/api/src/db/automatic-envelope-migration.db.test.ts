import { beforeAll, describe, expect, test } from "bun:test";
import { runChild } from "../api.test-support";
import { type AutomaticEnvelopeMigrationOutput, SENTINEL } from "./automatic-envelope-migration.db.test-child";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "";
if (TEST_URL && TEST_URL === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL — this suite writes to the DB.");

const CHILD = new URL("./automatic-envelope-migration.db.test-child.ts", import.meta.url).pathname;

describe.skipIf(!TEST_URL)("automatic envelope migration", () => {
  let output: AutomaticEnvelopeMigrationOutput;

  beforeAll(async () => {
    output = await runChild<AutomaticEnvelopeMigrationOutput>({
      path: CHILD,
      testUrl: TEST_URL,
      sentinel: SENTINEL,
      cwd: new URL("../..", import.meta.url).pathname,
    });
  }, 120_000);

  test("preserves existing rows and backfills the new nullable columns as null", () => {
    expect(output.preserved).toEqual({ accounts: true, transactions: true, allNewColumnsNull: true });
  });

  test("enforces envelope foreign keys and clears every automatic-envelope reference on delete", () => {
    expect(output.foreignKeys).toEqual({
      foreignAccountLinkRejected: true,
      foreignFlowRejected: true,
      envelopeDeleteClearedAllThreeReferences: true,
    });
  });
});
