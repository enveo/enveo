/**
 * The WebKit<16 replacement for AbortSignal.timeout. Contract: the timer firing
 * aborts the signal AND marks timedOut (so the transport can classify the failure
 * as ai_timeout, never "check the key"); clear() on settle cancels the exact
 * pending timer — a fast answer must not retain a 2–5 minute timer behind it.
 */
import { describe, expect, it } from "bun:test";
import { timeoutSignal } from "./timeoutSignal";

/** Fake timers: capture the callback, fire it by hand, record clears. */
function fakeTimers() {
  let fire: (() => void) | null = null;
  const cleared: unknown[] = [];
  return {
    timers: {
      setTimeout: (fn: () => void, _ms: number) => {
        fire = fn;
        return "handle-1";
      },
      clearTimeout: (h: unknown) => {
        cleared.push(h);
      },
    },
    fireNow: () => fire?.(),
    cleared,
  };
}

describe("timeoutSignal", () => {
  it("aborts the signal and reports timedOut once the timer fires", () => {
    const { timers, fireNow } = fakeTimers();
    const t = timeoutSignal(120_000, timers);
    expect(t.signal.aborted).toBe(false);
    expect(t.timedOut()).toBe(false);
    fireNow();
    expect(t.signal.aborted).toBe(true);
    expect(t.timedOut()).toBe(true);
  });

  it("clear() cancels the pending timer on settle — no timer retained, no late abort", () => {
    const { timers, cleared } = fakeTimers();
    const t = timeoutSignal(120_000, timers);
    t.clear();
    expect(cleared).toEqual(["handle-1"]); // the exact handle setTimeout returned
    expect(t.signal.aborted).toBe(false);
    expect(t.timedOut()).toBe(false);
  });

  it("an abort that did not come from the timer is NOT a timeout", () => {
    const { timers } = fakeTimers();
    const t = timeoutSignal(120_000, timers);
    expect(t.timedOut()).toBe(false); // e.g. the runtime aborting for its own reasons
  });
});
