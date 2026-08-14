import { describe, expect, it } from "bun:test";
import { type AccountPreferences, createDefaultAccountPreferences } from "@enveo/shared";
import { type AccountPreferencesCache, type AccountPreferencesRemote, createAccountPreferencesStore } from "./accountPreferences";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(initial?: unknown) {
  let persisted = initial;
  const remote = createDefaultAccountPreferences();
  const patches: Array<{ userId: string; patch: Partial<AccountPreferences> }> = [];
  let patchRemote = async (userId: string, patch: Partial<AccountPreferences>): Promise<AccountPreferencesRemote> => {
    patches.push({ userId, patch });
    Object.assign(remote, patch);
    return { ...remote, revision: patches.length };
  };
  const store = createAccountPreferencesStore({
    load: async () => persisted,
    save: async (value) => {
      persisted = structuredClone(value);
    },
    remove: async () => {
      persisted = undefined;
    },
    getRemote: async () => ({ ...remote, revision: 0 }),
    patchRemote: (userId, patch) => patchRemote(userId, patch),
  });
  return {
    store,
    patches,
    persisted: () => persisted as AccountPreferencesCache | undefined,
    setPatchRemote(fn: typeof patchRemote) {
      patchRemote = fn;
    },
  };
}

describe("account preference cache", () => {
  it("never exposes a cache stamped for another account", async () => {
    const f = fixture({
      userId: "user-a",
      value: { ...createDefaultAccountPreferences(), lang: "pl", themeMode: "dark" },
      revision: 4,
      dirty: {},
      editGeneration: {},
    });

    await f.store.hydrateForUser("user-b");

    expect(f.store.getSnapshot()).toEqual(createDefaultAccountPreferences());
    expect(f.persisted()?.userId).toBe("user-a");
  });

  it("falls back to defaults for corrupt or unstamped cache data", async () => {
    const f = fixture({ value: { lang: "pl" } });

    await f.store.hydrateForUser("user-a");

    expect(f.store.getSnapshot()).toEqual(createDefaultAccountPreferences());
  });

  it("hides account state on logout without deleting offline edits", async () => {
    const f = fixture();
    await f.store.hydrateForUser("user-a");
    await f.store.update({ lang: "pl" });

    f.store.dehydrate();

    expect(f.store.getSnapshot()).toEqual(createDefaultAccountPreferences());
    expect(f.persisted()?.value.lang).toBe("pl");
    expect(f.persisted()?.dirty).toEqual({ lang: true });
  });

  it("persists optimistic offline edits and reloads their dirty state", async () => {
    const f = fixture();
    await f.store.hydrateForUser("user-a");

    await f.store.update({ lang: "pl" });
    const reloaded = fixture(f.persisted());
    await reloaded.store.hydrateForUser("user-a");

    expect(reloaded.store.getSnapshot().lang).toBe("pl");
    expect(reloaded.persisted()?.dirty).toEqual({ lang: true });
  });

  it("does not overwrite an edit made while a different field is being patched", async () => {
    const f = fixture();
    await f.store.hydrateForUser("user-a");
    await f.store.update({ themeMode: "dark" });
    const response = deferred<AccountPreferencesRemote>();
    f.setPatchRemote(async (_userId, patch) => {
      f.patches.push({ userId: "user-a", patch });
      return response.promise;
    });

    const syncing = f.store.sync("user-a");
    await Promise.resolve();
    await f.store.update({ lang: "pl" });
    response.resolve({ ...createDefaultAccountPreferences(), themeMode: "dark", revision: 8 });
    await syncing;

    expect(f.store.getSnapshot()).toEqual({ ...createDefaultAccountPreferences(), lang: "pl", themeMode: "dark" });
    expect(f.persisted()?.dirty).toEqual({ lang: true });
    expect(f.patches).toEqual([{ userId: "user-a", patch: { themeMode: "dark" } }]);
  });

  it("merges canonical fields only when no newer local edit exists", async () => {
    const f = fixture();
    await f.store.hydrateForUser("user-a");
    const response = deferred<AccountPreferencesRemote>();
    f.setPatchRemote(async () => response.promise);
    await f.store.update({ accentTheme: "duet" });

    const syncing = f.store.sync("user-a");
    await Promise.resolve();
    await f.store.update({ accentTheme: "teal", lang: "pl" });
    response.resolve({ ...createDefaultAccountPreferences(), accentTheme: "duet", themeMode: "auto", revision: 3 });
    await syncing;

    expect(f.store.getSnapshot()).toEqual({ ...createDefaultAccountPreferences(), accentTheme: "teal", lang: "pl", themeMode: "auto" });
    expect(f.persisted()?.dirty).toEqual({ accentTheme: true, lang: true });
  });
});
