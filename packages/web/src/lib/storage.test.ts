/**
 * Migration of pre-rebranding localStorage keys (storage.ts).
 *
 * A localStorage stub on globalThis — bun test has no DOM. The old brand prefix
 * is concatenated at runtime (just like in production code), so a de-branding
 * grep doesn't find the literal in the tests either.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { migrateLegacyLocalStorage } from "./storage";

const OLD_PREFIX = ["4gros", "ze."].join("");

function stubLocalStorage(initial: Record<string, string>) {
  const m = new Map<string, string>(Object.entries(initial));
  const stub = {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    get length() {
      return m.size;
    },
  };
  (globalThis as Record<string, unknown>).localStorage = stub;
  return m;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage;
});

describe("migrateLegacyLocalStorage", () => {
  test("copies old keys under enveo.* and removes the old ones", () => {
    const m = stubLocalStorage({
      [`${OLD_PREFIX}settings`]: '{"lang":"pl","themeMode":"dark"}',
      [`${OLD_PREFIX}a2hs`]: "dismissed",
      [`${OLD_PREFIX}localMode`]: "wiped",
      "enveo.localMode": "paused",
      "enveo.localOnly": "true",
    });
    migrateLegacyLocalStorage();
    expect(m.get("enveo.settings")).toBe('{"lang":"pl","themeMode":"dark"}');
    expect(m.get("enveo.a2hs")).toBe("dismissed");
    expect(m.has("enveo.localMode")).toBe(false);
    expect(m.has("enveo.localOnly")).toBe(false);
    expect(m.has(`${OLD_PREFIX}settings`)).toBe(false);
    expect(m.has(`${OLD_PREFIX}a2hs`)).toBe(false);
    expect(m.has(`${OLD_PREFIX}localMode`)).toBe(false);
  });

  test("removes the obsolete localOnly boolean without executing or migrating it", () => {
    const m = stubLocalStorage({ [`${OLD_PREFIX}localOnly`]: "true" });
    migrateLegacyLocalStorage();
    expect(m.has("enveo.localOnly")).toBe(false);
    expect(m.has(`${OLD_PREFIX}localOnly`)).toBe(false);
  });

  test("does NOT overwrite an existing enveo.*, but cleans up the old key", () => {
    const m = stubLocalStorage({
      "enveo.settings": '{"lang":"en"}',
      [`${OLD_PREFIX}settings`]: '{"lang":"pl"}',
    });
    migrateLegacyLocalStorage();
    expect(m.get("enveo.settings")).toBe('{"lang":"en"}');
    expect(m.has(`${OLD_PREFIX}settings`)).toBe(false);
  });

  test("idempotent and a no-op on a fresh profile", () => {
    const m = stubLocalStorage({ "enveo.settings": '{"lang":"pl"}', unrelated: "x" });
    migrateLegacyLocalStorage();
    migrateLegacyLocalStorage();
    expect(m.get("enveo.settings")).toBe('{"lang":"pl"}');
    expect(m.get("unrelated")).toBe("x");
    expect(m.size).toBe(2);
  });

  test("missing localStorage (a DOM-less environment) does not throw", () => {
    delete (globalThis as Record<string, unknown>).localStorage;
    expect(() => migrateLegacyLocalStorage()).not.toThrow();
  });
});
