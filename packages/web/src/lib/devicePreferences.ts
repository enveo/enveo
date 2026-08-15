import { idbDelete, idbGet, idbPut } from "./idb";

const DEVICE_PREFERENCES_KEY = "devicePreferences";

export interface DevicePreferences {
  schemaVersion: 1;
  discreet: boolean;
}

export type DevicePreferencesPatch = Partial<Omit<DevicePreferences, "schemaVersion">>;

export const DEFAULT_DEVICE_PREFERENCES: DevicePreferences = { schemaVersion: 1, discreet: false };

export interface DevicePreferencesStoreDeps {
  load(): Promise<unknown>;
  save(value: DevicePreferences): Promise<void>;
  remove(): Promise<void>;
}

function parseDevicePreferences(raw: unknown): DevicePreferences | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  if (source.schemaVersion !== 1 || typeof source.discreet !== "boolean") return null;
  return { schemaVersion: 1, discreet: source.discreet };
}

export function createDevicePreferencesStore(deps: DevicePreferencesStoreDeps) {
  let snapshot = DEFAULT_DEVICE_PREFERENCES;
  let hydratePromise: Promise<void> | null = null;
  let editGeneration = 0;
  let persistChain = Promise.resolve();
  let canonicalPresent = false;
  const listeners = new Set<() => void>();

  function publish(value: DevicePreferences): void {
    snapshot = value;
    for (const listener of listeners) listener();
  }

  function hydrate(): Promise<void> {
    if (!hydratePromise) {
      const generation = editGeneration;
      hydratePromise = deps
        .load()
        .then((raw) => {
          if (editGeneration !== generation) return;
          const parsed = parseDevicePreferences(raw);
          canonicalPresent = parsed !== null;
          publish(parsed ?? DEFAULT_DEVICE_PREFERENCES);
        })
        .catch(() => {
          if (editGeneration === generation) publish(DEFAULT_DEVICE_PREFERENCES);
        });
    }
    return hydratePromise;
  }

  async function update(patch: DevicePreferencesPatch): Promise<void> {
    const next = { ...snapshot, ...patch };
    if (typeof next.discreet !== "boolean") throw new Error("invalid_device_preferences");
    editGeneration++;
    canonicalPresent = true;
    publish(next);
    persistChain = persistChain.then(() => deps.save(next));
    await persistChain;
  }

  async function clear(): Promise<void> {
    editGeneration++;
    canonicalPresent = false;
    hydratePromise = null;
    publish(DEFAULT_DEVICE_PREFERENCES);
    await persistChain.catch(() => {});
    await deps.remove();
  }

  return {
    hydrate,
    update,
    clear,
    getSnapshot: () => snapshot,
    migrationState: () => ({ value: snapshot, present: canonicalPresent }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const devicePreferences = createDevicePreferencesStore({
  load: () => idbGet("meta", DEVICE_PREFERENCES_KEY),
  save: (value) => idbPut("meta", value, DEVICE_PREFERENCES_KEY),
  remove: () => idbDelete("meta", DEVICE_PREFERENCES_KEY),
});
