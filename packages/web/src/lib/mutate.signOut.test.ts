import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type ClientLedger, createDefaultBudgetPreferences } from "@enveo/shared";
import { __resetStorageForTests, idbGetAll } from "./idb";
import { local } from "./mutate";
import * as outbox from "./outbox";
import * as persist from "./persist";
import { __resetSignOutBarrierForTests, beginSignOut } from "./signOutBarrier";
import { store } from "./store";

const ledgerFixture = (): ClientLedger => ({
  accounts: [],
  groups: [],
  envelopes: [],
  transactions: [],
  allocations: [],
  categories: [],
  places: [],
  budgets: [{ id: crypto.randomUUID(), name: "Budget", currency: "EUR", preferences: createDefaultBudgetPreferences() }],
});

beforeEach(async () => {
  __resetSignOutBarrierForTests();
  __resetStorageForTests();
  persist.__resetPersistForTests();
  outbox.clearAll();
  await outbox.flushed();
  const ledger = ledgerFixture();
  store.replace(ledger, 0, ledger.budgets[0]!.id);
});

afterEach(async () => {
  __resetSignOutBarrierForTests();
  outbox.clearAll();
  await outbox.flushed();
  store.clearMemory();
  __resetStorageForTests();
  persist.__resetPersistForTests();
});

describe("local mutations during sign-out", () => {
  it("throws before creating an entity UUID", () => {
    const realRandomUUID = crypto.randomUUID.bind(crypto);
    let uuidCalls = 0;
    Object.defineProperty(crypto, "randomUUID", {
      configurable: true,
      value: () => {
        uuidCalls++;
        return realRandomUUID();
      },
    });
    beginSignOut();

    try {
      expect(() => local.createGroup("Blocked group")).toThrow("sign_out_in_progress");
      expect(uuidCalls).toBe(0);
    } finally {
      Reflect.deleteProperty(crypto, "randomUUID");
    }
  });

  it("throws before validating a write-specific payload", () => {
    beginSignOut();

    expect(() => local.updateBudgetPreferences("11111111-1111-1111-1111-111111111111", { aiProvider: "invalid-provider" } as never)).toThrow(
      "sign_out_in_progress",
    );
  });

  it("throws before changing the ledger or creating memory and durable outbox work", async () => {
    const before = store.getLedger();
    beginSignOut();

    expect(() => local.createGroup("Blocked group")).toThrow("sign_out_in_progress");

    expect(store.getLedger()).toBe(before);
    expect(outbox.snapshot()).toEqual([]);
    await outbox.flushed();
    expect(await idbGetAll("outbox")).toEqual([]);
  });

  it("throws the stable sentinel before a write helper reads an absent ledger", () => {
    store.clearMemory();
    beginSignOut();

    expect(() => local.setDisplayedAllocation({ envelopeId: crypto.randomUUID(), month: "2026-09", amount: 100 })).toThrow("sign_out_in_progress");
    expect(outbox.snapshot()).toEqual([]);
  });
});
