/**
 * uiLang() vs the guest-mode settings gate (registry.ts).
 *
 * uiLang() is the non-React / pre-boot reader of the UI language (main.tsx's
 * locale preload, data.ts, api.ts). It must route through the same gate as
 * the React Settings context (settingsPersist.loadPersistedSettings()): a
 * guest device (storageMode() "memory-forced") must not read a previous
 * trusted user's on-disk `lang` — it should fall back to detectLang(), same
 * as contexts.tsx does for the rest of settings. localStorage stub + reset
 * pattern as in settingsPersist.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { __resetStorageForTests } from "../idb";
import { detectLang, uiLang } from "./registry";

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

describe("uiLang() vs device trust", () => {
  test("trusted device: reads lang from on-disk settings", () => {
    stubLocalStorage({ "enveo.settings": '{"lang":"pl"}' });
    __resetStorageForTests();
    expect(uiLang()).toBe("pl");
  });

  test("guest mode: ignores a stranger's on-disk lang, falls back to detectLang()", () => {
    stubLocalStorage({
      "enveo.deviceTrust": "untrusted",
      "enveo.settings": '{"lang":"pl"}',
    });
    __resetStorageForTests();
    expect(uiLang()).toBe(detectLang());
  });
});
