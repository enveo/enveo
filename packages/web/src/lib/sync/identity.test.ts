/**
 * Focused suite for sync/identity.ts (workflow §3c-3): the pure verdict function (moved here
 * from ../sync.test.ts together with the implementation region) and the blocked/unblocked
 * state transitions this module owns. The full multi-tenant guard — session swaps, ownership
 * proofs, per-request assertions — is exercised end-to-end in ../sync.test.ts through the
 * facade, where the fake server lives.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { cacheDeployment } from "../deviceStoragePolicy";
import { store } from "../store";
import {
  __resetIdentity,
  configureIdentity,
  decideIdentity,
  enterForeignReplica,
  enterLoginPreservingReplica,
  enterUnauthed,
  isIdentityBlocked,
} from "./identity";
import { getSyncStatus } from "./status";

afterEach(() => {
  __resetIdentity();
  store.setBootStatus("ready");
});

/* ── Pure decision (moved from sync.test.ts with the implementation) ────── */

describe("decideIdentity", () => {
  it("no session → unauthed (regardless of the stamp)", () => {
    expect(decideIdentity(null, "user-A")).toBe("unauthed");
    expect(decideIdentity(null, undefined)).toBe("unauthed");
  });
  it("stamped with a DIFFERENT user → foreign", () => {
    expect(decideIdentity("user-B", "user-A")).toBe("foreign");
  });
  it("same user → ok; no stamp yet → ok (ownership is proved separately)", () => {
    expect(decideIdentity("user-A", "user-A")).toBe("ok");
    expect(decideIdentity("user-A", undefined)).toBe("ok");
  });
});

/* ── Blocked/unblocked transitions (single owner of the verdict state) ──── */

describe("sync/identity: verdict state transitions", () => {
  it("enterForeignReplica blocks every cycle and routes to ForeignReplicaScreen", () => {
    expect(isIdentityBlocked()).toBe(false);
    enterForeignReplica();
    expect(isIdentityBlocked()).toBe(true);
    expect(store.getBootStatus()).toBe("foreign");
    expect(getSyncStatus().state).toBe("error"); // honest: sync is not happening
    expect(getSyncStatus().ownerUnproven).toBe(false); // a PROVEN foreign stamp supersedes it
  });

  it("enterLoginPreservingReplica unblocks — a NEW session is verified from scratch", () => {
    enterForeignReplica();
    enterLoginPreservingReplica();
    expect(isIdentityBlocked()).toBe(false);
    expect(store.getBootStatus()).toBe("unauthed"); // Login screen, replica intact
    expect(getSyncStatus().state).toBe("unauthed");
  });

  it("enterUnauthed clears the sticky unproven fact (nothing to prove without a session)", () => {
    enterUnauthed();
    expect(getSyncStatus().ownerUnproven).toBe(false);
    expect(store.getBootStatus()).toBe("unauthed");
    expect(getSyncStatus().state).toBe("unauthed");
  });

  it("__resetIdentity clears the block (test isolation contract)", () => {
    enterForeignReplica();
    __resetIdentity();
    expect(isIdentityBlocked()).toBe(false);
  });
});

/* ── Cloud: a foreign replica is silently discarded, never rendered ─────── */

describe("sync/identity: foreign replica on CLOUD", () => {
  // These tests own localStorage (the deployment cache) and the composed identity deps;
  // both are restored so the rest of the process (facade suites share this module) is
  // untouched.
  let prevDeps: ReturnType<typeof configureIdentity>;

  function stubLocalStorage() {
    const values = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
    };
  }

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
    configureIdentity(prevDeps);
  });

  it("cloud → discards the replica instead of rendering ForeignReplicaScreen", () => {
    prevDeps = configureIdentity(null);
    stubLocalStorage();
    cacheDeployment("cloud");
    let discards = 0;
    configureIdentity({
      discardForeignReplica: async () => {
        discards++;
      },
    });
    enterForeignReplica();
    expect(discards).toBe(1);
    expect(store.getBootStatus()).toBe("ready"); // unchanged — the wipe reloads, no screen flips
    expect(isIdentityBlocked()).toBe(true); // no write may race the wipe before the reload
  });

  it("cloud + a FAILING wipe → falls back to the screen instead of an eternal splash", async () => {
    prevDeps = configureIdentity(null);
    stubLocalStorage();
    cacheDeployment("cloud");
    configureIdentity({
      discardForeignReplica: async () => {
        throw new Error("idb gone");
      },
    });
    enterForeignReplica();
    await Promise.resolve(); // let the rejection reach the catch
    await Promise.resolve();
    expect(store.getBootStatus()).toBe("foreign"); // recoverable screen (cloud hides the export)
    expect(getSyncStatus().state).toBe("error");
    expect(isIdentityBlocked()).toBe(true);
  });

  it("selfhost → keeps the human decision (ForeignReplicaScreen)", () => {
    prevDeps = configureIdentity(null);
    stubLocalStorage();
    cacheDeployment("selfhost");
    let discards = 0;
    configureIdentity({
      discardForeignReplica: async () => {
        discards++;
      },
    });
    enterForeignReplica();
    expect(discards).toBe(0);
    expect(store.getBootStatus()).toBe("foreign");
  });

  it("unknown deployment (nothing cached) → fail-safe: the screen, nothing destroyed", () => {
    prevDeps = configureIdentity(null);
    stubLocalStorage(); // no deployment key → getCachedDeployment() falls back to "selfhost"
    let discards = 0;
    configureIdentity({
      discardForeignReplica: async () => {
        discards++;
      },
    });
    enterForeignReplica();
    expect(discards).toBe(0);
    expect(store.getBootStatus()).toBe("foreign");
  });

  it("cloud with no composed discard dep → fail-safe: the screen", () => {
    prevDeps = configureIdentity(null); // the facade has not composed the module
    stubLocalStorage();
    cacheDeployment("cloud");
    enterForeignReplica();
    expect(store.getBootStatus()).toBe("foreign");
  });
});
