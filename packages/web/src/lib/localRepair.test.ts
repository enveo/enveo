import { describe, expect, it } from "bun:test";
import type { SyncOp } from "@enveo/shared";
import { type LocalRepairDeps, rebuildLocalReplica } from "./localRepair";

const IDS = {
  first: "11111111-1111-4111-8111-111111111111",
  second: "22222222-2222-4222-8222-222222222222",
} as const;

const op = (name: keyof typeof IDS): SyncOp => ({
  opId: IDS[name],
  kind: "category.create",
  payload: { id: name === "first" ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name },
});

function fixture(overrides: Partial<LocalRepairDeps> = {}) {
  const events: string[] = [];
  let base = ["old-local"];
  const pending = [op("first"), op("second")];
  const deps: LocalRepairDeps = {
    runExclusive: async (task) => {
      events.push("mutex:start");
      const result = await task();
      events.push("mutex:end");
      return result;
    },
    identityBlocked: () => false,
    assertOwnReplica: async () => {
      events.push("owner:verified");
    },
    reconcileOutbox: async () => {
      events.push("outbox:reconciled");
    },
    pendingEntries: () => pending.map((queued, index) => ({ localSeq: index + 1, op: queued })),
    e2eeState: () => ({ enabled: false, keyReady: true }),
    markLocked: () => {
      events.push("locked");
    },
    fetchFreshBase: async () => {
      events.push("snapshot:fetched");
      base = ["server-base"];
      return "ready";
    },
    replay: (ops) => {
      for (const queued of ops) base.push(queued.opId);
      events.push(`outbox:replayed:${ops.map((queued) => queued.opId).join(",")}`);
    },
    persist: async () => {
      events.push(`persisted:${base.join(",")}`);
    },
    durabilityReady: () => true,
    broadcast: () => {
      events.push("broadcast");
    },
    ...overrides,
  };
  return { deps, events, state: () => base };
}

describe("rebuildLocalReplica", () => {
  it("replaces only the base, replays the preserved outbox in order, then persists before broadcasting", async () => {
    const f = fixture();

    expect(await rebuildLocalReplica(f.deps)).toEqual({ kind: "rebuilt" });

    expect(f.state()).toEqual(["server-base", IDS.first, IDS.second]);
    expect(f.events).toEqual([
      "mutex:start",
      "owner:verified",
      "outbox:reconciled",
      "snapshot:fetched",
      `outbox:replayed:${IDS.first},${IDS.second}`,
      `persisted:server-base,${IDS.first},${IDS.second}`,
      "broadcast",
      "mutex:end",
    ]);
  });

  it("changes nothing when the owner is unproven or foreign", async () => {
    for (const overrides of [{ assertOwnReplica: async () => Promise.reject(new Error("foreign_replica")) }, { identityBlocked: () => true }]) {
      const f = fixture(overrides);
      expect(await rebuildLocalReplica(f.deps)).toEqual({ kind: "blocked", reason: "unproven" });
      expect(f.events).not.toContain("snapshot:fetched");
      expect(f.state()).toEqual(["old-local"]);
    }
  });

  it("changes nothing when the durable outbox is unreadable", async () => {
    const f = fixture({ pendingEntries: () => [{ localSeq: 1, op: { nope: true } }] });

    expect(await rebuildLocalReplica(f.deps)).toEqual({ kind: "blocked", reason: "outbox_unreadable" });
    expect(f.events).not.toContain("snapshot:fetched");
    expect(f.state()).toEqual(["old-local"]);
  });

  it("changes nothing when reconciling the durable outbox fails", async () => {
    const f = fixture({ reconcileOutbox: async () => Promise.reject(new Error("idb read failed")) });

    expect(await rebuildLocalReplica(f.deps)).toEqual({ kind: "blocked", reason: "outbox_unreadable" });
    expect(f.events).not.toContain("snapshot:fetched");
    expect(f.state()).toEqual(["old-local"]);
  });

  it("does not start when durable storage is already unavailable", async () => {
    const f = fixture({ durabilityReady: () => false });

    expect(await rebuildLocalReplica(f.deps)).toEqual({ kind: "blocked", reason: "outbox_unreadable" });
    expect(f.events).not.toContain("owner:verified");
    expect(f.events).not.toContain("outbox:reconciled");
    expect(f.events).not.toContain("snapshot:fetched");
    expect(f.state()).toEqual(["old-local"]);
  });

  it("changes nothing when E2EE has no validated DEK", async () => {
    const f = fixture({ e2eeState: () => ({ enabled: true, keyReady: false }) });

    expect(await rebuildLocalReplica(f.deps)).toEqual({ kind: "blocked", reason: "locked" });
    expect(f.events).toContain("locked");
    expect(f.events).not.toContain("snapshot:fetched");
    expect(f.state()).toEqual(["old-local"]);
  });

  it("returns locked if the server reveals E2EE during the fresh bootstrap", async () => {
    const f = fixture({
      fetchFreshBase: async () => {
        f.events.push("snapshot:locked");
        return "locked";
      },
    });

    expect(await rebuildLocalReplica(f.deps)).toEqual({ kind: "blocked", reason: "locked" });
    expect(f.events).toContain("locked");
    expect(f.events).not.toContain("broadcast");
  });

  it("does not announce a rebuild when persistence becomes unavailable", async () => {
    let durable = true;
    const f = fixture({
      persist: async () => {
        f.events.push("persist:failed");
        durable = false;
      },
      durabilityReady: () => durable,
    });

    expect(await rebuildLocalReplica(f.deps)).toEqual({ kind: "blocked", reason: "outbox_unreadable" });
    expect(f.events).not.toContain("broadcast");
  });
});
