import { describe, expect, it } from "bun:test";
import { createDevicePreferencesStore, DEFAULT_DEVICE_PREFERENCES } from "./devicePreferences";

function fixture(initial?: unknown) {
  let persisted = initial;
  const store = createDevicePreferencesStore({
    load: async () => persisted,
    save: async (value) => {
      persisted = structuredClone(value);
    },
    remove: async () => {
      persisted = undefined;
    },
  });
  return { store, persisted: () => persisted };
}

describe("device preference store", () => {
  it("uses defaults for absent or malformed device state", async () => {
    const f = fixture({ schemaVersion: 1, discreet: "yes" });
    await f.store.hydrate();
    expect(f.store.getSnapshot()).toEqual(DEFAULT_DEVICE_PREFERENCES);
  });

  it("persists only device-scoped preferences in the selected backend", async () => {
    const f = fixture();
    await f.store.hydrate();
    await f.store.update({ discreet: true });

    expect(f.persisted()).toEqual({ schemaVersion: 1, discreet: true, themeModeOverride: null, accentThemeOverride: null });
    expect(f.store.getSnapshot().discreet).toBe(true);
  });

  it("reads a pre-existing record with no override keys as unoverridden (field added later)", async () => {
    const f = fixture({ schemaVersion: 1, discreet: true });
    await f.store.hydrate();
    expect(f.store.getSnapshot()).toEqual({ schemaVersion: 1, discreet: true, themeModeOverride: null, accentThemeOverride: null });
  });

  it("round-trips a theme override independently of discreet", async () => {
    const f = fixture();
    await f.store.hydrate();
    await f.store.update({ themeModeOverride: "dark" });
    await f.store.update({ accentThemeOverride: "duet" });

    expect(f.store.getSnapshot()).toEqual({ schemaVersion: 1, discreet: false, themeModeOverride: "dark", accentThemeOverride: "duet" });
    expect(f.persisted()).toEqual({ schemaVersion: 1, discreet: false, themeModeOverride: "dark", accentThemeOverride: "duet" });
  });

  it("clears an override back to null (falls back to the account preference)", async () => {
    const f = fixture({ schemaVersion: 1, discreet: false, themeModeOverride: "dark", accentThemeOverride: "duet" });
    await f.store.hydrate();
    await f.store.update({ themeModeOverride: null, accentThemeOverride: null });

    expect(f.store.getSnapshot()).toEqual({ schemaVersion: 1, discreet: false, themeModeOverride: null, accentThemeOverride: null });
  });

  it("rejects an invalid override value", async () => {
    const f = fixture();
    await f.store.hydrate();
    await expect(f.store.update({ themeModeOverride: "sepia" as never })).rejects.toThrow("invalid_device_preferences");
  });

  it("clears both the backend record and in-memory snapshot on explicit sign-out", async () => {
    const f = fixture({ schemaVersion: 1, discreet: true });
    await f.store.hydrate();
    await f.store.clear();

    expect(f.persisted()).toBeUndefined();
    expect(f.store.getSnapshot()).toEqual(DEFAULT_DEVICE_PREFERENCES);
  });

  it("does not let a late hydration overwrite an optimistic edit", async () => {
    let finishLoad!: (value: unknown) => void;
    const loading = new Promise<unknown>((resolve) => {
      finishLoad = resolve;
    });
    let persisted: unknown;
    const store = createDevicePreferencesStore({
      load: () => loading,
      save: async (value) => {
        persisted = value;
      },
      remove: async () => {},
    });

    const hydrate = store.hydrate();
    await store.update({ discreet: true });
    finishLoad({ schemaVersion: 1, discreet: false });
    await hydrate;

    expect(store.getSnapshot().discreet).toBe(true);
    expect(persisted).toEqual({ schemaVersion: 1, discreet: true, themeModeOverride: null, accentThemeOverride: null });
  });
});
