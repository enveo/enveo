import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { __resetAccountStorageOperationsForTests } from "../accountStorageOperations";
import { __resetStorageForTests, idbPut } from "../idb";
import { __resetPersistForTests } from "../persist";
import { __resetSignOutBarrierForTests, isSignOutBlocking } from "../signOutBarrier";
import { createSignOutRegistry, type StorageLike } from "../signOutCoordination";
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
  readonly listeners = new Map<string, () => void>();
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener);
  }
  dispatch(type: "pagehide" | "pageshow"): void {
    this.listeners.get(type)?.();
  }
}

beforeEach(() => {
  __resetMultiTabForTests();
  __resetSignOutBarrierForTests();
  __resetPersistForTests();
  __resetAccountStorageOperationsForTests();
  __resetStorageForTests();
});

afterEach(() => {
  __resetMultiTabForTests();
  __resetSignOutBarrierForTests();
  __resetPersistForTests();
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

  it("re-registers and rescans synchronously on pageshow after reusable pagehide cleanup", () => {
    const storage = new MemoryStorage();
    __installSignOutCoordinatorForTests(storage);
    const lifecycle = new FakePageLifecycle();
    installSignOutPageLifecycle(lifecycle);
    lifecycle.dispatch("pagehide");
    const peer = createSignOutRegistry({ storage });
    peer.createAttempt();

    lifecycle.dispatch("pageshow");
    expect(isSignOutBlocking()).toBe(true);

    lifecycle.dispatch("pagehide");
    lifecycle.dispatch("pageshow");
    expect(isSignOutBlocking()).toBe(true);
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
