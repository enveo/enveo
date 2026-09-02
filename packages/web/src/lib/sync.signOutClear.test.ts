import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import {
  __resetAccountStorageOperationsForTests,
  awaitAccountStorageWritesQuiescent,
  configureAccountStorageGenerationFence,
  runAccountStorageWrite,
} from "./accountStorageOperations";
import { __resetStorageForTests, clearLocalDataForSignOut, idbGet, idbPut } from "./idb";
import { importJobStorage } from "./importJobStorage";
import { __resetPersistForTests, configurePersistWriteGate } from "./persist";
import { __resetSignOutBarrierForTests, activateSignOutAttempt, createSignOutPermit, markLocalCleared, releaseSignOutAttempt } from "./signOutBarrier";
import { createRegistryWriteGate, createSignOutCoordinator, createSignOutRegistry, type StorageLike } from "./signOutCoordination";

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).indexedDB = new IDBFactory();
  __resetStorageForTests();
  __resetAccountStorageOperationsForTests();
  __resetPersistForTests();
  __resetSignOutBarrierForTests();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).indexedDB;
  __resetStorageForTests();
  __resetAccountStorageOperationsForTests();
  __resetPersistForTests();
  __resetSignOutBarrierForTests();
});

describe("coordinated explicit-sign-out clear", () => {
  it("runs the actual clearLocalAccountData persistence chain without deadlocking", async () => {
    const storage = new MemoryStorage();
    const ids = ["generation-a", "source-a", "attempt-a", "generation-b"];
    const registry = createSignOutRegistry({ storage, now: () => 1_000, randomId: () => ids.shift()!, ttlMs: 1_000 });
    const gate = createRegistryWriteGate(registry);
    configureAccountStorageGenerationFence({ isCurrent: () => registry.isPageGenerationCurrent() });
    configurePersistWriteGate(gate);
    const coordinator = createSignOutCoordinator({
      registry,
      gate,
      barrier: {
        activate: activateSignOutAttempt,
        release: releaseSignOutAttempt,
        createPermit: createSignOutPermit,
        markLocalCleared,
      },
      send: () => {},
      quiesceCycle: async () => {},
      quiesceServerWrites: async () => {},
      quiesceAccountWrites: awaitAccountStorageWritesQuiescent,
      drainPersistence: async () => {},
      waitForTimeout: () => new Promise<void>(() => {}),
    });
    await idbPut("meta", "must-be-cleared", "clear-chain-probe");
    const originalDigest = crypto.subtle.digest;
    let resolveDigest!: (value: ArrayBuffer) => void;
    const pendingDigest = new Promise<ArrayBuffer>((resolve) => {
      resolveDigest = resolve;
    });
    crypto.subtle.digest = (() => pendingDigest) as typeof crypto.subtle.digest;
    const lateDraft = importJobStorage.createDraft(
      { ownerId: "owner", budgetId: "budget" },
      {
        id: "draft",
        ownerId: "owner",
        budgetId: "budget",
        accountId: "account",
        locale: "en",
        images: ["data:image/png;base64,c2NyZWVuc2hvdA=="],
      },
    );
    let releaseWrite!: () => void;
    const deferredWrite = runAccountStorageWrite(
      () =>
        new Promise<void>((resolve) => {
          releaseWrite = resolve;
        }),
    );

    let leaseReady = false;
    const pendingLease = coordinator.begin().then((lease) => {
      leaseReady = true;
      return lease;
    });
    await Promise.resolve();
    expect(leaseReady).toBe(false);
    releaseWrite();
    await deferredWrite;
    try {
      const lease = await pendingLease;
      coordinator.markServerSucceeded(lease);
      await coordinator.runLocalClear(lease, () => clearLocalDataForSignOut(lease.permit));

      resolveDigest(new ArrayBuffer(32));
      await expect(lateDraft).rejects.toThrow("stale_account_storage_generation");
      expect(await importJobStorage.listDrafts({ ownerId: "owner", budgetId: "budget" })).toEqual([]);
      expect(await idbGet("meta", "clear-chain-probe")).toBeUndefined();
      expect(registry.isPageGenerationCurrent()).toBe(false);
      await expect(idbPut("meta", "must-not-reappear", "clear-chain-probe")).rejects.toThrow("stale_account_storage_generation");
    } finally {
      crypto.subtle.digest = originalDigest;
      resolveDigest(new ArrayBuffer(32));
      await lateDraft.catch(() => {});
    }
  });
});
