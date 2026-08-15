/** One login choice controls both cookie lifetime and whether a local replica is persisted. */
export type DeviceStoragePolicy = "persistent" | "session";
export type Deployment = "selfhost" | "cloud";

const POLICY_KEY = "enveo.deviceStoragePolicy";
const LEGACY_TRUST_KEY = "enveo.deviceTrust";
const DEPLOYMENT_KEY = "enveo.deployment";

function storePolicy(value: DeviceStoragePolicy): boolean {
  try {
    localStorage.setItem(POLICY_KEY, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Missing policy stays persistent for existing/self-hosted installs. The old trust flag is
 * migrated synchronously because backend selection happens before any async boot work.
 */
export function getDeviceStoragePolicy(): DeviceStoragePolicy {
  try {
    const current = localStorage.getItem(POLICY_KEY);
    if (current === "session" || current === "persistent") return current;
    const legacy = localStorage.getItem(LEGACY_TRUST_KEY);
    const migrated: DeviceStoragePolicy = legacy === "untrusted" ? "session" : "persistent";
    if (legacy && storePolicy(migrated)) localStorage.removeItem(LEGACY_TRUST_KEY);
    return migrated;
  } catch {
    return "persistent";
  }
}

export function setDeviceStoragePolicy(value: DeviceStoragePolicy): boolean {
  try {
    if (!storePolicy(value)) return false;
    localStorage.removeItem(LEGACY_TRUST_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Recovery/reset may clear the non-account policy so the next login uses deployment defaults. */
export function clearDeviceStoragePolicy(): void {
  try {
    localStorage.removeItem(POLICY_KEY);
    localStorage.removeItem(LEGACY_TRUST_KEY);
  } catch {
    /* ignore */
  }
}

export function getCachedDeployment(): Deployment {
  try {
    return localStorage.getItem(DEPLOYMENT_KEY) === "cloud" ? "cloud" : "selfhost";
  } catch {
    return "selfhost";
  }
}

export function cacheDeployment(deployment: Deployment): void {
  try {
    localStorage.setItem(DEPLOYMENT_KEY, deployment);
  } catch {
    /* ignore */
  }
}
