import { afterEach, describe, expect, test } from "bun:test";
import { __resetStorageForTests } from "./idb";
import {
  clearPersistedSettings,
  legacyCredentialMigration,
  loadPersistedSettings,
  persistSettings,
  readLegacySettings,
  removeLegacySettingsIfUnchanged,
} from "./settingsPersist";

function stubLocalStorage(initial: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(initial));
  const removed: string[] = [];
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => {
      removed.push(key);
      values.delete(key);
    },
  };
  return { values, removed };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage;
  __resetStorageForTests();
});

describe("legacy settings quarantine", () => {
  test("strictly accepts the known legacy shape and rejects malformed or unknown fields", () => {
    const storage = stubLocalStorage({
      "enveo.settings": JSON.stringify({ themeMode: "dark", lang: "pl", aiMode: "byok", openaiKey: "sk-old", openaiModel: "gpt-5.5" }),
    });
    __resetStorageForTests();
    expect(loadPersistedSettings()).toEqual({ themeMode: "dark", lang: "pl", aiMode: "byok", openaiKey: "sk-old", openaiModel: "gpt-5.5" });

    storage.values.set("enveo.settings", JSON.stringify({ themeMode: "sepia", unknown: true }));
    expect(loadPersistedSettings()).toBeNull();
  });

  test("reports the tier-specific migration and removes only the exact inspected bytes", () => {
    const raw = '{ "aiMode": "byok", "openaiKey": "sk-byte-for-byte", "openaiModel": "gpt-5.5-mini" }';
    const storage = stubLocalStorage({ "enveo.settings": raw });
    __resetStorageForTests();

    expect(legacyCredentialMigration("plain")).toBe("pending-vault");
    expect(legacyCredentialMigration("e2ee")).toBe("pending-stage-4");
    expect(readLegacySettings()?.raw).toBe(raw);
    expect(removeLegacySettingsIfUnchanged("different bytes")).toBe(false);
    expect(storage.values.get("enveo.settings")).toBe(raw);
    expect(removeLegacySettingsIfUnchanged(raw)).toBe(true);
    expect(storage.values.has("enveo.settings")).toBe(false);
    expect(storage.removed).toEqual(["enveo.settings"]);
  });

  test("all new generic settings writes are disabled during quarantine", () => {
    const raw = '{"openaiKey":"sk-existing"}';
    const storage = stubLocalStorage({ "enveo.settings": raw });
    __resetStorageForTests();

    persistSettings({ openaiKey: "sk-new", themeMode: "dark" });

    expect(storage.values.get("enveo.settings")).toBe(raw);
  });

  test("explicit account removal may still clear the quarantined credential", () => {
    const storage = stubLocalStorage({ "enveo.settings": '{"openaiKey":"sk-existing"}' });
    __resetStorageForTests();
    clearPersistedSettings();
    expect(storage.values.has("enveo.settings")).toBe(false);
  });
});

describe("session device", () => {
  test("does not read a previous persistent user's legacy credential", () => {
    stubLocalStorage({
      "enveo.deviceStoragePolicy": "session",
      "enveo.settings": '{"openaiKey":"sk-LEAK","themeMode":"dark"}',
    });
    __resetStorageForTests();
    expect(loadPersistedSettings()).toBeNull();
    expect(legacyCredentialMigration()).toBeNull();
  });
});
