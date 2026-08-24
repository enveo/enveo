import { beforeAll, describe, expect, test } from "bun:test";
import { runChild } from "../api.test-support";
import { type ImportJobRoutesOutput, SENTINEL } from "./importJobs.db.test-child";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "";
if (TEST_URL && TEST_URL === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL — this suite writes to the DB.");
const CHILD = new URL("./importJobs.db.test-child.ts", import.meta.url).pathname;

describe.skipIf(!TEST_URL)("durable import job routes", () => {
  let output: ImportJobRoutesOutput;

  beforeAll(async () => {
    output = await runChild<ImportJobRoutesOutput>({ path: CHILD, testUrl: TEST_URL, sentinel: SENTINEL, cwd: new URL("../..", import.meta.url).pathname });
  }, 120_000);

  test("durably creates one idempotent job and snapshots authoritative preferences", () => {
    expect(output.creation).toEqual({ firstStatus: 202, replayStatus: 202, conflictStatus: 409, jobs: 1, images: 1, provider: "openai", model: "gpt-5.6-sol" });
  });

  test("writes no rows when budget, account, tier, or provider guards reject", () => {
    expect(output.guards).toEqual({ budgetStatus: 409, accountStatus: 400, tierStatus: 409, rulesStatus: 409, rejectedJobs: 0, rejectedImages: 0 });
  });

  test("scopes public reads and mutations to the authenticated owner", () => {
    expect(output.ownership).toEqual({
      foreignListHasJob: false,
      foreignGetStatus: 404,
      foreignCancelStatus: 404,
      foreignRetryStatus: 409,
      ownerCancelStatus: 200,
      ownerRetryStatus: 200,
    });
  });

  test("completes a ready job only under the current budget assertion", () => {
    expect(output.completion).toEqual({ notReadyStatus: 409, mismatchStatus: 409, readyStatus: 200, status: "completed", appliedCount: 2, skippedCount: 1 });
  });

  test("public responses exclude uploaded, lease, hash, extraction, and credential state", () => {
    expect(output.publicReadSafe).toBe(true);
  });
});
