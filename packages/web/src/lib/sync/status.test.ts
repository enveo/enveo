/**
 * Focused suite for sync/status.ts (workflow §3c-3): the status snapshot's stability contract
 * (useSyncExternalStore), listener notification rules and the sticky ownerUnproven fact.
 * Facade-level behavior (badge semantics across whole cycles) stays in ../sync.test.ts.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as outbox from "../outbox";
import { getLastSyncAt, getSyncStatus, installOutboxStatusListener, setLastSyncAt, setOwnerUnproven, setState, subscribeSyncStatus } from "./status";

afterEach(() => {
  // leave the module in the neutral state other suites expect
  setOwnerUnproven(false);
  setLastSyncAt(null);
  setState("synced");
});

describe("sync/status: snapshot stability and notifications", () => {
  it("returns a STABLE reference between changes and a new one after setState", () => {
    setState("synced");
    const a = getSyncStatus();
    const b = getSyncStatus();
    expect(b).toBe(a); // useSyncExternalStore contract: no re-render without a change

    setState("syncing");
    const c = getSyncStatus();
    expect(c).not.toBe(a);
    expect(c.state).toBe("syncing");
  });

  it("setState with the SAME state still refreshes counters (bump), and notifies", () => {
    setState("synced");
    let notified = 0;
    const stop = subscribeSyncStatus(() => {
      notified++;
    });
    setState("synced"); // same state — counters may have changed
    stop();
    expect(notified).toBe(1);
    expect(getSyncStatus().state).toBe("synced");
  });

  it("setOwnerUnproven notifies ONLY on an actual change (the sticky-fact contract)", () => {
    setOwnerUnproven(false);
    let notified = 0;
    const stop = subscribeSyncStatus(() => {
      notified++;
    });
    setOwnerUnproven(false); // no change — no notification
    expect(notified).toBe(0);
    setOwnerUnproven(true);
    expect(notified).toBe(1);
    expect(getSyncStatus().ownerUnproven).toBe(true);
    setOwnerUnproven(true); // idempotent
    expect(notified).toBe(1);
    stop();
  });

  it("lastSyncAt flows into the snapshot on the next bump, not by mutation", () => {
    setLastSyncAt("2026-08-13T00:00:00.000Z");
    expect(getLastSyncAt()).toBe("2026-08-13T00:00:00.000Z");
    // setLastSyncAt alone does not rebuild the snapshot (loadSyncMeta relies on that)…
    setState("syncing"); // …the next state change does
    expect(getSyncStatus().lastSyncAt).toBe("2026-08-13T00:00:00.000Z");
  });

  it("outbox listener installation is explicit and idempotent; queue changes refresh counters", () => {
    installOutboxStatusListener();
    installOutboxStatusListener(); // second call must be a no-op, not a double listener
    setState("synced");
    const before = getSyncStatus();
    outbox.add({ opId: crypto.randomUUID(), kind: "category.create", payload: { id: crypto.randomUUID(), name: "X" } } as never);
    const after = getSyncStatus();
    expect(after).not.toBe(before);
    expect(after.pending).toBe(before.pending + 1);
    outbox.clearAll();
  });

  it("subscribe returns an unsubscribe that actually detaches", () => {
    let notified = 0;
    const stop = subscribeSyncStatus(() => {
      notified++;
    });
    setState("offline");
    expect(notified).toBe(1);
    stop();
    setState("synced");
    expect(notified).toBe(1);
  });
});
