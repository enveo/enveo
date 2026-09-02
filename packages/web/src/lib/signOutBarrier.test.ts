import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  __resetSignOutBarrierForTests,
  activateSignOutAttempt,
  beginSignOut,
  cancelSignOut,
  configureSignOutSharedBlocker,
  createSignOutPermit,
  getSignOutPhase,
  isSignOutBlocking,
  isSignOutPermitActive,
  markCleanupFailed,
  markLocalCleared,
  releaseSignOutAttempt,
  subscribeSignOutPhase,
} from "./signOutBarrier";

beforeEach(() => {
  __resetSignOutBarrierForTests();
});

afterEach(() => {
  __resetSignOutBarrierForTests();
});

describe("sign-out barrier", () => {
  it("blocks through the ordered sign-out phases and notifies subscribers", () => {
    const phases: string[] = [];
    const unsubscribe = subscribeSignOutPhase(() => phases.push(getSignOutPhase()));

    expect(getSignOutPhase()).toBe("idle");
    expect(isSignOutBlocking()).toBe(false);

    beginSignOut();
    expect(getSignOutPhase()).toBe("blocking");
    expect(isSignOutBlocking()).toBe(true);

    markCleanupFailed();
    expect(getSignOutPhase()).toBe("cleanup-failed");
    expect(isSignOutBlocking()).toBe(true);

    markLocalCleared();
    expect(getSignOutPhase()).toBe("local-cleared");
    expect(isSignOutBlocking()).toBe(true);

    releaseSignOutAttempt("legacy-sign-out");
    expect(getSignOutPhase()).toBe("idle");
    expect(isSignOutBlocking()).toBe(false);
    expect(phases).toEqual(["blocking", "cleanup-failed", "local-cleared", "idle"]);

    unsubscribe();
    beginSignOut();
    expect(phases).toHaveLength(4);
  });

  it("can cancel while local cleanup has not completed", () => {
    beginSignOut();
    cancelSignOut();

    expect(getSignOutPhase()).toBe("idle");
    expect(isSignOutBlocking()).toBe(false);
  });

  it("throws composition errors instead of accepting out-of-order transitions", () => {
    expect(() => markLocalCleared()).toThrow("sign_out_barrier_invalid_transition:idle->local-cleared");
    expect(() => markCleanupFailed()).toThrow("sign_out_barrier_invalid_transition:idle->cleanup-failed");
    expect(() => cancelSignOut()).toThrow("sign_out_barrier_invalid_transition:idle->idle");

    beginSignOut();
    expect(() => beginSignOut()).toThrow("sign_out_barrier_invalid_transition:blocking->blocking");
    markCleanupFailed();
    expect(() => markCleanupFailed()).toThrow("sign_out_barrier_invalid_transition:cleanup-failed->cleanup-failed");

    markLocalCleared();
    expect(() => cancelSignOut()).toThrow("sign_out_barrier_invalid_transition:local-cleared->idle");
  });

  it("keeps overlapping attempts blocked and releases only the matching attempt", () => {
    activateSignOutAttempt("attempt-a", "source-a", "remote");
    activateSignOutAttempt("attempt-b", "source-b", "remote");

    releaseSignOutAttempt("attempt-a");
    expect(isSignOutBlocking()).toBe(true);
    expect(getSignOutPhase()).toBe("blocking");

    releaseSignOutAttempt("attempt-b");
    expect(isSignOutBlocking()).toBe(false);
  });

  it("accepts a permit only while it is the sole live attempt", () => {
    activateSignOutAttempt("attempt-a", "source-a", "local");
    const permit = createSignOutPermit("attempt-a");
    expect(isSignOutPermitActive(permit)).toBe(true);

    activateSignOutAttempt("attempt-b", "source-b", "local");
    const otherPermit = createSignOutPermit("attempt-b");
    expect(isSignOutPermitActive(permit)).toBe(false);
    expect(isSignOutPermitActive(otherPermit)).toBe(false);

    releaseSignOutAttempt("attempt-a");
    expect(isSignOutPermitActive(permit)).toBe(false);
    expect(isSignOutPermitActive(otherPermit)).toBe(true);
  });

  it("does not let a remote cancel release the local phase owner", () => {
    activateSignOutAttempt("local-attempt", "source-a", "local");
    activateSignOutAttempt("remote-attempt", "source-b", "remote");
    markCleanupFailed("local-attempt");

    releaseSignOutAttempt("remote-attempt");
    expect(getSignOutPhase()).toBe("cleanup-failed");
    expect(() => markCleanupFailed("remote-attempt")).toThrow("sign_out_barrier_wrong_attempt");
  });

  it("fails closed on a shared marker even before a channel message arrives", () => {
    configureSignOutSharedBlocker(() => true);

    expect(isSignOutBlocking()).toBe(true);
    expect(getSignOutPhase()).toBe("blocking");
  });

  it("notifies the UI when coordinator installation replaces the eager blocker", () => {
    configureSignOutSharedBlocker(() => true);
    const phases: string[] = [];
    const unsubscribe = subscribeSignOutPhase(() => phases.push(getSignOutPhase()));

    configureSignOutSharedBlocker(() => false);

    expect(getSignOutPhase()).toBe("idle");
    expect(phases).toEqual(["idle"]);
    unsubscribe();
  });
});
