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
import { detectLang, LOCALES, uiLang, type Lang } from "./registry";

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

/**
 * The provenance baseline (§5d). `community: true` is what puts "Community translation — it may
 * be incomplete." and the "Report a fix" link in front of the user, so the flag is a PROMISE, not
 * decoration: these eight dictionaries were not written by native speakers of their languages.
 *
 * Losing the flag is a silent failure — the app keeps working and simply stops disclosing. So the
 * baseline is pinned here by name. Promoting a locale out of community status is allowed, but it
 * costs one deliberate line in this test, and it may only follow a maintainer-recorded COMPLETE
 * native review: isolated corrections, or another agent pass over the file, do not qualify.
 */
const NATIVE_LOCALES: readonly Lang[] = ["en", "pl"];
const COMMUNITY_LOCALES: readonly Lang[] = ["de", "es", "fr", "it", "nl", "pt-BR", "cs", "sv"];

describe("locale registry provenance", () => {
  test("exactly `en` and `pl` are non-community", () => {
    const native = LOCALES.filter((l) => !l.community).map((l) => l.code);
    expect(native.sort()).toEqual([...NATIVE_LOCALES].sort());
  });

  test("the eight community translations stay labelled as such", () => {
    const community = LOCALES.filter((l) => l.community).map((l) => l.code);
    expect(community.sort()).toEqual([...COMMUNITY_LOCALES].sort());
  });

  test("the registry holds every locale and nothing else — a new language updates this test", () => {
    expect(LOCALES.map((l) => l.code).sort()).toEqual([...NATIVE_LOCALES, ...COMMUNITY_LOCALES].sort());
  });

  test("every entry is usable: unique code, an endonym, and a loader", () => {
    expect(new Set(LOCALES.map((l) => l.code)).size).toBe(LOCALES.length);
    for (const locale of LOCALES) {
      expect(locale.endonym.trim().length).toBeGreaterThan(0);
      expect(typeof locale.load).toBe("function");
    }
  });
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
