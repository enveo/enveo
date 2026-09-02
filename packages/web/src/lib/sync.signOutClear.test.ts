import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { __resetStorageForTests, idbGet, idbPut } from "./idb";
import { __resetPersistForTests, configurePersistWriteGate } from "./persist";
import { __resetSignOutBarrierForTests, activateSignOutAttempt, createSignOutPermit, markLocalCleared, releaseSignOutAttempt } from "./signOutBarrier";
import { createRegistryWriteGate, createSignOutCoordinator, createSignOutRegistry, type StorageLike } from "./signOutCoordination";
import { clearLocalAccountData } from "./sync";

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
  __resetPersistForTests();
  __resetSignOutBarrierForTests();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).indexedDB;
  __resetStorageForTests();
  __resetPersistForTests();
  __resetSignOutBarrierForTests();
});

describe("coordinated explicit-sign-out clear", () => {
  it("runs the actual clearLocalAccountData persistence chain without deadlocking", async () => {
    const storage = new MemoryStorage();
    const ids = ["generation-a", "source-a", "attempt-a", "generation-b"];
    const registry = createSignOutRegistry({ storage, now: () => 1_000, randomId: () => ids.shift()!, ttlMs: 1_000 });
    const gate = createRegistryWriteGate(registry);
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
      drainPersistence: async () => {},
      waitForTimeout: () => new Promise<void>(() => {}),
    });
    await idbPut("meta", "must-be-cleared", "clear-chain-probe");

    const lease = await coordinator.begin();
    coordinator.markServerSucceeded(lease);
    await coordinator.runLocalClear(lease, clearLocalAccountData);

    expect(await idbGet("meta", "clear-chain-probe")).toBeUndefined();
    expect(registry.isPageGenerationCurrent()).toBe(false);
  });
});
