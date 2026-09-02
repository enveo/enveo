import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  __resetAccountStorageOperationsForTests,
  awaitAccountStorageWritesQuiescent,
  configureAccountStorageGenerationFence,
  configurePersistenceAccountStorageDrain,
  runAccountStorageWrite,
  runPersistenceAccountStorageWrite,
} from "./accountStorageOperations";
import { __resetSignOutBarrierForTests, activateSignOutAttempt } from "./signOutBarrier";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  __resetSignOutBarrierForTests();
  __resetAccountStorageOperationsForTests();
});

afterEach(() => {
  __resetSignOutBarrierForTests();
  __resetAccountStorageOperationsForTests();
});

describe("account-storage write barrier", () => {
  it("keeps a pre-barrier write registered until its deferred storage mutation finishes", async () => {
    const beforeMutation = deferred();
    const write = runAccountStorageWrite(async () => {
      await beforeMutation.promise;
      return "stored";
    });
    activateSignOutAttempt("attempt", "source", "remote");
    let quiescent = false;
    const waiting = awaitAccountStorageWritesQuiescent().then(() => {
      quiescent = true;
    });

    await Promise.resolve();
    expect(quiescent).toBe(false);
    beforeMutation.resolve();
    await expect(write).resolves.toBe("stored");
    await waiting;
    expect(quiescent).toBe(true);
  });

  it("rejects writes admitted after blocking and continuations from an old generation", async () => {
    const pageGeneration = "generation-a";
    let currentGeneration = pageGeneration;
    configureAccountStorageGenerationFence({
      isCurrent: () => pageGeneration === currentGeneration,
    });

    await expect(runAccountStorageWrite(async () => "first")).resolves.toBe("first");
    currentGeneration = "generation-b";
    await expect(runAccountStorageWrite(async () => "stale")).rejects.toThrow("stale_account_storage_generation");

    __resetAccountStorageOperationsForTests();
    activateSignOutAttempt("attempt", "source", "remote");
    await expect(runAccountStorageWrite(async () => "blocked")).rejects.toThrow("sign_out_in_progress");
  });

  it("admits only persistence's explicit bounded drain while sign-out is blocking", async () => {
    activateSignOutAttempt("attempt", "source", "remote");
    configurePersistenceAccountStorageDrain(() => true);

    await expect(runPersistenceAccountStorageWrite(() => runAccountStorageWrite(async () => "persisted"))).resolves.toBe("persisted");
    await expect(runAccountStorageWrite(async () => "direct")).rejects.toThrow("sign_out_in_progress");

    configurePersistenceAccountStorageDrain(() => false);
    expect(() => runPersistenceAccountStorageWrite(() => runAccountStorageWrite(async () => "late"))).toThrow("sign_out_in_progress");
  });
});
