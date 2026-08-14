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

  test("chat and screenshot extraction use the vaulted key without operator metering", () => {
    expect(output.workloads).toEqual({
      chatStatus: 200,
      chatContent: "byok-answer",
      importStatus: 200,
      importItems: 0,
      sentVaultKey: true,
      sentChosenModel: true,
    });
  });

  test("E2EE ciphertext can be created, read, replaced and deleted without exposing vault material", () => {
    expect(output.e2eeLifecycle).toEqual({
      saveStatus: 200,
      getStatus: 200,
      configured: true,
      returnedCiphertext: true,
      responseExposedVaultFields: false,
      storageShapeValid: true,
      replaceStatus: 200,
      deleteStatus: 200,
      deleted: true,
      cascadeDeleted: true,
    });
  });

  test("E2EE writes fail closed for stale epochs, swapped accounts, legacy formats and malformed bodies", () => {
    expect(output.e2eeGuards).toEqual({
      staleStatus: 409,
      staleUnchanged: true,
      concurrentStaleStatus: 409,
      concurrentStaleUnchanged: true,
      swappedStatus: 409,
      swappedError: "budget_mismatch",
      swappedUnchanged: true,
      legacyStatus: 409,
      legacyError: "e2ee_upgrade_required",
      plainTierStatus: 409,
      malformedStatus: 400,
      oversizedStatus: 400,
    });
  });
});
