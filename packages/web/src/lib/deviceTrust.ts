/**
 * Device trust — the bank-style "trusted device" choice made on the Login screen.
 *
 * ONE flag drives BOTH persistence layers (splitting them would allow dangerous
 * combos — a memory-only replica behind a 30-day cookie protects nothing):
 *  - trusted   → persistent session cookie (rememberMe) + replica in IndexedDB,
 *  - untrusted → browser-session cookie + replica in MEMORY only (idb.ts then
 *                never even opens IndexedDB — storageMode() "memory-forced").
 *
 * ABSENT = trusted: every device that existed before this flag (all selfhost
 * installs) keeps today's behavior; cloud is greenfield and its Login screen
 * writes the flag on every successful sign-in.
 *
 * The flag itself carries no data, so localStorage is fine — and it is readable
 * SYNCHRONOUSLY, which backend selection in idb.ts requires (it runs before the
 * first storage operation, outside any async context).
 */
export type DeviceTrust = "trusted" | "untrusted";
export type Deployment = "selfhost" | "cloud";

const TRUST_KEY = "enveo.deviceTrust";
const DEPLOYMENT_KEY = "enveo.deployment";

export function getDeviceTrust(): DeviceTrust {
  try {
    return localStorage.getItem(TRUST_KEY) === "untrusted" ? "untrusted" : "trusted";
  } catch {
    return "trusted"; // no localStorage (tests / private mode) — legacy behavior
  }
}

export function setDeviceTrust(v: DeviceTrust): void {
  try {
    localStorage.setItem(TRUST_KEY, v);
  } catch {
    /* ignore — the choice then lasts for this page load only */
  }
}

/** Cloud sign-out clears the choice — the next login asks again (default per deployment). */
export function clearDeviceTrust(): void {
  try {
    localStorage.removeItem(TRUST_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Deployment profile cache — written on every Login render from /api/auth/meta,
 * read where the network cannot be assumed (sign-out, ForeignReplicaScreen).
 * ABSENT = selfhost, deliberately: the selfhost semantics (keep the replica,
 * offer the backup export) protect against DATA LOSS, the cloud semantics
 * against exposure — and a device that holds a replica has rendered Login at
 * least once, so in practice the cache exists whenever it matters.
 */
export function getCachedDeployment(): Deployment {
  try {
    return localStorage.getItem(DEPLOYMENT_KEY) === "cloud" ? "cloud" : "selfhost";
  } catch {
    return "selfhost";
  }
}

export function cacheDeployment(d: Deployment): void {
  try {
    localStorage.setItem(DEPLOYMENT_KEY, d);
  } catch {
    /* ignore */
  }
}
