import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { __resetAccountStorageOperationsForTests } from "./accountStorageOperations";
import { __resetStorageForTests, idbPut } from "./idb";
import { importJobStorage } from "./importJobStorage";
import { __resetSignOutBarrierForTests, activateSignOutAttempt } from "./signOutBarrier";

const scope = { ownerId: "owner", budgetId: "budget" };

beforeEach(() => {
  (globalThis as Record<string, unknown>).indexedDB = new IDBFactory();
  __resetStorageForTests();
  __resetSignOutBarrierForTests();
  __resetAccountStorageOperationsForTests();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).indexedDB;
  __resetStorageForTests();
  __resetSignOutBarrierForTests();
  __resetAccountStorageOperationsForTests();
});

describe("IndexedDB account-storage barrier", () => {
  it("blocks both generic metadata and import progress writers during sign-out", async () => {
    activateSignOutAttempt("attempt", "source", "remote");

    await expect(idbPut("meta", "value", "key")).rejects.toThrow("sign_out_in_progress");
    await expect(
      importJobStorage.putApplyProgress(scope, "job", {
        appliedRowIds: ["row"],
        skippedRowIds: [],
      }),
    ).rejects.toThrow("sign_out_in_progress");
  });

  it("keeps every public IndexedDB mutator behind the central account-write admission", async () => {
    const source = await Bun.file(new URL("./idb.ts", import.meta.url)).text();
    const directBackendMutations = [...source.matchAll(/return activeBackend\(\)\.(\w+)\(/g)]
      .map((match) => match[1])
      .filter((method) => method !== "importTransactionProof");
    expect(directBackendMutations).toEqual([]);
    expect(source).toContain("this.dbPromise = runAccountStorageWrite(async () =>");
    expect(source.match(/runAccountStorageWrite\(/g)?.length).toBe(18);
  });
});
