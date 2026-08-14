import { afterEach, describe, expect, test } from "bun:test";
import { cacheDeployment, clearDeviceStoragePolicy, getCachedDeployment, getDeviceStoragePolicy, setDeviceStoragePolicy } from "./deviceStoragePolicy";

function stubLocalStorage(initial: Record<string, string> = {}, failSet = false) {
  const values = new Map<string, string>(Object.entries(initial));
  const removed: string[] = [];
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failSet) throw new Error("quota");
      values.set(key, String(value));
    },
    removeItem: (key: string) => {
      removed.push(key);
      values.delete(key);
    },
  };
  return { values, removed };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage;
});

describe("device storage policy", () => {
  test("missing state defaults to persistent for existing self-hosted installs", () => {
    stubLocalStorage();
    expect(getDeviceStoragePolicy()).toBe("persistent");
  });

  test("migrates trusted → persistent and untrusted → session", () => {
    const trusted = stubLocalStorage({ "enveo.deviceTrust": "trusted" });
    expect(getDeviceStoragePolicy()).toBe("persistent");
    expect(trusted.values.get("enveo.deviceStoragePolicy")).toBe("persistent");
    expect(trusted.values.has("enveo.deviceTrust")).toBe(false);

    const session = stubLocalStorage({ "enveo.deviceTrust": "untrusted" });
    expect(getDeviceStoragePolicy()).toBe("session");
    expect(session.values.get("enveo.deviceStoragePolicy")).toBe("session");
    expect(session.values.has("enveo.deviceTrust")).toBe(false);
  });

  test("does not remove the old policy until the replacement was stored", () => {
    const storage = stubLocalStorage({ "enveo.deviceTrust": "untrusted" }, true);
    expect(getDeviceStoragePolicy()).toBe("session");
    expect(storage.values.get("enveo.deviceTrust")).toBe("untrusted");
    expect(storage.removed).toEqual([]);
  });

  test("set and clear operate on the new policy", () => {
    const storage = stubLocalStorage();
    expect(setDeviceStoragePolicy("session")).toBe(true);
    expect(getDeviceStoragePolicy()).toBe("session");
    clearDeviceStoragePolicy();
    expect(storage.values.has("enveo.deviceStoragePolicy")).toBe(false);
  });

  test("reports a failed write so login cannot continue with a different policy", () => {
    stubLocalStorage({}, true);
    expect(setDeviceStoragePolicy("session")).toBe(false);
  });

  test("no localStorage falls back to persistent", () => {
    expect(getDeviceStoragePolicy()).toBe("persistent");
  });
});

describe("deployment cache", () => {
  test("defaults to selfhost and round-trips cloud", () => {
    stubLocalStorage();
    expect(getCachedDeployment()).toBe("selfhost");
    cacheDeployment("cloud");
    expect(getCachedDeployment()).toBe("cloud");
  });
});
