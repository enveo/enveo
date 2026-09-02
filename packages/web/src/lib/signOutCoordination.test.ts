import { describe, expect, it } from "bun:test";
import {
  createRegistryWriteGate,
  createSignOutCoordinator,
  createSignOutRegistry,
  type SignOutBarrierPort,
  type SignOutCoordinationMessage,
  type StorageLike,
} from "./signOutCoordination";

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  onSet: ((key: string, value: string) => void) | null = null;
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
    this.onSet?.(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

class FakeBarrier implements SignOutBarrierPort<object> {
  readonly active = new Set<string>();
  readonly phases = new Map<string, string>();
  activate(attemptId: string): void {
    this.active.add(attemptId);
    this.phases.set(attemptId, "blocking");
  }
  release(attemptId: string): void {
    this.active.delete(attemptId);
  }
  createPermit(attemptId: string): object {
    return { attemptId };
  }
  markLocalCleared(attemptId: string): void {
    this.phases.set(attemptId, "local-cleared");
  }
  markServerFailed(attemptId: string): void {
    this.phases.set(attemptId, "server-failed");
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("shared sign-out coordination registry", () => {
  it("snapshots only unexpired pre-existing sources and stores protocol identifiers only", () => {
    const storage = new MemoryStorage();
    let now = 1_000;
    const ids = ["generation-a", "source-a", "source-b", "attempt-a"];
    const a = createSignOutRegistry({ storage, now: () => now, randomId: () => ids.shift()!, ttlMs: 100 });
    const b = createSignOutRegistry({ storage, now: () => now, randomId: () => ids.shift()!, ttlMs: 100 });
    a.refreshPresence();
    b.refreshPresence();
    now += 101;
    a.refreshPresence();

    const marker = a.createAttempt();

    expect(marker.requiredSourceIds).toEqual([]);
    const serialized = [...storage.values.values()].join("\n");
    expect(serialized).not.toContain("user");
    expect(serialized).not.toContain("budget");
    expect(serialized).not.toContain("ledger");
    expect(Object.keys(marker).sort()).toEqual(["attemptId", "expiresAt", "ready", "requiredSourceIds", "sourceId", "startedAt", "v"]);
  });

  it("lets a newly opened page discover and block on an active marker", () => {
    const storage = new MemoryStorage();
    let next = 0;
    const ids = ["generation-a", "source-a", "attempt-a", "source-late"];
    const options = { storage, now: () => 1_000, randomId: () => ids[next++]!, ttlMs: 100 };
    const a = createSignOutRegistry(options);
    const marker = a.createAttempt();
    const late = createSignOutRegistry(options);

    expect(late.activeAttempts().map((attempt) => attempt.attemptId)).toEqual([marker.attemptId]);
    expect(late.persistDecision()).toBe("wait");
  });

  it("publishes a collecting blocker before snapshotting a page that registers in the creation race", () => {
    const storage = new MemoryStorage();
    const ids = ["source-a", "generation", "attempt-a", "source-racing"];
    const options = { storage, now: () => 1_000, randomId: () => ids.shift()!, ttlMs: 100 };
    const initiator = createSignOutRegistry(options);
    let racing: ReturnType<typeof createSignOutRegistry> | null = null;
    storage.onSet = (key, value) => {
      if (!key.includes("attempt.") || (JSON.parse(value) as { ready?: boolean }).ready !== false) return;
      storage.onSet = null;
      racing = createSignOutRegistry(options);
      racing.refreshPresence();
      expect(racing.persistDecision()).toBe("wait");
    };

    const marker = initiator.createAttempt();

    expect(marker.ready).toBe(true);
    expect(marker.requiredSourceIds).toEqual([racing!.sourceId]);
  });

  it("cancels only a matching attempt and does not rotate the write generation", () => {
    const storage = new MemoryStorage();
    const ids = ["generation-a", "source-a", "attempt-a", "attempt-b"];
    const registry = createSignOutRegistry({ storage, now: () => 1_000, randomId: () => ids.shift()!, ttlMs: 100 });
    const generation = registry.pageGeneration;
    const a = registry.createAttempt();
    const b = registry.createAttempt();

    registry.removeAttempt(a.attemptId);

    expect(registry.activeAttempts().map((attempt) => attempt.attemptId)).toEqual([b.attemptId]);
    expect(registry.isPageGenerationCurrent()).toBe(true);
    expect(registry.pageGeneration).toBe(generation);
  });

  it("expires an abandoned marker and releases waiting persistence without rotating generation", () => {
    const storage = new MemoryStorage();
    let now = 1_000;
    const ids = ["source-a", "generation", "attempt-a", "source-late"];
    const options = { storage, now: () => now, randomId: () => ids.shift()!, ttlMs: 100 };
    const initiator = createSignOutRegistry(options);
    initiator.createAttempt();
    const late = createSignOutRegistry(options);
    expect(late.persistDecision()).toBe("wait");

    now += 101;

    expect(late.activeAttempts()).toEqual([]);
    expect(late.persistDecision()).toBe("run");
    expect(late.isPageGenerationCurrent()).toBe(true);
  });

  it("rotates only for the exact active attempt and permanently fences the old page", () => {
    const storage = new MemoryStorage();
    const ids = ["generation-a", "source-a", "attempt-a", "generation-b"];
    const registry = createSignOutRegistry({ storage, now: () => 1_000, randomId: () => ids.shift()!, ttlMs: 100 });
    const marker = registry.createAttempt();

    expect(() => registry.rotateGeneration("other-attempt")).toThrow("sign_out_coordination_failed");
    registry.rotateGeneration(marker.attemptId);

    expect(registry.isPageGenerationCurrent()).toBe(false);
    expect(registry.persistDecision()).toBe("skip");
  });

  it("fails closed when shared storage is unavailable", () => {
    const storage = new MemoryStorage();
    storage.setItem = () => {
      throw new Error("denied");
    };

    expect(() => createSignOutRegistry({ storage, now: () => 1_000, randomId: () => "opaque", ttlMs: 100 })).toThrow("sign_out_coordination_failed");
  });
});

describe("sign-out acknowledgement handshake", () => {
  it("does not hand the initiator a lease until the peer cycle and persistence are quiescent", async () => {
    const storage = new MemoryStorage();
    const ids = ["generation", "source-a", "source-b", "attempt-a"];
    const options = { storage, now: () => 1_000, randomId: () => ids.shift()!, ttlMs: 100 };
    const aRegistry = createSignOutRegistry(options);
    const bRegistry = createSignOutRegistry(options);
    aRegistry.refreshPresence();
    bRegistry.refreshPresence();
    const peerCycle = deferred();
    const peerPersistence = deferred();
    const neverTimeout = () => new Promise<void>(() => {});
    let a!: ReturnType<typeof createSignOutCoordinator<object>>;
    let b!: ReturnType<typeof createSignOutCoordinator<object>>;
    const deliver = (target: "a" | "b", message: SignOutCoordinationMessage) => {
      (target === "a" ? a : b).handleMessage(message);
    };
    a = createSignOutCoordinator({
      registry: aRegistry,
      barrier: new FakeBarrier(),
      gate: createRegistryWriteGate(aRegistry),
      send: (message) => deliver("b", message),
      quiesceCycle: async () => {},
      drainPersistence: async () => {},
      waitForTimeout: neverTimeout,
    });
    b = createSignOutCoordinator({
      registry: bRegistry,
      barrier: new FakeBarrier(),
      gate: createRegistryWriteGate(bRegistry),
      send: (message) => deliver("a", message),
      quiesceCycle: () => peerCycle.promise,
      drainPersistence: () => peerPersistence.promise,
      waitForTimeout: neverTimeout,
    });
    const outcome: string[] = [];

    const pendingLease = a.begin().then((lease) => {
      outcome.push("lease");
      return lease;
    });
    await Promise.resolve();
    expect(outcome).toEqual([]);
    peerCycle.resolve();
    await Promise.resolve();
    expect(outcome).toEqual([]);
    peerPersistence.resolve();

    await pendingLease;
    expect(outcome).toEqual(["lease"]);
  });

  it("fails closed on handshake timeout and releases the peer with a matching cancel", async () => {
    const storage = new MemoryStorage();
    const ids = ["generation", "source-a", "source-b", "attempt-a"];
    const options = { storage, now: () => 1_000, randomId: () => ids.shift()!, ttlMs: 100 };
    const aRegistry = createSignOutRegistry(options);
    const bRegistry = createSignOutRegistry(options);
    aRegistry.refreshPresence();
    bRegistry.refreshPresence();
    const aBarrier = new FakeBarrier();
    const bBarrier = new FakeBarrier();
    let b!: ReturnType<typeof createSignOutCoordinator<object>>;
    const a = createSignOutCoordinator({
      registry: aRegistry,
      barrier: aBarrier,
      gate: createRegistryWriteGate(aRegistry),
      send: (message) => b.handleMessage(message),
      quiesceCycle: async () => {},
      drainPersistence: async () => {},
      waitForTimeout: async () => {},
    });
    b = createSignOutCoordinator({
      registry: bRegistry,
      barrier: bBarrier,
      gate: createRegistryWriteGate(bRegistry),
      send: () => {},
      quiesceCycle: () => new Promise<void>(() => {}),
      drainPersistence: async () => {},
      waitForTimeout: () => new Promise<void>(() => {}),
    });

    await expect(a.begin()).rejects.toThrow("sign_out_coordination_failed");
    expect(aBarrier.active.size).toBe(0);
    expect(bBarrier.active.size).toBe(0);
    expect(aRegistry.isPageGenerationCurrent()).toBe(true);
  });

  it("a new page activates an existing marker synchronously during install", () => {
    const storage = new MemoryStorage();
    const ids = ["generation", "source-a", "attempt-a", "source-late"];
    const options = { storage, now: () => 1_000, randomId: () => ids.shift()!, ttlMs: 100 };
    const existing = createSignOutRegistry(options);
    const marker = existing.createAttempt();
    const late = createSignOutRegistry(options);
    const barrier = new FakeBarrier();
    const coordinator = createSignOutCoordinator({
      registry: late,
      barrier,
      gate: createRegistryWriteGate(late),
      send: () => {},
      quiesceCycle: async () => {},
      drainPersistence: async () => {},
    });

    coordinator.install();

    expect(barrier.active).toEqual(new Set([marker.attemptId]));
  });

  it("a negative peer acknowledgement fails closed without rotating generation", async () => {
    const storage = new MemoryStorage();
    const ids = ["generation", "source-a", "source-b", "attempt-a"];
    const options = { storage, now: () => 1_000, randomId: () => ids.shift()!, ttlMs: 100 };
    const aRegistry = createSignOutRegistry(options);
    const bRegistry = createSignOutRegistry(options);
    aRegistry.refreshPresence();
    bRegistry.refreshPresence();
    const sent: SignOutCoordinationMessage[] = [];
    const barrier = new FakeBarrier();
    const coordinator = createSignOutCoordinator({
      registry: aRegistry,
      barrier,
      gate: createRegistryWriteGate(aRegistry),
      send: (message) => sent.push(message),
      quiesceCycle: async () => {},
      drainPersistence: async () => {},
      waitForTimeout: () => new Promise<void>(() => {}),
    });

    const pending = coordinator.begin();
    await Promise.resolve();
    const start = sent.find((message) => message.type === "sign-out-start")!;
    coordinator.handleMessage({
      type: "sign-out-ack",
      attemptId: start.attemptId,
      sourceId: bRegistry.sourceId,
      targetSourceId: aRegistry.sourceId,
      ok: false,
    });

    await expect(pending).rejects.toThrow("sign_out_coordination_failed");
    expect(barrier.active.size).toBe(0);
    expect(aRegistry.isPageGenerationCurrent()).toBe(true);
  });

  it("a matching remote cancel cannot release another overlapping attempt", () => {
    const storage = new MemoryStorage();
    const ids = ["generation", "source-target", "source-b", "source-c", "attempt-b", "attempt-c"];
    const options = { storage, now: () => 1_000, randomId: () => ids.shift()!, ttlMs: 100 };
    const target = createSignOutRegistry(options);
    const b = createSignOutRegistry(options);
    const c = createSignOutRegistry(options);
    const markerB = b.createAttempt();
    const markerC = c.createAttempt();
    const barrier = new FakeBarrier();
    const coordinator = createSignOutCoordinator({
      registry: target,
      barrier,
      gate: createRegistryWriteGate(target),
      send: () => {},
      quiesceCycle: async () => {},
      drainPersistence: async () => {},
    });
    coordinator.install();
    b.removeAttempt(markerB.attemptId);

    coordinator.handleMessage({ type: "sign-out-cancel", attemptId: markerB.attemptId, sourceId: b.sourceId });

    expect(barrier.active.has(markerB.attemptId)).toBe(false);
    expect(barrier.active.has(markerC.attemptId)).toBe(true);
  });

  it("keeps every old page generation fenced after durable clear and terminal marker removal", async () => {
    const storage = new MemoryStorage();
    const ids = ["generation-a", "source-a", "source-b", "attempt-a", "generation-b"];
    const options = { storage, now: () => 1_000, randomId: () => ids.shift()!, ttlMs: 100 };
    const aRegistry = createSignOutRegistry(options);
    const bRegistry = createSignOutRegistry(options);
    aRegistry.refreshPresence();
    bRegistry.refreshPresence();
    let a!: ReturnType<typeof createSignOutCoordinator<object>>;
    let b!: ReturnType<typeof createSignOutCoordinator<object>>;
    const neverTimeout = () => new Promise<void>(() => {});
    a = createSignOutCoordinator({
      registry: aRegistry,
      barrier: new FakeBarrier(),
      gate: createRegistryWriteGate(aRegistry),
      send: (message) => b.handleMessage(message),
      quiesceCycle: async () => {},
      drainPersistence: async () => {},
      waitForTimeout: neverTimeout,
    });
    b = createSignOutCoordinator({
      registry: bRegistry,
      barrier: new FakeBarrier(),
      gate: createRegistryWriteGate(bRegistry),
      send: (message) => a.handleMessage(message),
      quiesceCycle: async () => {},
      drainPersistence: async () => {},
      waitForTimeout: neverTimeout,
    });
    const lease = await a.begin();

    expect(() => a.finish(lease)).toThrow("sign_out_coordination_failed");
    a.markStorageCleared(lease);
    a.finish(lease);
    b.maintain();

    expect(aRegistry.activeAttempts()).toEqual([]);
    expect(bRegistry.persistDecision()).toBe("skip");
    expect(() => a.cancel(lease)).toThrow("sign_out_coordination_failed");
  });
});
