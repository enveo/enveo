






import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { idbGet, idbPut } from "../idb";
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

  it("wipeLocalData clears the stores, THEN broadcasts 'wipe', THEN reloads", async () => {
    await idbPut("meta", "value", "wipe-probe");
    await wipeLocalData();
    await flush();
    expect(await idbGet("meta", "wipe-probe")).toBeUndefined();  
    expect(received).toEqual(["wipe"]);  
    expect(reloads).toBe(1);
  });
});
