/**
 * Focused suite for sync/cycle.ts (workflow §3c-3): the single-flight/coalescing contract and
 * the two gates that must stop a cycle BEFORE any network request. Full-cycle behavior (push
 * batching, ack/dead-letter, mismatch recovery, backoff-driven retries) is exercised through
 * the facade in ../sync.test.ts, where the fake server lives.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type ClientLedger, createDefaultBudgetPreferences } from "@enveo/shared";
import * as e2ee from "../e2ee";
import { __resetSignOutBarrierForTests, activateSignOutAttempt, beginSignOut, createSignOutPermit, type SignOutPermit } from "../signOutBarrier";
import { store } from "../store";
import { __resetBackoff, awaitInFlightCycle, configureCycle, flushOutboxForSignOut, poke, quiesceSyncForSignOut, runWithSyncMutex, syncNow } from "./cycle";
import { __resetIdentity, enterForeignReplica } from "./identity";

const emptyLedger = (): ClientLedger => ({
  accounts: [],
  groups: [],
  envelopes: [],
  transactions: [],
  allocations: [],
  categories: [],
  places: [],
  budgets: [],
});

let fetches: string[] = [];
let peerPokes = 0;
let scheduledTimers = 0;
const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;

beforeEach(() => {
  fetches = [];
  peerPokes = 0;
  scheduledTimers = 0;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    fetches.push(String(input));
    throw new TypeError("no network in this suite"); // any fetch here is a failed gate
  }) as typeof fetch;
  globalThis.setTimeout = ((..._args: Parameters<typeof setTimeout>) => {
    scheduledTimers++;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  configureCycle({
    notePeersMayNeedUpdate: () => {},
    broadcastUpdatedIfPending: () => {},
    postPokeToPeers: () => {
      peerPokes++;
    },
    ensureE2eeProviderPreference: () => false,
  });
  __resetSignOutBarrierForTests();
  __resetIdentity();
  __resetBackoff();
  e2ee.setTierMeta({ tier: "plain", epoch: 0 });
  // an UNBOUND plain replica: doCycle returns before the identity guard — zero network
  store.replace(emptyLedger(), 0, "");
  store.setBootStatus("ready");
});

afterEach(() => {
  __resetBackoff();
  __resetIdentity();
  __resetSignOutBarrierForTests();
  globalThis.fetch = realFetch;
  globalThis.setTimeout = realSetTimeout;
});

describe("sync/cycle: single-flight with dirty coalescing", () => {
  it("a second syncNow while one is running joins the SAME promise (no interleaved cycles)", async () => {
    const p1 = syncNow("first");
    const p2 = syncNow("second"); // running → dirty=true, same promise back
    expect(p2).toBe(p1);
    await p1;
  });

  it("awaitInFlightCycle resolves immediately when idle and after the running cycle otherwise", async () => {
    await awaitInFlightCycle(); // idle — no cycle to wait for
    const p = syncNow("flight");
    await awaitInFlightCycle(); // resolves only once the in-flight cycle finished
    await p;
  });

  it("serializes a local rebuild with sync and drains a trigger that arrives during maintenance", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: string[] = [];
    const repair = runWithSyncMutex(async () => {
      events.push("repair:start");
      await gate;
      events.push("repair:end");
      return "rebuilt";
    });
    await Promise.resolve();

    const triggered = syncNow("during-repair");
    expect(events).toEqual(["repair:start"]);
    release();

    expect(await repair).toBe("rebuilt");
    await triggered;
    expect(events).toEqual(["repair:start", "repair:end"]);
  });
});

describe("sync/cycle: gates that stop a cycle before any request", () => {
  it("sign-out barrier: syncNow resolves before network or retry work", async () => {
    const budgetId = crypto.randomUUID();
    store.replace(
      {
        ...emptyLedger(),
        budgets: [{ id: budgetId, name: "Budget", currency: "EUR", preferences: createDefaultBudgetPreferences() }],
      },
      0,
      budgetId,
    );
    beginSignOut();

    await syncNow("blocked-by-sign-out");

    expect(fetches).toEqual([]);
    expect(scheduledTimers).toBe(0);
  });

  it("sign-out barrier: poke returns before broadcasting or resetting timers", () => {
    beginSignOut();

    poke();

    expect(peerPokes).toBe(0);
    expect(scheduledTimers).toBe(0);
  });

  it("quiesces an in-flight mutex task and discards a coalesced ordinary cycle", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const task = runWithSyncMutex(() => gate);
    await Promise.resolve();
    const coalesced = syncNow("before-sign-out");
    beginSignOut();

    const quiesced = quiesceSyncForSignOut();
    let settled = false;
    void quiesced.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();

    await Promise.all([task, coalesced, quiesced]);
    expect(fetches).toEqual([]);
  });

  it("allows only the live attempt permit to run the final sign-out flush", async () => {
    activateSignOutAttempt("attempt", "source", "local");
    const permit = createSignOutPermit("attempt");

    await flushOutboxForSignOut(permit);
    await expect(flushOutboxForSignOut({} as SignOutPermit)).rejects.toThrow("sign_out_coordination_failed");
  });

  it("foreign replica: syncNow resolves without a cycle (nothing may reach the network)", async () => {
    enterForeignReplica();
    await syncNow("gate");
    expect(fetches).toEqual([]);
  });

  it("an unbound pre-bootstrap replica: the cycle is a no-op (no session read, no push)", async () => {
    await syncNow("gate");
    expect(fetches).toEqual([]); // returns before ensureIdentity — nothing to sync yet
  });
});
