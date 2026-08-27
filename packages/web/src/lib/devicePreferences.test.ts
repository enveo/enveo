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

    expect(f.persisted()).toEqual({ schemaVersion: 1, discreet: true });
    expect(f.store.getSnapshot().discreet).toBe(true);
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
    expect(persisted).toEqual({ schemaVersion: 1, discreet: true });
  });
});
