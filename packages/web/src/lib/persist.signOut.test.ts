import { beforeEach, describe, expect, it } from "bun:test";
import { __resetPersistForTests, configurePersistWriteGate, enqueue, flushed } from "./persist";
import { createRegistryWriteGate, createSignOutRegistry, type StorageLike } from "./signOutCoordination";

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  __resetPersistForTests();
});

describe("sign-out persistence fence", () => {
  it("holds a queued write until a cancelled attempt releases it", async () => {
    const permission = deferred<"run" | "skip">();
    const writes: string[] = [];
    configurePersistWriteGate({ beforeWrite: () => permission.promise });

    const queued = enqueue(async () => {
      writes.push("persisted");
    });
    await Promise.resolve();
    expect(writes).toEqual([]);

    permission.resolve("run");
    await queued;
    expect(writes).toEqual(["persisted"]);
  });

  it("skips stale queued work after durable clear rotates the generation", async () => {
    const permission = deferred<"run" | "skip">();
    const writes: string[] = [];
    configurePersistWriteGate({ beforeWrite: () => permission.promise });

    const queued = enqueue(async () => {
      writes.push("repopulated");
    });
    permission.resolve("skip");

    await queued;
    await flushed();
    expect(writes).toEqual([]);
  });

  it("drains a required peer's pre-quiescence task, then holds later persistence until matching cancellation", async () => {
    const storage = new MemoryStorage();
    const ids = ["generation", "source-a", "source-b", "attempt-a"];
    const options = { storage, now: () => 1_000, randomId: () => ids.shift()!, ttlMs: 100 };
    const initiator = createSignOutRegistry(options);
    const peer = createSignOutRegistry(options);
    initiator.refreshPresence();
    peer.refreshPresence();
    const marker = initiator.createAttempt();
    const gate = createRegistryWriteGate(peer, 60_000);
    configurePersistWriteGate(gate);
    const writes: string[] = [];

    const preQuiescence = enqueue(async () => {
      writes.push("pre-quiescence");
    });
    await Promise.resolve();
    expect(writes).toEqual([]);
    peer.allowDrain(marker.attemptId);
    gate.notify();
    await preQuiescence;
    expect(writes).toEqual(["pre-quiescence"]);

    peer.closeDrain(marker.attemptId);
    const later = enqueue(async () => {
      writes.push("later");
    });
    await Promise.resolve();
    expect(writes).toEqual(["pre-quiescence"]);

    initiator.removeAttempt(marker.attemptId);
    gate.notify();
    await later;
    expect(writes).toEqual(["pre-quiescence", "later"]);
  });
});
