/**
 * Settings persistence vs device trust (settingsPersist.ts).
 *
 * Guest mode ("memory-forced") is gated in BOTH directions: a guest neither
 * INHERITS the previous user's on-disk settings (the BYOK OpenAI key lives
 * there) nor leaves any of their own on disk. Trusted devices keep today's
 * behavior byte-identically. localStorage stub as in storageBackend.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { __resetStorageForTests } from "./idb";
import { clearPersistedSettings, loadPersistedSettings, persistSettings } from "./settingsPersist";

function stubLocalStorage(initial: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(initial));
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
  return m;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage;
  __resetStorageForTests();
});

describe("trusted device (flag absent) — behavior identical to before", () => {
  test("persist → load round-trip", () => {
    stubLocalStorage();
    __resetStorageForTests();
    persistSettings({ themeMode: "dark", openaiKey: "sk-x" });
    expect(loadPersistedSettings()).toEqual({ themeMode: "dark", openaiKey: "sk-x" });
  });
  test("absent key → null; unparsable JSON → null", () => {
    const m = stubLocalStorage();
    __resetStorageForTests();
    expect(loadPersistedSettings()).toBeNull();
    m.set("enveo.settings", "{broken");
    expect(loadPersistedSettings()).toBeNull();
  });
  test("clearPersistedSettings removes the key", () => {
    const m = stubLocalStorage({ "enveo.settings": '{"themeMode":"dark"}' });
    __resetStorageForTests();
    clearPersistedSettings();
    expect(m.has("enveo.settings")).toBe(false);
  });
});

describe("guest mode (memory-forced) — no disk in either direction", () => {
  test("persist is a no-op (an entered BYOK key never reaches localStorage)", () => {
    const m = stubLocalStorage({ "enveo.deviceTrust": "untrusted" });
    __resetStorageForTests();
    persistSettings({ openaiKey: "sk-guest" });
    expect(m.has("enveo.settings")).toBe(false);
  });
  test("load ignores on-disk settings (a guest must not inherit a stranger's key)", () => {
    stubLocalStorage({
      "enveo.deviceTrust": "untrusted",
      "enveo.settings": '{"openaiKey":"sk-LEAK","themeMode":"dark"}',
    });
    __resetStorageForTests();
    expect(loadPersistedSettings()).toBeNull();
  });
});
