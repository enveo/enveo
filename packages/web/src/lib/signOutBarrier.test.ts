import { beforeEach, describe, expect, it } from "bun:test";
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
  markLocalCleared,
  markServerFailed,
  releaseSignOutAttempt,
  subscribeSignOutPhase,
} from "./signOutBarrier";

beforeEach(() => {
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

    markLocalCleared();
    expect(getSignOutPhase()).toBe("local-cleared");
    expect(isSignOutBlocking()).toBe(true);

    markServerFailed();
    expect(getSignOutPhase()).toBe("server-failed");
    expect(isSignOutBlocking()).toBe(true);

    cancelSignOut();
    expect(getSignOutPhase()).toBe("idle");
    expect(isSignOutBlocking()).toBe(false);
    expect(phases).toEqual(["blocking", "local-cleared", "server-failed", "idle"]);

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
    expect(() => markServerFailed()).toThrow("sign_out_barrier_invalid_transition:idle->server-failed");
    expect(() => cancelSignOut()).toThrow("sign_out_barrier_invalid_transition:idle->idle");

    beginSignOut();
    expect(() => beginSignOut()).toThrow("sign_out_barrier_invalid_transition:blocking->blocking");
    expect(() => markServerFailed()).toThrow("sign_out_barrier_invalid_transition:blocking->server-failed");

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

  it("accepts only the opaque permit belonging to a live local attempt", () => {
    activateSignOutAttempt("attempt-a", "source-a", "local");
    const permit = createSignOutPermit("attempt-a");
    activateSignOutAttempt("attempt-b", "source-b", "local");
    const otherPermit = createSignOutPermit("attempt-b");

    expect(isSignOutPermitActive(permit)).toBe(true);
    releaseSignOutAttempt("attempt-a");
    expect(isSignOutPermitActive(permit)).toBe(false);
    expect(isSignOutPermitActive(otherPermit)).toBe(true);
  });

  it("does not let a remote cancel release the local phase owner", () => {
    activateSignOutAttempt("local-attempt", "source-a", "local");
    activateSignOutAttempt("remote-attempt", "source-b", "remote");
    markLocalCleared("local-attempt");

    releaseSignOutAttempt("remote-attempt");
    expect(getSignOutPhase()).toBe("local-cleared");
    expect(() => markServerFailed("remote-attempt")).toThrow("sign_out_barrier_wrong_attempt");
  });

  it("fails closed on a shared marker even before a channel message arrives", () => {
    configureSignOutSharedBlocker(() => true);

    expect(isSignOutBlocking()).toBe(true);
    expect(getSignOutPhase()).toBe("blocking");
  });
});
