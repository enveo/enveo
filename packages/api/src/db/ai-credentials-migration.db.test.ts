import { beforeAll, describe, expect, test } from "bun:test";
import { runChild } from "../api.test-support";
import { type AiCredentialsMigrationOutput, SENTINEL } from "./ai-credentials-migration.db.test-child";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "";
if (TEST_URL && TEST_URL === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL — this suite writes to the DB.");

const CHILD = new URL("./ai-credentials-migration.db.test-child.ts", import.meta.url).pathname;

describe.skipIf(!TEST_URL)("AI credentials migration", () => {
  let output: AiCredentialsMigrationOutput;

  beforeAll(async () => {
    output = await runChild<AiCredentialsMigrationOutput>({
      path: CHILD,
      testUrl: TEST_URL,
      sentinel: SENTINEL,
      cwd: new URL("../..", import.meta.url).pathname,
    });
  }, 120_000);

  test("preserves a populated budget and accepts both protected storage shapes", () => {
    expect(output.preservation).toEqual({ budgetSurvived: true, serverVaultAccepted: true, e2eeCiphertextAccepted: true });
  });

  test("rejects plaintext/mixed/unsupported credential rows", () => {
    expect(output.constraints).toEqual({
      mixedServerRowRejected: true,
      mixedE2eeRowRejected: true,
      unsupportedProviderRejected: true,
      unsupportedFramingRejected: true,
      emptyCiphertextRejected: true,
      invalidRecordVersionRejected: true,
    });
  });

  test("deleting a budget cascades its protected credential", () => {
    expect(output.cascadeDeleted).toBe(true);
  });
});
