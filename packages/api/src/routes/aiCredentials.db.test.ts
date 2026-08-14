import { beforeAll, describe, expect, test } from "bun:test";
import { runChild } from "../api.test-support";
import { type AiCredentialsRoutesOutput, SENTINEL } from "./aiCredentials.db.test-child";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "";
if (TEST_URL && TEST_URL === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL — this suite writes to the DB.");
const CHILD = new URL("./aiCredentials.db.test-child.ts", import.meta.url).pathname;

describe.skipIf(!TEST_URL)("plain BYOK credential routes", () => {
  let output: AiCredentialsRoutesOutput;

  beforeAll(async () => {
    output = await runChild<AiCredentialsRoutesOutput>({ path: CHILD, testUrl: TEST_URL, sentinel: SENTINEL, cwd: new URL("../..", import.meta.url).pathname });
  }, 120_000);

  test("save/status/test never return or store the submitted plaintext", () => {
    expect(output.lifecycle).toEqual({ saveStatus: 200, configured: true, testStatus: 200, probeSawKey: true, responseLeaked: false, databaseLeaked: false });
  });

  test("a swapped session is rejected before mutation or upstream work", () => {
    expect(output.mismatch).toEqual({ status: 409, error: "budget_mismatch", rowUnchanged: true, probeCallsUnchanged: true });
  });

  test("missing vault keys disable save/use but keep status and deletion available", () => {
    expect(output.unavailable).toEqual({ statusAvailable: false, statusReason: "vault_unavailable", saveStatus: 503, deleteStatus: 200 });
  });

  test("E2EE budgets are refused by the plain credential surface", () => {
    expect(output.tierStatus).toBe(409);
  });
});
