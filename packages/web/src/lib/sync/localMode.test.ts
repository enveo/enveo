/**
 * Focused suite for sync/localMode.ts (workflow §3c-3): the tri-state flag, its localStorage
 * persistence and the NO-HALF-STATE transition guarantees, driven against STUB deps so every
 * injected effect is observable. The real wiring is restored afterwards by rebuilding exactly
 * the facade's configureLocalMode call — module state is shared across test files in one bun
 * process, so leaving stubs behind would poison the facade suites.
 *
 * A localStorage stub on globalThis (bun test has no DOM — the pattern of storage.test.ts and
 * deviceTrust.test.ts) makes the persistence side observable; it is removed again in afterAll.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { LocalModeDeps, SyncState } from "./contracts";
import { awaitInFlightCycle, syncNow } from "./cycle";
import { applyLocalMode, configureLocalMode, disableLocal, enablePaused, enableWiped, getLocalMode, isLocalOnly, setLocalModeValue } from "./localMode";
import { broadcastLocalMode } from "./multitab";
import { isEmptyUnboundReplica } from "./replica";
import { setOwnerUnproven, setState } from "./status";
import { pushLocalToServer, wipeServer } from "./transport";

interface Calls {
  states: SyncState[];
  unproven: boolean[];
  broadcasts: string[];
  wipes: number;
  pushes: number;
  awaited: number;
  syncs: string[];
}

let calls: Calls;
let wipeFails: boolean;
let pushFails: boolean;
let emptyUnbound: boolean;

/** bun test has no DOM — a minimal localStorage so writeLocalModeToStorage is observable. */
const savedLocalStorage = (globalThis as Record<string, unknown>).localStorage;
const memoryStorage = (): Storage => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
};

const stubDeps = (): LocalModeDeps => ({
  setState: (s) => calls.states.push(s),
  setOwnerUnproven: (v) => calls.unproven.push(v),
  broadcastLocalMode: (m) => calls.broadcasts.push(m),
  wipeServer: async () => {
    if (wipeFails) throw new Error("wipe failed");
  },
  pushLocalToServer: async () => {
    calls.pushes++;
    if (pushFails) throw new Error("push failed");
  },
  awaitInFlightCycle: async () => {
    calls.awaited++;
  },
  syncNow: async (reason) => {
    calls.syncs.push(reason);
  },
  isEmptyUnboundReplica: () => emptyUnbound,
});

beforeEach(() => {
  (globalThis as Record<string, unknown>).localStorage = memoryStorage();
  calls = { states: [], unproven: [], broadcasts: [], wipes: 0, pushes: 0, awaited: 0, syncs: [] };
  wipeFails = false;
  pushFails = false;
  emptyUnbound = false;
  configureLocalMode(stubDeps());
  setLocalModeValue("off");
});

afterAll(() => {
  // restore the EXACT wiring the facade installs (see lib/sync.ts composition section)
  configureLocalMode({
    setState,
    setOwnerUnproven,
    broadcastLocalMode,
    wipeServer,
    pushLocalToServer,
    awaitInFlightCycle,
    syncNow,
    isEmptyUnboundReplica,
  });
  setLocalModeValue("off");
  // hand the process back exactly the environment we found (other suites assert on its absence)
  if (savedLocalStorage === undefined) delete (globalThis as Record<string, unknown>).localStorage;
  else (globalThis as Record<string, unknown>).localStorage = savedLocalStorage;
});

describe("sync/localMode: flag + persistence", () => {
  it("applyLocalMode sets the flag, persists it, broadcasts, clears unproven and sets the UI state", () => {
    applyLocalMode("paused");
    expect(getLocalMode()).toBe("paused");
    expect(isLocalOnly()).toBe(true);
    expect(localStorage.getItem("enveo.localMode")).toBe("paused");
    expect(calls.broadcasts).toEqual(["paused"]);
    expect(calls.unproven).toEqual([false]); // local mode supersedes the unproven fact
    expect(calls.states).toEqual(["local"]);

    applyLocalMode("off");
    expect(calls.states).toEqual(["local", "synced"]); // a real cycle finalizes it via syncNow
  });

  it("setLocalModeValue changes ONLY the in-memory flag (the peer-tab message path)", () => {
    localStorage.setItem("enveo.localMode", "off");
    setLocalModeValue("wiped");
    expect(getLocalMode()).toBe("wiped");
    expect(localStorage.getItem("enveo.localMode")).toBe("off"); // sender already wrote it
    expect(calls.broadcasts).toEqual([]); // no re-broadcast loop
  });
});

describe("sync/localMode: NO half-state transitions", () => {
  it("enablePaused is non-destructive and immediate: no server call at all", () => {
    enablePaused();
    expect(getLocalMode()).toBe("paused");
    expect(calls.pushes).toBe(0);
  });

  it("enableWiped raises the gate FIRST, awaits the in-flight cycle, then wipes", async () => {
    await enableWiped();
    expect(getLocalMode()).toBe("wiped");
    // the gate (flag + broadcast) went up BEFORE the wipe could run
    expect(calls.broadcasts[0]).toBe("wiped");
    expect(calls.awaited).toBe(1); // the in-flight cycle finished on the PRE-wipe state
  });

  it("enableWiped failure returns cleanly to 'off' (server untouched, local intact) and rethrows", async () => {
    wipeFails = true;
    await expect(enableWiped()).rejects.toThrow("wipe failed");
    expect(getLocalMode()).toBe("off"); // no half-state: not left 'wiped' without a wiped server
    expect(calls.broadcasts).toEqual(["wiped", "off"]);
  });

  it("disableLocal from 'wiped' uploads BEFORE lifting the flag; failure keeps the flag up", async () => {
    setLocalModeValue("wiped");
    pushFails = true;
    await expect(disableLocal()).rejects.toThrow("push failed");
    expect(getLocalMode()).toBe("wiped"); // nothing uploaded — the obligation stands

    pushFails = false;
    await disableLocal();
    expect(getLocalMode()).toBe("off");
    expect(calls.pushes).toBe(2);
  });

  it("disableLocal from 'wiped' with an EMPTY UNBOUND replica never uploads (it could only destroy)", async () => {
    setLocalModeValue("wiped");
    emptyUnbound = true;
    const savedLocation = (globalThis as { location?: unknown }).location;
    let reloads = 0;
    (globalThis as { location?: { reload: () => void } }).location = {
      reload: () => {
        reloads++;
      },
    };
    try {
      await disableLocal();
    } finally {
      if (savedLocation === undefined) delete (globalThis as { location?: unknown }).location;
      else (globalThis as { location?: unknown }).location = savedLocation;
    }
    expect(calls.pushes).toBe(0); // the empty ledger never replaces the server copy
    expect(getLocalMode()).toBe("off");
    expect(reloads).toBe(1); // boot bootstraps from the server instead
  });

  it("disableLocal from 'paused' lifts the flag and resumes with an ordinary cycle", async () => {
    setLocalModeValue("paused");
    await disableLocal();
    expect(getLocalMode()).toBe("off");
    expect(calls.pushes).toBe(0); // paused→off is exactly offline→online, no replace
    expect(calls.syncs).toEqual(["resume"]);
  });
});
