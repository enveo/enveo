/**
 * Focused suite for sync/boot.ts (workflow §3c-3): the install-once boot promise (StrictMode
 * mounts effects twice) and the LOCAL-MODE boot path, which is the one boot decision that is
 * fully owned by this module — it resolves the replica without a single network request.
 *
 * Everything boot does through the transport (snapshot bootstrap, the 401→Login exit, the
 * owner check, per-tier bootstrap, the legacy sweep) is cross-module by construction: those
 * paths need the facade's composition (configureTransport) and a complete fake server, so they
 * stay in ../sync.test.ts, which drives them through retryBoot. They also depend on what
 * store.hydrate() returns, and that promise is memoised for the lifetime of the module — a
 * leaf suite asserting on it would only be reading whichever test file ran first.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ClientLedger } from "@enveo/shared";
import * as e2ee from "../e2ee";
import { clearLocalData } from "../idb";
import * as outbox from "../outbox";
import { store } from "../store";
import { bootOnce, getLastBootSource, retryBoot } from "./boot";
import { __resetBackoff } from "./cycle";
import { __resetIdentity } from "./identity";
import { setLocalModeValue } from "./localMode";
import { __resetObligations } from "./obligations";
import { getSyncStatus } from "./status";

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

const realFetch = globalThis.fetch;
let calls: string[] = [];

beforeEach(async () => {
  calls = [];
  // Any request at all is a failure in this suite — local mode must not reach the network, and
  // no other path here is allowed to either.
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input));
    throw new Error(`unexpected fetch: ${String(input)}`);
  }) as typeof fetch;
  __resetIdentity();
  __resetObligations();
  __resetBackoff();
  outbox.clearAll();
  e2ee.__resetDekForTests();
  e2ee.clearDek();
  e2ee.setTierMeta({ tier: "plain", epoch: 0 });
  e2ee.setCipherVersion(2);
  await clearLocalData();
  setLocalModeValue("paused"); // the no-network boot path (see the file header)
  store.replace(emptyLedger(), 0, "b-1");
  store.setBootStatus("booting");
});

afterEach(() => {
  __resetBackoff();
  __resetIdentity();
  setLocalModeValue("off");
  globalThis.fetch = realFetch;
  store.setBootStatus("ready");
});

describe("sync/boot: the install-once boot promise", () => {
  it("bootOnce reuses ONE promise per module lifetime (StrictMode double-mount safe)", async () => {
    const first = bootOnce();
    const second = bootOnce();
    expect(second).toBe(first); // the second mount must not start a second boot
    await first;
  });

  it("retryBoot starts a FRESH boot (the 'Try again' button)", async () => {
    const first = bootOnce();
    await first;
    const retried = retryBoot();
    expect(retried).not.toBe(first);
    await retried;
    expect(bootOnce()).toBe(retried); // and bootOnce now hands out the retried promise
  });
});

describe("sync/boot: local mode resolves the replica without touching the network", () => {
  it("boots ready + state 'local', records lastBootSource 'local' and makes NO request", async () => {
    await retryBoot();
    expect(store.getBootStatus()).toBe("ready"); // the replica reaches the UI
    expect(getLastBootSource()).toBe("local");
    expect(getSyncStatus().state).toBe("local");
    expect(calls).toEqual([]); // no snapshot, no pull, not even a session read
  });

  it("keeps the replica it hydrated (local mode never bootstraps over it)", async () => {
    await retryBoot();
    expect(store.getBudgetId()).toBe("b-1");
    expect(store.getLedger()).not.toBeNull();
    expect(calls).toEqual([]);
  });
});
