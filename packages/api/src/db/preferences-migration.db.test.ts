import { beforeAll, describe, expect, test } from "bun:test";
import { runChild } from "../api.test-support";
import { type PreferencesMigrationOutput, SENTINEL } from "./preferences-migration.db.test-child";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "";
if (TEST_URL && TEST_URL === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL — this suite writes to the DB.");

const CHILD = new URL("./preferences-migration.db.test-child.ts", import.meta.url).pathname;

describe.skipIf(!TEST_URL)("preferences migration", () => {
  let output: PreferencesMigrationOutput;

  beforeAll(async () => {
    output = await runChild<PreferencesMigrationOutput>({
      path: CHILD,
      testUrl: TEST_URL,
      sentinel: SENTINEL,
      cwd: new URL("../..", import.meta.url).pathname,
    });
  }, 120_000);

  test("preserves representative plain and E2EE budgets without plaintext backfill", () => {
    expect(output.preservation).toEqual({ plainSurvived: true, e2eeSurvived: true, bothPreferencesNull: true });
  });

  test("enforces account preference values and non-negative revisions", () => {
    expect(output.constraints).toEqual({ invalidLangRejected: true, invalidThemeRejected: true, invalidAccentRejected: true, negativeRevisionRejected: true });
  });

  test("deleting a user cascades account preferences and budgets", () => {
    expect(output.cascade).toEqual({ accountPreferencesDeleted: true, budgetsDeleted: true });
  });
});
