import { beforeAll, describe, expect, test } from "bun:test";
import { runChild } from "../api.test-support";
import { type CredentialRepositoryOutput, SENTINEL } from "./repository.db.test-child";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "";
if (TEST_URL && TEST_URL === process.env.DATABASE_URL) throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL — this suite writes to the DB.");
const CHILD = new URL("./repository.db.test-child.ts", import.meta.url).pathname;

describe.skipIf(!TEST_URL)("AI credential repository", () => {
  let output: CredentialRepositoryOutput;

  beforeAll(async () => {
    output = await runChild<CredentialRepositoryOutput>({
      path: CHILD,
      testUrl: TEST_URL,
      sentinel: SENTINEL,
      cwd: new URL("../..", import.meta.url).pathname,
    });
  }, 120_000);

  test("creates, opens, atomically replaces, and deletes a vaulted credential", () => {
    expect(output.lifecycle).toEqual({
      initiallyConfigured: false,
      createdConfigured: true,
      createdOpened: true,
      rollbackKeptPrevious: true,
      deletedConfigured: false,
    });
  });

  test("serializes concurrent replacements on the budget row", () => {
    expect(output.concurrent).toEqual({ finalIsOneWinner: true, recordVersion: 3 });
  });

  test("lazily rewraps only the record DEK under the active master key", () => {
    expect(output.rotation).toEqual({ opened: true, masterKeyId: "master-new", ciphertextUnchanged: true, recordVersionUnchanged: true });
  });

  test("releases the budget row lock before a worker invokes slow credential use", () => {
    expect(output.workerCallback).toEqual({ opened: true, budgetWriteCompletedInsideCallback: true });
  });

  test("budget deletion cascades the credential", () => {
    expect(output.cascadeDeleted).toBe(true);
  });
});
