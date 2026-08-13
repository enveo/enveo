










import * as outbox from "../outbox";
import type { LocalMode, LocalModeDeps } from "./contracts";

const LOCAL_MODE_KEY = "enveo.localMode";
const LEGACY_LOCAL_KEY = "enveo.localOnly";

function readLocalMode(): LocalMode {
  try {
    const v = localStorage.getItem(LOCAL_MODE_KEY);
    if (v === "off" || v === "paused" || v === "wiped") return v;
    if (localStorage.getItem(LEGACY_LOCAL_KEY) === "true") {
       
      try {
        localStorage.setItem(LOCAL_MODE_KEY, "paused");
        localStorage.removeItem(LEGACY_LOCAL_KEY);
      } catch {
         
      }
      return "paused";
    }
  } catch {
     
  }
  return "off";
}

let localMode: LocalMode = readLocalMode();

 
export function getLocalMode(): LocalMode {
  return localMode;
}

 
export function isLocalOnly(): boolean {
  return localMode !== "off";
}






export function setLocalModeValue(mode: LocalMode): void {
  localMode = mode;
}

 
export function writeLocalModeToStorage(mode: LocalMode): void {
  try {
    localStorage.setItem(LOCAL_MODE_KEY, mode);
  } catch {
     
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

 
export function configureLocalMode(d: LocalModeDeps): void {
  deps = d;
}

function requireDeps(): LocalModeDeps {
  if (!deps) throw new Error("sync/localMode: not configured"); // composition bug — never user-reachable
  return deps;
}






export function applyLocalMode(mode: LocalMode): void {
  const d = requireDeps();
  setLocalModeValue(mode);
  writeLocalModeToStorage(mode);
  d.broadcastLocalMode(mode);
  

  d.setOwnerUnproven(false);
  d.setState(mode === "off" ? "synced" : "local");
}





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
  applyLocalMode("wiped");  
  await d.awaitInFlightCycle();  
  try {
    await d.wipeServer(); // atomic: success ⇒ server empty; failure ⇒ server untouched
  } catch (e) {
    applyLocalMode("off");  
    throw e;
  }
  outbox.clearAll();  
}












export async function disableLocal(): Promise<void> {
  const d = requireDeps();
  if (getLocalMode() === "wiped") {
    if (d.isEmptyUnboundReplica()) {
      applyLocalMode("off"); // nothing to restore — do NOT push an empty ledger over the server
      if (typeof location !== "undefined") location.reload();  
      return;
    }
    await d.pushLocalToServer();  
    applyLocalMode("off");
  } else if (getLocalMode() === "paused") {
    applyLocalMode("off");
    void d.syncNow("resume");
  }
}
