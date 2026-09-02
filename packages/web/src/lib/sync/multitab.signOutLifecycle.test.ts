import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { __resetAccountStorageOperationsForTests, runAccountStorageWrite } from "../accountStorageOperations";
import * as e2ee from "../e2ee";
import { __resetStorageForTests, idbPut } from "../idb";
import * as persist from "../persist";
import { __resetSignOutBarrierForTests, isSignOutBlocking } from "../signOutBarrier";
import { createRegistryWriteGate, createSignOutCoordinator, createSignOutRegistry, type SignOutBarrierPort, type StorageLike } from "../signOutCoordination";
import { store } from "../store";
import { clearLocalAccountDataForSignOut } from "../sync";
import {
  __installSignOutCoordinatorForTests,
  __resetMultiTabForTests,
  beginSignOutCoordination,
  finishSignOutCoordination,
  installMultiTab,
  installSignOutPageLifecycle,
  markSignOutServerSucceeded,
  runCoordinatedSessionEnd,
} from "./multitab";

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

class FakePageLifecycle {
  readonly listeners = new Map<string, (event: { persisted: boolean }) => void>();
  addEventListener(type: string, listener: (event: { persisted: boolean }) => void): void {
    this.listeners.set(type, listener);
  }
  dispatch(type: "pagehide" | "pageshow", persisted = false): void {
    this.listeners.get(type)?.({ persisted });
  }
}

class FakeBarrier implements SignOutBarrierPort<object> {
  activate(): void {}
  release(): void {}
  createPermit(): object {
    return {};
  }
  markLocalCleared(): void {}
}

const EMPTY_LEDGER = { accounts: [], groups: [], envelopes: [], transactions: [], allocations: [], categories: [], places: [], budgets: [] };

beforeEach(() => {
  __resetMultiTabForTests();
  __resetSignOutBarrierForTests();
  persist.__resetPersistForTests();
  __resetAccountStorageOperationsForTests();
  __resetStorageForTests();
});

afterEach(() => {
  __resetMultiTabForTests();
  __resetSignOutBarrierForTests();
  persist.__resetPersistForTests();
  __resetAccountStorageOperationsForTests();
  __resetStorageForTests();
});

describe("sign-out coordinator page lifecycle", () => {
  it("keeps the page and account storage fail closed when coordinator installation cannot write shared storage", async () => {
    const storage = new MemoryStorage();
    storage.setItem = () => {
      throw new Error("quota");
    };

    __installSignOutCoordinatorForTests(storage);
    __installSignOutCoordinatorForTests(new MemoryStorage());

    expect(isSignOutBlocking()).toBe(true);
    await expect(idbPut("meta", "must-not-write", "key")).rejects.toThrow();
  });

  it("keeps persisted-page presence so a frozen required participant makes sign-out abort", async () => {
    const storage = new MemoryStorage();
    __installSignOutCoordinatorForTests(storage);
    const lifecycle = new FakePageLifecycle();
    installSignOutPageLifecycle(lifecycle);
    lifecycle.dispatch("pagehide", true);
    const peerRegistry = createSignOutRegistry({ storage });
    let expire!: () => void;
    const peer = createSignOutCoordinator({
      registry: peerRegistry,
      barrier: new FakeBarrier(),
      gate: createRegistryWriteGate(peerRegistry),
      send: () => {},
      quiesceCycle: async () => {},
      quiesceServerWrites: async () => {},
      quiesceAccountWrites: async () => {},
      drainPersistence: async () => {},
      waitForTimeout: () =>
        new Promise<void>((resolve) => {
          expire = resolve;
        }),
    });

    const pending = peer.begin();
    await Promise.resolve();
    expire();
    await expect(pending).rejects.toThrow("sign_out_coordination_failed");
  });

  it("keeps non-persisted unload presence until admitted work can no longer be overtaken", async () => {
    const storage = new MemoryStorage();
    __installSignOutCoordinatorForTests(storage);
    const lifecycle = new FakePageLifecycle();
    installSignOutPageLifecycle(lifecycle);
    let finish!: () => void;
    const inFlight = runAccountStorageWrite(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );

    lifecycle.dispatch("pagehide", false);
    const peer = createSignOutRegistry({ storage });
    const marker = peer.createAttempt();

    expect(marker.requiredSourceIds).toHaveLength(1);
    finish();
    await inFlight;
  });

  it("clears secrets and forces terminal reload when a frozen page missed rotation and broadcasts", async () => {
    const storage = new MemoryStorage();
    __installSignOutCoordinatorForTests(storage);
    const lifecycle = new FakePageLifecycle();
    let resumeWork!: () => void;
    const inFlight = runAccountStorageWrite(async () => {
      await new Promise<void>((resolve) => {
        resumeWork = resolve;
      });
      await idbPut("meta", "must-not-return", "frozen-continuation");
    });
    let reloads = 0;
    installSignOutPageLifecycle(lifecycle, () => {
      reloads++;
    });
    store.replace(EMPTY_LEDGER, 0, "budget");
    e2ee.setDek(new Uint8Array(32), 1);
    await persist.flushed();
    const peer = createSignOutRegistry({ storage });
    const marker = peer.createAttempt();
    peer.rotateGeneration(marker.attemptId);
    peer.removeAttempt(marker.attemptId);

    lifecycle.dispatch("pageshow", true);

    expect(reloads).toBe(1);
    expect(e2ee.getDek()).toBeNull();
    expect(store.getLedger()).toBeNull();
    resumeWork();
    await expect(inFlight).rejects.toThrow("stale_account_storage_generation");
  });

  it("admits only the coordinated attempt's own server-session termination while blocked", async () => {
    const storage = new MemoryStorage();
    __installSignOutCoordinatorForTests(storage);
    const lease = await beginSignOutCoordination();

    await expect(runCoordinatedSessionEnd(lease, async () => "ended")).resolves.toBe("ended");
  });

  it("emits the terminal peer reload only after coordinated clear rotates and finishes", async () => {
    const storage = new MemoryStorage();
    __installSignOutCoordinatorForTests(storage);
    installMultiTab();
    const received: string[] = [];
    const receiver = new BroadcastChannel("enveo-sync");
    receiver.onmessage = (event) => received.push((event.data as { type: string }).type);
    try {
      const lease = await beginSignOutCoordination();
      markSignOutServerSucceeded(lease);
      await clearLocalAccountDataForSignOut(lease);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(received).toEqual(["sign-out-start", "sign-out-clear-committed"]);

      finishSignOutCoordination(lease);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(received).toEqual(["sign-out-start", "sign-out-clear-committed", "sign-out-complete"]);
    } finally {
      receiver.close();
    }
  });
});
