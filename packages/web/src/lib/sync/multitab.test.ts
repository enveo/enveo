






import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createDefaultBudgetPreferences } from "@enveo/shared";
import { accountPreferences } from "../accountPreferences";
import { idbGet, idbPut } from "../idb";
import { __resetSignOutBarrierForTests, getSignOutPhase, isSignOutBlocking } from "../signOutBarrier";
import { store } from "../store";
import { __resetMultiTabForTests, broadcastUpdatedIfPending, installMultiTab, isLeaderTab, notePeersMayNeedUpdate, wipeLocalData } from "./multitab";

let received: string[] = [];
let receiver: BroadcastChannel | null = null;
let savedLocation: unknown;
let reloads = 0;

const flush = () => new Promise((r) => setTimeout(r, 20));  

beforeAll(() => {
  

  installMultiTab();
});

beforeEach(() => {
  __resetSignOutBarrierForTests();
  received = [];
  reloads = 0;
  savedLocation = (globalThis as { location?: unknown }).location;
  (globalThis as { location?: { reload: () => void } }).location = {
    reload: () => {
      reloads++;
    },
  };
  receiver = new BroadcastChannel("enveo-sync");
  receiver.onmessage = (e: MessageEvent) => {
    received.push((e.data as { type?: string })?.type ?? "?");
  };
});

afterEach(() => {
  __resetSignOutBarrierForTests();
  receiver?.close();
  receiver = null;
  if (savedLocation === undefined) delete (globalThis as { location?: unknown }).location;
  else (globalThis as { location?: unknown }).location = savedLocation;
});

afterAll(() => {
  __resetMultiTabForTests();  
});

describe("sync/multitab", () => {
  it("without Web Locks every tab is a leader (bun has no navigator.locks)", () => {
    expect(isLeaderTab()).toBe(true);
  });

  it("broadcastUpdatedIfPending posts 'updated' exactly once per noted change (consume-once)", async () => {
    broadcastUpdatedIfPending();  
    await flush();
    expect(received).toEqual([]);

    notePeersMayNeedUpdate();
    notePeersMayNeedUpdate();  
    broadcastUpdatedIfPending();
    broadcastUpdatedIfPending();  
    await flush();
    expect(received).toEqual(["updated"]);
  });

  it("broadcasts a persisted account preference edit without echoing a peer notification", async () => {
    await accountPreferences.clear();
    await accountPreferences.hydrateForUser("user-a");
    await accountPreferences.update({ lang: "pl" });
    await flush();
    expect(received).toEqual(["preferences"]);

    received = [];
    receiver?.postMessage({ type: "preferences" });
    await flush();
    expect(received).toEqual([]); // the receive-side rehydrate never broadcasts
  });

  it("a peer sign-out start blocks later cycles without clearing shared IndexedDB", async () => {
    const budgetId = crypto.randomUUID();
    store.replace(
      {
        accounts: [],
        groups: [],
        envelopes: [],
        transactions: [],
        allocations: [],
        categories: [],
        places: [],
        budgets: [{ id: budgetId, name: "Budget", currency: "EUR", preferences: createDefaultBudgetPreferences() }],
      },
      0,
      budgetId,
    );
    await idbPut("meta", "preserve", "sign-out-peer-probe");
    const realFetch = globalThis.fetch;
    const fetches: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      fetches.push(String(input));
      throw new TypeError("no network in this suite");
    }) as typeof fetch;
    try {
      receiver?.postMessage({ type: "sign-out-start" });
      receiver?.postMessage({ type: "poke" });
      await flush();

      expect(getSignOutPhase()).toBe("blocking");
      expect(isSignOutBlocking()).toBe(true);
      expect(fetches).toEqual([]);
      expect(await idbGet<string>("meta", "sign-out-peer-probe")).toBe("preserve");
      expect(reloads).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a peer sign-out cancel releases a start barrier without clearing data", async () => {
    await idbPut("meta", "preserve", "sign-out-cancel-probe");

    receiver?.postMessage({ type: "sign-out-start" });
    await flush();
    expect(getSignOutPhase()).toBe("blocking");
    receiver?.postMessage({ type: "sign-out-cancel" });
    await flush();

    expect(getSignOutPhase()).toBe("idle");
    expect(isSignOutBlocking()).toBe(false);
    expect(await idbGet<string>("meta", "sign-out-cancel-probe")).toBe("preserve");
    expect(reloads).toBe(0);
  });

  it("wipeLocalData clears the stores, THEN broadcasts 'wipe', THEN reloads", async () => {
    await idbPut("meta", "value", "wipe-probe");
    await wipeLocalData();
    await flush();
    expect(await idbGet("meta", "wipe-probe")).toBeUndefined();  
    expect(received).toEqual(["wipe"]);  
    expect(reloads).toBe(1);
  });
});
