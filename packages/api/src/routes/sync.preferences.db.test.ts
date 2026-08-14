import { beforeAll, describe, expect, test } from "bun:test";
import { runChild } from "../api.test-support";
import { SENTINEL, type SyncPreferencesOutput } from "./sync.preferences.db.test-child";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "";
if (TEST_URL && TEST_URL === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL — this suite writes to the DB.");

const CHILD = new URL("./sync.preferences.db.test-child.ts", import.meta.url).pathname;

describe.skipIf(!TEST_URL)("plain sync budget preferences", () => {
  let output: SyncPreferencesOutput;

  beforeAll(async () => {
    output = await runChild<SyncPreferencesOutput>({ path: CHILD, testUrl: TEST_URL, sentinel: SENTINEL, cwd: new URL("../..", import.meta.url).pathname });
  }, 120_000);

  test("NULL snapshots become defaults and disjoint operations preserve both fields", () => {
    expect(output.sync).toEqual({ nullMappedToDefaults: true, firstApplied: true, secondApplied: true, bothFieldsPreserved: true });
  });

  test("replay is idempotent and malformed or foreign patches are rejected", () => {
    expect(output.guards).toEqual({ replayDuplicate: true, emptyRejected: true, foreignRejected: true, rejectedDidNotMutate: true });
  });

  test("the pull journal exposes the complete reconciled budget row", () => {
    expect(output.pullCarriesCompletePreferences).toBe(true);
  });

  test("restore round-trips current preferences and defaults old backups", () => {
    expect(output.restore).toEqual({ currentRoundTrips: true, oldBackupGetsDefaults: true });
  });
});
