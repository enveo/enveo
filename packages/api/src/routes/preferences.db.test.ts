import { beforeAll, describe, expect, test } from "bun:test";
import { runChild } from "../api.test-support";
import { type PreferencesDbOutput, SENTINEL } from "./preferences.db.test-child";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "";
if (TEST_URL && TEST_URL === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL — this suite writes to the DB.");

const CHILD = new URL("./preferences.db.test-child.ts", import.meta.url).pathname;

describe.skipIf(!TEST_URL)("account preference persistence", () => {
  let output: PreferencesDbOutput;

  beforeAll(async () => {
    output = await runChild<PreferencesDbOutput>({ path: CHILD, testUrl: TEST_URL, sentinel: SENTINEL, cwd: new URL("../..", import.meta.url).pathname });
  }, 120_000);

  test("GET returns defaults without creating a row", () => {
    expect(output.defaults).toEqual({ responseIsDefault: true, rowWasNotCreated: true });
  });

  test("concurrent disjoint patches preserve both fields and increment revision twice", () => {
    expect(output.concurrent).toEqual({ lang: "pl", themeMode: "dark", accentTheme: "duet", revision: 3 });
  });

  test("a swapped session is rejected before any account row mutation", () => {
    expect(output.mismatch).toEqual({ status: 409, error: "budget_mismatch", claimedUserUnchanged: true, sessionUserRowAbsent: true });
  });
});
