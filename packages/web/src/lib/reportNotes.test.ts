






import { afterEach, describe, expect, test } from "bun:test";
import { isNoteDismissed, setNoteDismissed } from "./reportNotes";

const KEY = "enveo.reportNotes";

function stubLocalStorage(initial: Record<string, string> = {}) {
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

describe("reportNotes", () => {
  test("by default a note is NOT collapsed", () => {
    stubLocalStorage();
    expect(isNoteDismissed("assets")).toBe(false);
  });

  test("dismiss → true after a \"reload\" (a fresh read from localStorage)", () => {
    const m = stubLocalStorage();
    setNoteDismissed("budgets", true);
     
    expect(isNoteDismissed("budgets")).toBe(true);
    expect(m.get(KEY)).toBe('{"budgets":true}');
     
    expect(isNoteDismissed("assets")).toBe(false);
  });

  test("restore (setNoteDismissed false) → expanded again", () => {
    stubLocalStorage();
    setNoteDismissed("subs", true);
    expect(isNoteDismissed("subs")).toBe(true);
    setNoteDismissed("subs", false);
    expect(isNoteDismissed("subs")).toBe(false);
  });

  test("keeps multiple reports' states in one map", () => {
    stubLocalStorage();
    setNoteDismissed("assets", true);
    setNoteDismissed("cashflow", true);
    setNoteDismissed("assets", false);
    expect(isNoteDismissed("assets")).toBe(false);
    expect(isNoteDismissed("cashflow")).toBe(true);
  });

  test("corrupted JSON in localStorage → false, no throw", () => {
    stubLocalStorage({ [KEY]: "{nie-json!!" });
    expect(() => isNoteDismissed("assets")).not.toThrow();
    expect(isNoteDismissed("assets")).toBe(false);
     
    setNoteDismissed("assets", true);
    expect(isNoteDismissed("assets")).toBe(true);
  });

  test("valid JSON but not a map (array/number) → treated as empty", () => {
    stubLocalStorage({ [KEY]: "[1,2,3]" });
    expect(isNoteDismissed("assets")).toBe(false);
    stubLocalStorage({ [KEY]: "42" });
    expect(isNoteDismissed("assets")).toBe(false);
  });

  test("missing localStorage (a DOM-less environment) does not throw", () => {
    delete (globalThis as Record<string, unknown>).localStorage;
    expect(() => isNoteDismissed("assets")).not.toThrow();
    expect(isNoteDismissed("assets")).toBe(false);
    expect(() => setNoteDismissed("assets", true)).not.toThrow();
  });
});
