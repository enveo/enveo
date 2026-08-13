/**
 * Durable OBLIGATIONS of the sync engine — the single owner of the two cross-cycle flags and
 * their IDB mirrors (workflow §3c-3). Consumed EXCLUSIVELY in doCycle (under the syncNow mutex).
 */
import { idbGet } from "../idb";
import * as persist from "../persist";

/* ── Durable resync obligation (D1) ────────────────────────────────────── */

/**
 * Kept ACROSS cycles and (mirrored in IDB) across reloads. An op rejected
 * by the server leaves a phantom in the mirror that ONLY snapshot+replay removes
 * (the server never accepted the client's id, so no tombstone will ever arrive
 * via pull). If the obligation were cycle-local, a transient blip in doPull/snapshot
 * after the rejection would lose it FOREVER. Consumed EXCLUSIVELY in doCycle after push+pull.
 */
let resyncPending = false;

export function isResyncPending(): boolean {
  return resyncPending;
}

export function markResyncPending(): void {
  resyncPending = true;
  void persist.putMeta("resyncPending", true);
}

export function clearResyncPending(): void {
  resyncPending = false;
  void persist.putMeta("resyncPending", false);
}

/* ── Durable REPLACE obligation (JSON backup import) ─────────────────────
 *
 * A backup import makes the LOCAL mirror canonical — it must REPLACE the server
 * (pushLocalToServer → /sync/replace), NEVER the other way around. When the push is DEFERRED
 * (local mode — no network) or FAILS (network/5xx), the next cycle
 * (consumer in doCycle) / resume will FINISH the replace. Without this durable
 * obligation, a delta pull(since=0) after the import would revert the imported data to
 * the (old) server state — silent loss of the restore. Persisted BEFORE swapping
 * the mirror on the SAME serial persist chain, so: durable-mirror ⟹
 * durable-flag (a crash won't leave an imported mirror without the obligation
 * to push it). Consumed EXCLUSIVELY in doCycle (under the syncNow mutex). */
let replacePending = false;

export function isReplacePending(): boolean {
  return replacePending;
}

/** Set the durable replace obligation (called from backup import BEFORE swapping the mirror). */
export function markReplacePending(): void {
  replacePending = true;
  void persist.putMeta("replacePending", true);
}

export function clearReplacePending(): void {
  replacePending = false;
  void persist.putMeta("replacePending", false);
}

/**
 * Best-effort hydration of the durable obligations — each independently and without throwing,
 * so one failed read doesn't skip the other or topple the boot. CRITICAL: the durable resync
 * obligation (D1) must reach memory on BOTH boot paths (success and recovery), otherwise a
 * rejected op would leave a "ghost" for the whole session; the durable replace obligation MUST
 * survive a reload — otherwise after a restart doCycle would pull instead of pushLocalToServer
 * and revert the import.
 */
export async function hydrateObligations(): Promise<void> {
  try {
    resyncPending = (await idbGet<boolean>("meta", "resyncPending")) ?? resyncPending;
  } catch (e) {
    console.warn("reading resyncPending failed", e);
  }
  try {
    replacePending = (await idbGet<boolean>("meta", "replacePending")) ?? replacePending;
  } catch (e) {
    console.warn("reading replacePending failed", e);
  }
}

/** Test hook (unit tests only): drop the durable obligations held in module memory. */
export function __resetObligations(): void {
  resyncPending = false;
  replacePending = false;
}
