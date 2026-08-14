import { afterEach, describe, expect, test } from "bun:test";
import { createDefaultAccountPreferences, createDefaultBudgetPreferences } from "@enveo/shared";
import { __resetStorageForTests } from "./idb";
import { runLegacySettingsMigration } from "./legacySettingsMigration";
import { clearPersistedSettings, legacyCredentialMigration, loadPersistedSettings, persistSettings, readLegacySettings } from "./settingsPersist";

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

  test("reports an existing BYOK as pending Stage 3 and migration preserves its bytes", async () => {
    const raw = '{ "aiMode": "byok", "openaiKey": "sk-byte-for-byte", "openaiModel": "gpt-5.5-mini" }';
    const storage = stubLocalStorage({ "enveo.settings": raw });
    __resetStorageForTests();

    expect(legacyCredentialMigration()).toBe("pending-stage-3");
    await runLegacySettingsMigration({
      readLegacy: () => readLegacySettings()?.value ?? null,
      loadAck: async () => ({ schemaVersion: 1 }),
      saveAck: async () => {},
      accountState: () => ({ value: createDefaultAccountPreferences(), revision: 0, dirty: {} }),
      updateAccount: async () => {},
      budgetState: createDefaultBudgetPreferences,
      updateBudget: async () => {},
      deviceState: () => ({ value: { schemaVersion: 1, discreet: false }, present: false }),
      updateDevice: async () => {},
    });
    expect(readLegacySettings()?.raw).toBe(raw);
    expect(storage.values.get("enveo.settings")).toBe(raw);
    expect(storage.removed).toEqual([]);
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
