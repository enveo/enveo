/**
 * Local-mode FLAG — the single owner of the module-level tri-state value and its
 * localStorage persistence (workflow §3c-3). The paused/wiped TRANSITIONS (enablePaused /
 * enableWiped / disableLocal / applyLocalMode) live with the facade until their extraction
 * step; they mutate the flag exclusively through setLocalModeValue / writeLocalModeToStorage.
 *
 * Module flag read at load time (BEFORE React), kept in localStorage
 * (keys under the old brand are migrated by storage.ts, imported via the facade).
 * Migration of the old boolean "enveo.localOnly"==="true" → "paused" (the SAFE state,
 * no server destruction).
 */
import * as outbox from "../outbox";
import type { LocalMode, LocalModeDeps } from "./contracts";

const LOCAL_MODE_KEY = "enveo.localMode";
const LEGACY_LOCAL_KEY = "enveo.localOnly";

function readLocalMode(): LocalMode {
  try {
    const v = localStorage.getItem(LOCAL_MODE_KEY);
    if (v === "off" || v === "paused" || v === "wiped") return v;
    if (localStorage.getItem(LEGACY_LOCAL_KEY) === "true") {
      // migrate to the SAFE state (paused doesn't wipe the server)
      try {
        localStorage.setItem(LOCAL_MODE_KEY, "paused");
        localStorage.removeItem(LEGACY_LOCAL_KEY);
      } catch {
        /* ignore */
      }
      return "paused";
    }
  } catch {
    /* localStorage unavailable — treat as off */
  }
  return "off";
}

let localMode: LocalMode = readLocalMode();

/** Current local mode (off/paused/wiped). */
export function getLocalMode(): LocalMode {
  return localMode;
}

/** Whether local mode is on (paused OR wiped) — sync is suspended. */
export function isLocalOnly(): boolean {
  return localMode !== "off";
}

/**
 * Set the in-memory flag ONLY (no persistence, no broadcast, no UI state): the peer-tab
 * "localmode" message uses exactly this (localStorage is shared — the sender already wrote it),
 * and applyLocalMode composes it with writeLocalModeToStorage + the status/broadcast effects.
 */
export function setLocalModeValue(mode: LocalMode): void {
  localMode = mode;
}

/** Persist the flag (best-effort — it lives in session memory anyway). */
export function writeLocalModeToStorage(mode: LocalMode): void {
  try {
    localStorage.setItem(LOCAL_MODE_KEY, mode);
  } catch {
    /* ignore — the flag lives in session memory anyway */
  }
}

/* ── State transitions ──────────────────────────────────────────────────
 *
 * NO half-state GUARANTEE (paramount — we never lose data):
 *  - enableWiped: the "wiped" flag is set ONLY after a confirmed server wipe;
 *    failure → we stay "off" (synced), server untouched (replace is atomic),
 *  - disableLocal from "wiped": local data is uploaded to the server BEFORE lifting the flag;
 *    failure → the flag stays "wiped" (nothing uploaded, replace is atomic),
 *  - enablePaused/disableLocal from "paused": does NOT touch the server destructively —
 *    paused→off is exactly offline→online (outbox flush + pull). */

let deps: LocalModeDeps | null = null;

/** Wire the higher-layer effects in (called ONCE by the facade at composition time). */
export function configureLocalMode(d: LocalModeDeps): void {
  deps = d;
}

function requireDeps(): LocalModeDeps {
  if (!deps) throw new Error("sync/localMode: not configured"); // composition bug — never user-reachable
  return deps;
}

/**
 * Set local mode: module flag + localStorage + broadcast to other tabs +
 * UI state. "off" → "synced" state (a real cycle finalizes it via syncNow); paused/wiped
 * → "local" state.
 */
export function applyLocalMode(mode: LocalMode): void {
  const d = requireDeps();
  setLocalModeValue(mode);
  writeLocalModeToStorage(mode);
  d.broadcastLocalMode(mode);
  // Local mode supersedes the unproven state (sync is off by the user's own choice, and the local
  // UI says so); leaving it "off" re-proves from scratch on the next cycle.
  d.setOwnerUnproven(false);
  d.setState(mode === "off" ? "synced" : "local");
}

/**
 * "Work offline" (paused) — NON-DESTRUCTIVE and immediate: sync suspended,
 * server data STAYS, outbox PRESERVED (flushes on resume). No network.
 */
export function enablePaused(): void {
  applyLocalMode("paused");
}

/**
 * "Enable local mode and delete server data" (wiped) — DESTRUCTIVE for the server.
 *
 * ORDER is critical for "we never lose data": FIRST we raise the gate
 * (the "wiped" flag + broadcast to other tabs), ONLY THEN we wipe the server.
 * Otherwise the wipe would run with the gate DOWN and a concurrent cycle — from the
 * interval / focus / online / visible / poke, or a cycle ALREADY in flight — would pull
 * in the wipe's DELETEs (budgetId unchanged, resetRequired=false) and clear the local
 * mirror: catastrophe (local EMPTY and server EMPTY). The "wiped" gate (a) blocks every
 * NEW cycle (syncNow) and in ALL tabs (broadcast), (b) makes an in-flight cycle
 * bail in its dirty loop. An in-flight cycle may however be in the
 * middle of doPull (no mode re-check) — so we let it FINISH (awaitInFlightCycle) on
 * the PRE-wipe state, BEFORE we wipe the server. Only then the wipe.
 *
 * Wipe failure (replace atomic ⇒ server untouched) → we go back to "off"
 * (synced, local data intact) and rethrow; no cycle started in the meantime
 * (the gate was up, and the in-flight cycle finished), so the return to "off" is clean.
 */
export async function enableWiped(): Promise<void> {
  const d = requireDeps();
  applyLocalMode("wiped"); // gate UP (this tab + others) BEFORE destroying the server
  await d.awaitInFlightCycle(); // finish the in-flight cycle on the PRE-wipe state
  try {
    await d.wipeServer(); // atomic: success ⇒ server empty; failure ⇒ server untouched
  } catch (e) {
    applyLocalMode("off"); // clean failure → back to "off" (server and local untouched)
    throw e;
  }
  outbox.clearAll(); // server empty; local mirror canonical (comes back via "Disable local mode")
}

/**
 * "Disable local mode" — resume synchronization.
 *  - from "wiped": upload local data to the (empty) server, ONLY THEN lift the flag;
 *    failure → the flag stays "wiped" (rethrow; nothing uploaded). EXCEPT when there is nothing
 *    to upload: an empty replica bound to no budget (the mirror was cleared while the mode was
 *    on) would REPLACE the session user's budget with an empty ledger — the one and only thing
 *    such a replica can do. Then we simply resume normal sync and let the boot bootstrap from
 *    the server (whatever it holds, it survives),
 *  - from "paused": lift the flag and run a cycle (outbox flush + pull) — exactly
 *    offline→online; server untouched, no replace.
 */
export async function disableLocal(): Promise<void> {
  const d = requireDeps();
  if (getLocalMode() === "wiped") {
    if (d.isEmptyUnboundReplica()) {
      applyLocalMode("off"); // nothing to restore — do NOT push an empty ledger over the server
      if (typeof location !== "undefined") location.reload(); // boot bootstraps from the server
      return;
    }
    await d.pushLocalToServer(); // throws on failure → localMode stays "wiped"
    applyLocalMode("off");
  } else if (getLocalMode() === "paused") {
    applyLocalMode("off");
    void d.syncNow("resume");
  }
}
