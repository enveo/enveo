/**
 * Focused suite for sync/identity.ts (workflow §3c-3): the pure verdict function (moved here
 * from ../sync.test.ts together with the implementation region) and the blocked/unblocked
 * state transitions this module owns. The full multi-tenant guard — session swaps, ownership
 * proofs, per-request assertions — is exercised end-to-end in ../sync.test.ts through the
 * facade, where the fake server lives.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { store } from "../store";
import { __resetIdentity, decideIdentity, enterForeignReplica, enterLoginPreservingReplica, enterUnauthed, isIdentityBlocked } from "./identity";
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
