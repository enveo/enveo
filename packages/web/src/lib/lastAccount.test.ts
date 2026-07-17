import { beforeEach, describe, expect, test } from "bun:test";
import { __resetStorageForTests } from "./idb";
import { clearLastAccountId, getLastAccountId, preferredAccountId, setLastAccountId } from "./lastAccount";

const mem = new Map<string, string>();
// @ts-expect-error localStorage stub (pattern: storage.test.ts)
globalThis.localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};

describe("lastAccount — per-device account preference", () => {
  beforeEach(() => mem.clear());
  test("write and read", () => {
    setLastAccountId("A1");
    expect(getLastAccountId()).toBe("A1");
  });
  test("preselection: the remembered active account wins over the fallback", () => {
    setLastAccountId("A2");
    expect(preferredAccountId([{ id: "A1", archived: false }, { id: "A2", archived: false }], "A1")).toBe("A2");
  });
  test("archived or nonexistent → fallback", () => {
    setLastAccountId("A2");
    expect(preferredAccountId([{ id: "A1", archived: false }, { id: "A2", archived: true }], "A1")).toBe("A1");
    setLastAccountId("GHOST");
    expect(preferredAccountId([{ id: "A1", archived: false }], "A1")).toBe("A1");
  });
  test("nothing saved → fallback", () => {
    expect(preferredAccountId([{ id: "A1", archived: false }], "A1")).toBe("A1");
  });
});

describe("lastAccount vs device trust", () => {
  beforeEach(() => {
    mem.clear();
    __resetStorageForTests();
  });
  test("guest mode: setLastAccountId is a no-op", () => {
    mem.set("enveo.deviceTrust", "untrusted");
    __resetStorageForTests();
    setLastAccountId("A1");
    expect(mem.has("enveo.lastAccount")).toBe(false);
  });
  test("clearLastAccountId removes the key", () => {
    setLastAccountId("A1");
    clearLastAccountId();
    expect(getLastAccountId()).toBeNull();
  });
});
