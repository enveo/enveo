import { describe, expect, test } from "bun:test";
import { deleteEverythingAndStartFresh, isUnprovenReplicaError, type RecoverySteps } from "./recovery";

/* ── isUnprovenReplicaError — the dialog's gate ─────────────────────────── */

describe("isUnprovenReplicaError", () => {
  test("matches the assertOwnReplica sentinel and nothing else", () => {
    expect(isUnprovenReplicaError(new Error("foreign_replica"))).toBe(true);
    expect(isUnprovenReplicaError(new Error("budget_mismatch"))).toBe(false);
    expect(isUnprovenReplicaError(new Error("unauthorized: 401"))).toBe(false);
    expect(isUnprovenReplicaError("foreign_replica")).toBe(false); // not an Error → not the sentinel
    expect(isUnprovenReplicaError(null)).toBe(false);
  });
});

/* ── deleteEverythingAndStartFresh — order and failure semantics ────────── */

/** Steps that record their call order; each async step can be made to fail. */
function makeSteps(opts: { userId?: string | null; failAt?: "budgetReset" | "signOut" } = {}) {
  const calls: string[] = [];
  const fail = (name: string) => (opts.failAt === name ? Promise.reject(new Error(`${name}_failed`)) : Promise.resolve());
  const steps: RecoverySteps = {
    fetchSessionUserId: () => {
      calls.push("fetchSessionUserId");
      return Promise.resolve(opts.userId === undefined ? "user-1" : opts.userId);
    },
    budgetReset: (userId: string) => {
      calls.push(`budgetReset(${userId})`);
      return fail("budgetReset");
    },
    signOut: () => {
      calls.push("signOut");
      return fail("signOut");
    },
    clearDeviceTrust: () => void calls.push("clearDeviceTrust"),
    clearPersistedSettings: () => void calls.push("clearPersistedSettings"),
    clearLastAccountId: () => void calls.push("clearLastAccountId"),
    discardLocalReplica: () => {
      calls.push("discardLocalReplica");
      return Promise.resolve();
    },
    enterLogin: () => void calls.push("enterLogin"),
  };
  return { steps, calls };
}

describe("deleteEverythingAndStartFresh", () => {
  test("happy path: server reset → sign-out → per-device state → replica wipe, in that order", async () => {
    const { steps, calls } = makeSteps();
    await deleteEverythingAndStartFresh(steps);
    expect(calls).toEqual([
      "fetchSessionUserId",
      "budgetReset(user-1)", // the SESSION user's id travels in the body (per-request assertion)
      "signOut",
      "clearDeviceTrust",
      "clearPersistedSettings",
      "clearLastAccountId",
      "discardLocalReplica",
    ]);
  });

  test("no session (signed out in another tab): route to Login, destroy NOTHING", async () => {
    const { steps, calls } = makeSteps({ userId: null });
    await deleteEverythingAndStartFresh(steps);
    expect(calls).toEqual(["fetchSessionUserId", "enterLogin"]);
  });

  test("server reset fails: nothing local is touched (the copy may be the last one)", async () => {
    const { steps, calls } = makeSteps({ failAt: "budgetReset" });
    await expect(deleteEverythingAndStartFresh(steps)).rejects.toThrow("budgetReset_failed");
    expect(calls).toEqual(["fetchSessionUserId", "budgetReset(user-1)"]);
  });

  test("sign-out fails after a successful reset: still no local wipe (no stranded session)", async () => {
    const { steps, calls } = makeSteps({ failAt: "signOut" });
    await expect(deleteEverythingAndStartFresh(steps)).rejects.toThrow("signOut_failed");
    expect(calls).toEqual(["fetchSessionUserId", "budgetReset(user-1)", "signOut"]);
  });
});
