/**
 * E2EE stage 2 (T1) — encrypting ops/snapshots (e2ee.ts) and applying
 * the decrypted journal onto the mirror (store.applyRemoteOps): roundtrip,
 * skipping own opIds from the outbox (the pending-guard equivalent), the cursor.
 *
 * Plus the DEK PROVENANCE (2.0) — the multi-tenant guard in sync.ts accepts a
 * "the session's checkpoint opens with this device's key" proof ONLY for a key that came out
 * of IDB together with the replica. setDek() persists the key, so the distinction must be
 * persisted with it: otherwise one reload turns a key unwrapped from the SESSION's envelope
 * (Unlock / enable / password change — which decrypts that session's budget by construction)
 * into a proof of ownership for whatever replica happens to sit on the device.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import type { ClientLedger, SyncOp } from "@enveo/shared";
import { generateDek } from "./crypto";
import {
  __forgetHydrationForTests,
  __resetDekForTests,
  clearDek,
  decryptOps,
  decryptSnapshot,
  encryptOp,
  encryptSnapshot,
  getDek,
  hydrate,
  isDekFromStore,
  setDek,
} from "./e2ee";
import { clearLocalData, idbPut } from "./idb";
import * as persist from "./persist";
import { store } from "./store";

const emptyLedger = (): ClientLedger => ({
  accounts: [],
  groups: [],
  envelopes: [],
  transactions: [],
  allocations: [],
  categories: [],
  places: [],
  recurrences: [],
  budgets: [],
});

const catOp = (opId: string, id: string, name: string): SyncOp =>
  ({ opId, kind: "category.create", payload: { id, name } }) as SyncOp;

const U1 = "11111111-1111-1111-1111-111111111111";
const U2 = "22222222-2222-2222-2222-222222222222";
const U3 = "33333333-3333-3333-3333-333333333333";
const U4 = "44444444-4444-4444-4444-444444444444";

describe("e2ee: encrypting ops and snapshots", () => {
  it("encryptOp → decryptOps restores kind/payload; opId in the clear; v1. ciphertext without plaintext", async () => {
    const dek = generateDek();
    const op = catOp(U1, U3, "Jedzenie");
    const row = await encryptOp(op, dek);
    expect(row.opId).toBe(U1);
    expect(row.ciphertext.startsWith("v1.")).toBe(true);
    expect(row.ciphertext).not.toContain("Jedzenie");
    const [back] = await decryptOps([row], dek);
    expect(back).toEqual(op);
  });

  it("encryptSnapshot → decryptSnapshot restores the whole ledger; a wrong DEK throws", async () => {
    const dek = generateDek();
    const ledger = { ...emptyLedger(), categories: [{ id: U3, name: "Paliwo" }] };
    const blob = await encryptSnapshot(ledger, dek);
    expect(blob).not.toContain("Paliwo");
    expect(await decryptSnapshot(blob, dek)).toEqual(ledger);
    await expect(decryptSnapshot(blob, generateDek())).rejects.toThrow();
  });
});

/* ── DEK provenance (the ownership proof the sync guard leans on) ─────── */

/** A fresh page load: module key state forgotten, IDB meta untouched. */
async function reload(): Promise<void> {
  await persist.flushed(); // the DEK/origin writes go through the serial persist chain
  __resetDekForTests();
  await hydrate();
}

describe("e2ee: DEK provenance survives a reload", () => {
  beforeEach(async () => {
    __resetDekForTests();
    await clearLocalData();
  });

  it("a key persisted by an older build (no origin recorded) came WITH the replica → store", async () => {
    await idbPut("meta", generateDek(), "e2eeDek"); // pre-2.0 IDB: key, no provenance
    await hydrate();
    expect(getDek()).not.toBeNull();
    expect(isDekFromStore()).toBe(true); // the only case in which the DEK may prove ownership
  });

  it("setDek (Unlock / enable / password change) is NOT a proof — not now, not after a reload", async () => {
    await hydrate(); // boot: no key on this device
    setDek(generateDek()); // …unwrapped from the SESSION budget's key envelope
    expect(isDekFromStore()).toBe(false);

    await reload(); // the bug: hydrate() used to re-mark every persisted key as "store"
    expect(getDek()).not.toBeNull(); // the key IS persisted (Unlock must survive a refresh)…
    expect(isDekFromStore()).toBe(false); // …but it still proves nothing about the replica
  });

  it("a hydrate() that re-runs after setDek (transient IDB → retryBoot) does not launder the key", async () => {
    // hydrate() drops its memoization on rejection, and the Unlock flow calls retryBoot right
    // after setDek — so its body CAN run again in the SAME page load, with the key already in
    // IDB. It must not overwrite what setDek told us first-hand.
    await hydrate();
    setDek(generateDek());
    await persist.flushed();
    __forgetHydrationForTests();
    await hydrate();
    expect(isDekFromStore()).toBe(false);
  });

  it("clearDek forgets the key and its provenance", async () => {
    await idbPut("meta", generateDek(), "e2eeDek");
    await hydrate();
    clearDek();
    expect(getDek()).toBeNull();
    expect(isDekFromStore()).toBe(false);
    await reload();
    expect(getDek()).toBeNull(); // the removal is durable too
    expect(isDekFromStore()).toBe(false);
  });
});

describe("store.applyRemoteOps (e2ee journal → mirror)", () => {
  it("applies ops in order, skips outbox opIds (skipOpIds) and sets the cursor", () => {
    store.replace(emptyLedger(), 0, "b1");
    const ops = [catOp(U1, U3, "Zdalna"), catOp(U2, U4, "Własna-pending")];
    store.applyRemoteOps(ops, 7, new Set([U2]));
    const cats = store.getLedger()!.categories;
    expect(cats.map((c) => c.id)).toEqual([U3]); // the pending op skipped
    expect(store.getCursor()).toBe(7);
  });

  it("an op that fails to apply does not stop the rest of the journal", () => {
    store.replace(emptyLedger(), 0, "b1");
    const broken = {
      opId: U1,
      kind: "category.update",
      payload: { id: U3, name: "X" },
    } as unknown as SyncOp;
    store.applyRemoteOps([broken, catOp(U2, U4, "Dalej")], 3);
    expect(store.getLedger()!.categories.some((c) => c.name === "Dalej")).toBe(true);
    expect(store.getCursor()).toBe(3);
  });
});
