import { beforeEach, describe, expect, it } from "bun:test";
import {
  __resetSignOutBarrierForTests,
  beginSignOut,
  cancelSignOut,
  getSignOutPhase,
  isSignOutBlocking,
  markLocalCleared,
  markServerFailed,
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
});
