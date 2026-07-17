/**
 * Backend parity: the same operation sequence against MemoryBackend and
 * IdbBackend must yield the same reads. IdbBackend runs on fake-indexeddb (bun
 * has no real one); the fake is injected per-test and removed in afterEach so
 * the OTHER test files keep exercising the memory-fallback path (their harness
 * relies on `typeof indexedDB === "undefined"`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { __newIdbBackendForTests, __resetStorageForTests, idbGet, idbPut, storageMode } from "./idb";
import { MemoryBackend, type StorageBackend } from "./storageBackend";

afterEach(() => {
  delete (globalThis as Record<string, unknown>).indexedDB;
  __resetStorageForTests();
});

/** One sequence over every interface method; returns everything observable. */
async function exercise(b: StorageBackend): Promise<unknown[]> {
  await b.put("meta", { hello: 1 }, "ledger");
  await b.put("meta", "cursor-7", "cursor");
  await b.putMany("meta", [
    { value: "a", key: "k1" },
    { value: "b", key: "k2" },
  ]);
  const s1 = await b.add("outbox", { op: "one" });
  await b.add("outbox", { op: "two" });
  await b.moveToDeadLetter(s1 as number, { opId: "op-1", error: "rejected" });
  await b.delete("meta", "k1");
  const out: unknown[] = [];
  out.push(await b.get("meta", "ledger"));
  out.push(await b.get("meta", "cursor"));
  out.push(await b.get("meta", "k1")); // deleted → undefined on both
  out.push(await b.get("meta", "k2"));
  out.push((await b.getAll("outbox")).length); // 1 (one moved to deadletter)
  out.push((await b.getAll("deadletter")).length); // 1
  await b.clear("outbox");
  out.push((await b.getAll("outbox")).length); // 0
  await b.clearAll();
  out.push((await b.getAll("meta")).length); // 0
  out.push((await b.getAll("deadletter")).length); // 0
  return out;
}

describe("backend parity", () => {
  test("MemoryBackend and IdbBackend answer the same op sequence identically", async () => {
    (globalThis as Record<string, unknown>).indexedDB = new IDBFactory();
    const idb = await exercise(__newIdbBackendForTests());
    const mem = await exercise(new MemoryBackend());
    expect(idb).toEqual(mem);
  });
});

function stubLocalStorage(initial: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(initial));
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
  return m;
}

describe("backend selection (device trust)", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  test("untrusted device → memory-forced; IndexedDB is NEVER opened", async () => {
    const factory = new IDBFactory();
    (globalThis as Record<string, unknown>).indexedDB = factory;
    stubLocalStorage({ "enveo.deviceTrust": "untrusted" });
    __resetStorageForTests();
    await idbPut("meta", "value", "k");
    expect(await idbGet("meta", "k")).toBe("value");
    expect(storageMode()).toBe("memory-forced");
    expect(await factory.databases()).toEqual([]); // the factory saw no open()
  });

  test("absent flag → IdbBackend (trusted legacy default)", async () => {
    (globalThis as Record<string, unknown>).indexedDB = new IDBFactory();
    stubLocalStorage({});
    __resetStorageForTests();
    await idbPut("meta", "value", "k");
    expect(storageMode()).toBe("idb");
  });

  test("cold call: storageMode() alone reports memory-forced (no prior storage op)", () => {
    (globalThis as Record<string, unknown>).indexedDB = new IDBFactory();
    stubLocalStorage({ "enveo.deviceTrust": "untrusted" });
    __resetStorageForTests();
    expect(storageMode()).toBe("memory-forced");
  });
});
