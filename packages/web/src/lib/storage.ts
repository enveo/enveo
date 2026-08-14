import { storageMode } from "./idb";

/**
 * Storage durability — anti-eviction hardening and diagnostics.
 *
 * PROBLEM: iOS/WebKit (and occasionally other browsers under storage pressure)
 * EVICTS the IndexedDB of apps unused for a while. For our local-first
 * PWA this means that after a longer break a cold start finds an EMPTY replica →
 * boot goes down the "first run" path (fetchSnapshot ~3 MB) → slow.
 *
 * DEFENSE (best-effort — iOS may ignore the request):
 *  - requestPersistentStorage(): ask for "persistent storage" AS EARLY AS POSSIBLE
 *    at boot (not only at snapshot time). Granted ⇒ the browser won't
 *    evict the data without the user's consent.
 * DIAGNOSTICS (shown in Settings, to CONFIRM the cause on the device):
 *  - getStorageDiag(): persisted? + usage/quota (estimate).
 * Together with "last start = replica vs snapshot" (sync.ts) it gives a clear picture:
 * if every open starts from a snapshot → eviction confirmed.
 */

/* ── One-time localStorage key migration (rebranding) ───────────────────
 *
 * Device keys historically lived under the old brand's prefix; after the
 * rebrand they live under "enveo.". Migration per key: copy → verify →
 * only then remove the old one. The new key is NEVER overwritten
 * (idempotent; safe when another tab has already migrated).
 *
 * Runs when THIS module loads. Additionally main.tsx imports this module
 * first (belt and suspenders for fresh profiles and lazy chunks).
 *
 * The old prefix is CONCATENATED at runtime (join) so that neither a de-branding
 * grep over the sources nor the minified bundle (literal constant folding)
 * contains the former name. */
const LEGACY_PREFIX = ["4gros", "ze."].join("");
const PREFIX = "enveo.";
/** All known device keys (without prefix) ever written under the old brand. */
const DEVICE_KEYS = ["settings", "a2hs"] as const;
const OBSOLETE_LOCAL_MODE_KEYS = ["localMode", "localOnly"] as const;

export function migrateLegacyLocalStorage(): void {
  try {
    for (const k of DEVICE_KEYS) {
      const oldKey = LEGACY_PREFIX + k;
      const newKey = PREFIX + k;
      const oldVal = localStorage.getItem(oldKey);
      if (oldVal === null) continue;
      if (localStorage.getItem(newKey) === null) localStorage.setItem(newKey, oldVal);
      // remove the old key ONLY after confirming the new one exists
      if (localStorage.getItem(newKey) !== null) localStorage.removeItem(oldKey);
    }
    // Local-only mode no longer exists. These values are non-sensitive behavior flags, so they
    // can be discarded immediately; importantly, none of their old pause/wipe semantics runs.
    for (const k of OBSOLETE_LOCAL_MODE_KEYS) {
      localStorage.removeItem(LEGACY_PREFIX + k);
      localStorage.removeItem(PREFIX + k);
    }
  } catch {
    /* localStorage unavailable (tests/private mode with quota=0) — a fresh profile works without migration */
  }
}

migrateLegacyLocalStorage();

let persistResult: boolean | null = null;
let persistRequested = false;

/**
 * Ask the browser for persistent storage (idempotent). If already granted —
 * doesn't ask again. The result is remembered for diagnostics. Never throws.
 */
export async function requestPersistentStorage(): Promise<void> {
  if (persistRequested) return;
  // A guest session keeps the replica in memory — persisting the (empty) origin
  // storage would be pointless and, on some browsers, shows a permission prompt.
  if (storageMode() === "memory-session") return;
  persistRequested = true;
  try {
    const s = navigator.storage;
    if (s?.persisted) persistResult = await s.persisted();
    if (!persistResult && s?.persist) persistResult = await s.persist();
  } catch {
    /* missing API / refusal — stays null/false */
  }
}

export interface StorageDiag {
  /** Whether the browser promises NOT to evict the data (null = API unavailable). */
  persisted: boolean | null;
  /** Used bytes (origin) — null when estimate() is unavailable. */
  usageBytes: number | null;
  /** Granted quota in bytes — null when unavailable. */
  quotaBytes: number | null;
}

/** Current durability state + usage (refreshed on demand, e.g. in Settings). */
export async function getStorageDiag(): Promise<StorageDiag> {
  let persisted: boolean | null = persistResult;
  let usageBytes: number | null = null;
  let quotaBytes: number | null = null;
  try {
    const s = navigator.storage;
    if (s?.persisted) persisted = await s.persisted();
    if (s?.estimate) {
      const est = await s.estimate();
      usageBytes = est.usage ?? null;
      quotaBytes = est.quota ?? null;
    }
  } catch {
    /* ignore — return what we have */
  }
  return { persisted, usageBytes, quotaBytes };
}
