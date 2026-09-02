import { ACCENT_THEMES, type AccentTheme, THEME_MODES, type ThemeMode } from "@enveo/shared";
import { idbDelete, idbGet, idbPut } from "./idb";
import { isSignOutBlocking } from "./signOutBarrier";

const DEVICE_PREFERENCES_KEY = "devicePreferences";

export interface DevicePreferences {
  schemaVersion: 1;
  discreet: boolean;
  /** Per-device theme overrides (§ per-device theme, 2026-08-27): `null` means "no override —
   *  follow the account preference", same absent-vs-set convention `discreet` already used before
   *  this field existed. Set together by the Appearance scope control (contexts.tsx composes the
   *  EFFECTIVE value as `override ?? account`, the one place that resolution happens). */
  themeModeOverride: ThemeMode | null;
  accentThemeOverride: AccentTheme | null;
}

export type DevicePreferencesPatch = Partial<Omit<DevicePreferences, "schemaVersion">>;

export const DEFAULT_DEVICE_PREFERENCES: DevicePreferences = {
  schemaVersion: 1,
  discreet: false,
  themeModeOverride: null,
  accentThemeOverride: null,
};

export interface DevicePreferencesStoreDeps {
  load(): Promise<unknown>;
  save(value: DevicePreferences): Promise<void>;
  remove(): Promise<void>;
}

function isThemeModeOrNull(value: unknown): value is ThemeMode | null {
  return value === null || (typeof value === "string" && (THEME_MODES as readonly string[]).includes(value));
}

function isAccentThemeOrNull(value: unknown): value is AccentTheme | null {
  return value === null || (typeof value === "string" && (ACCENT_THEMES as readonly string[]).includes(value));
}

/** A record written before this field existed (or a same-version record from a device that never
 *  set an override) carries no key at all — `undefined`, not `null` — so it is normalised here
 *  exactly like the rest of the domain normalises a missing field: at this one parse boundary,
 *  never at each call site (see AGENTS.md "a field added in version N does not exist in every
 *  replica row"). */
function parseDevicePreferences(raw: unknown): DevicePreferences | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  if (source.schemaVersion !== 1 || typeof source.discreet !== "boolean") return null;
  const themeModeOverride = source.themeModeOverride === undefined ? null : source.themeModeOverride;
  const accentThemeOverride = source.accentThemeOverride === undefined ? null : source.accentThemeOverride;
  if (!isThemeModeOrNull(themeModeOverride) || !isAccentThemeOrNull(accentThemeOverride)) return null;
  return { schemaVersion: 1, discreet: source.discreet, themeModeOverride, accentThemeOverride };
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
    if (isSignOutBlocking()) throw new Error("sign_out_in_progress");
    const next = { ...snapshot, ...patch };
    if (typeof next.discreet !== "boolean" || !isThemeModeOrNull(next.themeModeOverride) || !isAccentThemeOrNull(next.accentThemeOverride))
      throw new Error("invalid_device_preferences");
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

  function dehydrate(): void {
    editGeneration++;
    canonicalPresent = false;
    hydratePromise = null;
    publish(DEFAULT_DEVICE_PREFERENCES);
  }

  return {
    hydrate,
    update,
    flushed: () => persistChain.catch(() => {}),
    clear,
    dehydrate,
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
