/**
 * Device-trust flag + deployment cache (deviceTrust.ts).
 *
 * A localStorage stub on globalThis — bun test has no DOM. The two invariants:
 * absent trust flag = trusted (grandfathering: every pre-flag device keeps
 * today's behavior), absent deployment = selfhost (conservative default: it
 * protects against data loss, not exposure).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cacheDeployment, clearDeviceTrust, getCachedDeployment, getDeviceTrust, setDeviceTrust } from "./deviceTrust";

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
});

describe("getDeviceTrust", () => {
  test("absent flag = trusted (every pre-flag device keeps today's behavior)", () => {
    stubLocalStorage();
    expect(getDeviceTrust()).toBe("trusted");
  });
  test("only the exact value 'untrusted' flips it — garbage degrades to trusted", () => {
    const m = stubLocalStorage({ "enveo.deviceTrust": "untrusted" });
    expect(getDeviceTrust()).toBe("untrusted");
    m.set("enveo.deviceTrust", "banana");
    expect(getDeviceTrust()).toBe("trusted");
  });
  test("no localStorage at all (private mode / tests) = trusted", () => {
    expect(getDeviceTrust()).toBe("trusted");
  });
  test("set + clear round-trip", () => {
    stubLocalStorage();
    setDeviceTrust("untrusted");
    expect(getDeviceTrust()).toBe("untrusted");
    clearDeviceTrust();
    expect(getDeviceTrust()).toBe("trusted");
  });
});

describe("deployment cache", () => {
  test("absent = selfhost (conservative wrt data loss)", () => {
    stubLocalStorage();
    expect(getCachedDeployment()).toBe("selfhost");
  });
  test("cache round-trip", () => {
    stubLocalStorage();
    cacheDeployment("cloud");
    expect(getCachedDeployment()).toBe("cloud");
  });
});
