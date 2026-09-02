/**
 * Focused suite for sync/boot.ts (workflow §3c-3): the install-once boot promise (StrictMode
 * mounts effects twice).
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
import { __resetAccountStorageOperationsForTests, configureAccountStorageGenerationFence } from "../accountStorageOperations";
import * as e2ee from "../e2ee";
import { clearLocalData } from "../idb";
import * as outbox from "../outbox";
import { __resetSignOutBarrierForTests, beginSignOut, configureSignOutSharedBlocker, isSignOutBlocking } from "../signOutBarrier";
import { store } from "../store";
import { __resetBootForTests, bootOnce, configureBootSecurityBoundary, retryBoot } from "./boot";
import { __resetBackoff } from "./cycle";
import { __resetIdentity } from "./identity";
import { __resetObligations } from "./obligations";

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

beforeEach(async () => {
  __resetAccountStorageOperationsForTests();
  __resetBootForTests();
  configureBootSecurityBoundary(() => Promise.resolve());
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    throw new Error(`unexpected fetch: ${String(input)}`);
  }) as typeof fetch;
  __resetIdentity();
  __resetObligations();
  __resetBackoff();
  __resetSignOutBarrierForTests();
  outbox.clearAll();
  e2ee.__resetDekForTests();
  e2ee.clearDek();
  e2ee.setTierMeta({ tier: "plain", epoch: 0 });
  e2ee.setCipherVersion(2);
  await clearLocalData();
  store.replace(emptyLedger(), 0, "b-1");
  store.setBootStatus("booting");
});

afterEach(() => {
  __resetAccountStorageOperationsForTests();
  __resetBackoff();
  __resetIdentity();
  globalThis.fetch = realFetch;
  store.setBootStatus("ready");
});

describe("sync/boot: the install-once boot promise", () => {
  it("lets first boot await installation before evaluating the eager fail-closed blocker", async () => {
    configureSignOutSharedBlocker(() => true);
    configureAccountStorageGenerationFence({ isCurrent: () => false });
    configureBootSecurityBoundary(async () => {
      configureAccountStorageGenerationFence(null);
      configureSignOutSharedBlocker(() => false);
    });

    await bootOnce();

    expect(store.getBootStatus()).toBe("ready");
  });

  it("bootOnce reuses ONE promise per module lifetime (StrictMode double-mount safe)", async () => {
    const first = bootOnce();
    const second = bootOnce();
    expect(second).toBe(first);
    await first;
  });

  it("retryBoot starts a FRESH boot (the 'Try again' button)", async () => {
    const first = bootOnce();
    await first;
    const retried = retryBoot();
    expect(retried).not.toBe(first);
    await retried;
    expect(bootOnce()).toBe(retried);
  });

  it("does not release authenticated boot before the security coordinator is installed", async () => {
    let release!: () => void;
    configureBootSecurityBoundary(() => new Promise<void>((resolve) => (release = resolve)));

    const pending = retryBoot();
    await Promise.resolve();
    expect(store.getBootStatus()).toBe("booting");

    release();
    await pending;
    expect(store.getBootStatus()).toBe("ready");
  });

  it("stays fail closed when the security coordinator chunk cannot load", async () => {
    configureBootSecurityBoundary(async () => {
      beginSignOut();
      throw new Error("chunk unavailable");
    });

    await retryBoot();

    expect(store.getBootStatus()).toBe("booting");
    expect(isSignOutBlocking()).toBe(true);
  });

  it("retryBoot does not start boot work while sign-out is coordinated", async () => {
    store.setBootStatus("ready");
    const existing = bootOnce();
    await existing;
    beginSignOut();

    const blockedRetry = retryBoot();
    await blockedRetry;

    expect(store.getBootStatus()).toBe("ready");
    expect(blockedRetry).toBe(existing);
  });
});
