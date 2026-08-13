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
import type { LocalMode } from "./contracts";

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
