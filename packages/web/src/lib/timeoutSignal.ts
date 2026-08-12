/**
 * `AbortSignal.timeout` built from AbortController + setTimeout — because
 * `AbortSignal.timeout` DOES NOT EXIST on WebKit < 16 (iOS 15 Safari): with it,
 * every AI call there died instantly with a misleading "check the key" message.
 * The api package keeps its own byte-equivalent copy in `openaiHttp.ts`
 * (@enveo/shared is zero-I/O — pure constants only, no timer factories);
 * `scripts/lib/aiTransportParity.test.ts` pins both sides to this pattern.
 *
 * `timedOut()` distinguishes OUR abort from any other rejection —
 * `AbortController.abort(reason)` is itself missing on the WebKit versions this
 * exists for, so a flag, not an abort reason. Call `clear()` once the request
 * settles (a `finally`), or the timer outlives the request.
 */

interface Timers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const REAL_TIMERS: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

export function timeoutSignal(ms: number, timers: Timers = REAL_TIMERS): { signal: AbortSignal; timedOut: () => boolean; clear: () => void } {
  const ctl = new AbortController();
  let fired = false;
  const handle = timers.setTimeout(() => {
    fired = true;
    ctl.abort();
  }, ms);
  return { signal: ctl.signal, timedOut: () => fired, clear: () => timers.clearTimeout(handle) };
}
