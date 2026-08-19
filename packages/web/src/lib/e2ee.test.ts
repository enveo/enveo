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
  getTierMeta,
  hydrate,
  isDekFromStore,
  isDekValidForEpoch,
  markDekValidated,
  rehydrateKeysFromPeer,
  requireValidatedDek,
  setDek,
  setTierMeta,
} from "./e2ee";
import { clearLocalData, idbGet, idbPut } from "./idb";
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
  budgets: [],
});

const catOp = (opId: string, id: string, name: string): SyncOp => ({ opId, kind: "category.create", payload: { id, name } }) as SyncOp;

const U1 = "11111111-1111-1111-1111-111111111111";
const U2 = "22222222-2222-2222-2222-222222222222";
const U3 = "33333333-3333-3333-3333-333333333333";
const U4 = "44444444-4444-4444-4444-444444444444";

const BUDGET = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_BUDGET = "bbbbbbbb-0000-4000-8000-000000000002";
const CTX = { budgetId: BUDGET, epoch: 1 };

describe("e2ee: encrypting ops and snapshots (v2 authenticated context)", () => {
  it("encryptOp → decryptOps restores kind/payload; opId in the clear; v2. ciphertext without plaintext", async () => {
    const dek = generateDek();
    const op = catOp(U1, U3, "Jedzenie");
    const row = await encryptOp(op, dek, CTX);
    expect(row.opId).toBe(U1);
    expect(row.ciphertext.startsWith("v2.")).toBe(true);
    expect(row.ciphertext).not.toContain("Jedzenie");
    const [back] = await decryptOps([row], dek, CTX);
    expect(back).toEqual(op);
  });

  it("an encrypted transaction op preserves import-learning and allocation-flow fields inside ciphertext", async () => {
    const dek = generateDek();
    const op: SyncOp = {
      opId: U1,
      kind: "txn.create",
      payload: {
        id: U2,
        type: "transfer",
        accountId: U3,
        toAccountId: U3,
        amount: 1234,
        date: "2026-08-14",
        sourceRef: "RAW BANK DESCRIPTION",
        allocationFromEnvelopeId: U4,
        allocationToEnvelopeId: U4,
      },
    };
    const encrypted = await encryptOp(op, dek, { budgetId: BUDGET, epoch: 1 });
    expect(encrypted.ciphertext).not.toContain("RAW BANK DESCRIPTION");
    const [decrypted] = await decryptOps([encrypted], dek, { budgetId: BUDGET, epoch: 1 });
    expect((decrypted?.payload as { sourceRef?: string } | undefined)?.sourceRef).toBe("RAW BANK DESCRIPTION");
    expect((decrypted?.payload as { allocationFromEnvelopeId?: string } | undefined)?.allocationFromEnvelopeId).toBe(U4);
    expect((decrypted?.payload as { allocationToEnvelopeId?: string } | undefined)?.allocationToEnvelopeId).toBe(U4);
  });

  it("SUBSTITUTION: swapping two valid ciphertexts while keeping their outer opIds fails", async () => {
    // The attack this format exists to stop: a malicious store pairs op B's valid ciphertext
    // with op A's clear opId, so B would be applied under A's idempotency identity.
    const dek = generateDek();
    const rowA = await encryptOp(catOp(U1, U3, "A"), dek, CTX);
    const rowB = await encryptOp(catOp(U2, U4, "B"), dek, CTX);
    const swapped = [
      { opId: rowA.opId, ciphertext: rowB.ciphertext },
      { opId: rowB.opId, ciphertext: rowA.ciphertext },
    ];
    await expect(decryptOps(swapped, dek, CTX)).rejects.toThrow();
  });

  it("REPLAY under another budget fails; replay under another epoch fails", async () => {
    const dek = generateDek();
    const row = await encryptOp(catOp(U1, U3, "X"), dek, CTX);
    await expect(decryptOps([row], dek, { budgetId: OTHER_BUDGET, epoch: 1 })).rejects.toThrow();
    await expect(decryptOps([row], dek, { budgetId: BUDGET, epoch: 2 })).rejects.toThrow();
  });
  // NOTE deliberately ABSENT: a "changed seq fails" op vector. PostgreSQL allocates the journal
  // seq AFTER the client encrypted and pushed, so seq is not part of the op AAD — this design
  // does not authenticate the server-chosen global order, and no test may claim it does.

  it("encryptSnapshot → decryptSnapshot restores the whole ledger; a wrong DEK throws", async () => {
    const dek = generateDek();
    const ledger: ClientLedger = {
      ...emptyLedger(),
      accounts: [
        {
          id: U3,
          name: "Checking",
          color: "#fff",
          icon: "wallet",
          type: "checking",
          onBudget: true,
          initialBalance: 0,
          archived: false,
          sort: 0,
          automaticEnvelopeId: U4,
        },
      ],
      groups: [{ id: U2, name: "Group", sort: 0 }],
      envelopes: [
        { id: U4, groupId: U2, name: "Food", color: "#fff", icon: "tag", note: null, monthlyTarget: null, isSavings: false, sort: 0, archived: false },
      ],
      transactions: [
        {
          id: U1,
          type: "transfer",
          accountId: U3,
          toAccountId: U3,
          amount: 100,
          date: "2026-08-14",
          isRefund: false,
          envelopeId: null,
          placeId: null,
          categoryId: null,
          name: null,
          note: null,
          tag: null,
          sourceRef: null,
          allocationFromEnvelopeId: U4,
          allocationToEnvelopeId: U4,
          items: [],
          createdAt: "2026-08-14T00:00:00.000Z",
        },
      ],
      categories: [{ id: U1, name: "Paliwo", archived: false }],
    };
    const sctx = { budgetId: BUDGET, epoch: 1, uptoSeq: 42 };
    const blob = await encryptSnapshot(ledger, dek, sctx);
    expect(blob).not.toContain("Paliwo");
    expect(await decryptSnapshot(blob, dek, sctx)).toEqual(ledger);
    await expect(decryptSnapshot(blob, generateDek(), sctx)).rejects.toThrow();
  });

  it("a snapshot paired with another uptoSeq (or budget/epoch) fails — checkpoint-position substitution", async () => {
    const dek = generateDek();
    const ledger = { ...emptyLedger(), categories: [{ id: U3, name: "Paliwo", archived: false }] };
    const blob = await encryptSnapshot(ledger, dek, { budgetId: BUDGET, epoch: 1, uptoSeq: 42 });
    await expect(decryptSnapshot(blob, dek, { budgetId: BUDGET, epoch: 1, uptoSeq: 0 })).rejects.toThrow();
    await expect(decryptSnapshot(blob, dek, { budgetId: BUDGET, epoch: 2, uptoSeq: 42 })).rejects.toThrow();
    await expect(decryptSnapshot(blob, dek, { budgetId: OTHER_BUDGET, epoch: 1, uptoSeq: 42 })).rejects.toThrow();
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
    setDek(generateDek(), 1); // …unwrapped from the SESSION budget's key envelope
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
    setDek(generateDek(), 1);
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

/* ── The DEK lifecycle across an epoch change (review F1/F7) ──────────────
 *
 * A DEK is trusted ONLY for the epoch it was validated for. Adopting a new epoch (any 409
 * body) leaves the key in memory but silently invalidates it; only an authenticated use under
 * the new epoch's AAD (markDekValidated) restores trust. Peer tabs re-read the whole key
 * state on the "keys" broadcast — the memoized hydrate alone would keep a dead key alive. */

describe("e2ee: DEK validity is per-epoch", () => {
  beforeEach(async () => {
    __resetDekForTests();
    await clearLocalData();
  });

  it("setDek records the validated epoch; a tierMeta epoch bump invalidates WITHOUT clearing", async () => {
    await hydrate();
    setTierMeta({ tier: "e2ee", epoch: 1 });
    setDek(generateDek(), 1);
    expect(isDekValidForEpoch(1)).toBe(true);
    setTierMeta({ tier: "e2ee", epoch: 2 }); // a 409 body adopted the new generation
    expect(getDek()).not.toBeNull(); // the key stays (it may still be re-validated)…
    expect(isDekValidForEpoch(2)).toBe(false); // …but it may not touch the new epoch
    expect(isDekValidForEpoch(1)).toBe(true); // (its own generation is still its own)
  });

  it("returns a defensive copy only for the current E2EE epoch and otherwise fails locked", async () => {
    await hydrate();
    const original = generateDek();
    setTierMeta({ tier: "e2ee", epoch: 4 });
    setDek(original, 4);
    const first = requireValidatedDek(4);
    expect(Buffer.from(first).toString("hex")).toBe(Buffer.from(original).toString("hex"));
    first[0] = (first[0] ?? 0) ^ 0xff;
    expect(Buffer.from(requireValidatedDek(4)).toString("hex")).toBe(Buffer.from(original).toString("hex"));
    expect(() => requireValidatedDek(3)).toThrow("locked");
    setTierMeta({ tier: "plain", epoch: 4 });
    expect(() => requireValidatedDek(4)).toThrow("locked");
    clearDek();
    expect(() => requireValidatedDek(4)).toThrow("locked");
  });

  it("markDekValidated is the ONLY promotion to a new epoch, and it survives a reload", async () => {
    await hydrate();
    setDek(generateDek(), 1);
    markDekValidated(2); // an authenticated decrypt under epoch 2 vouched for the key
    expect(isDekValidForEpoch(2)).toBe(true);
    await persist.flushed();
    __resetDekForTests();
    await hydrate();
    expect(isDekValidForEpoch(2)).toBe(true); // durable — a reload must not regress trust
  });

  it("a key persisted WITHOUT a validation epoch (pre-lifecycle install) is NOT validated", async () => {
    await idbPut("meta", generateDek(), "e2eeDek"); // old build: key, no e2eeDekEpoch
    await hydrate();
    expect(getDek()).not.toBeNull();
    expect(isDekValidForEpoch(0)).toBe(false); // never trusted until an authenticated use
    expect(isDekValidForEpoch(1)).toBe(false);
  });

  it("rehydrateKeysFromPeer drops this tab's in-memory key state and re-reads IDB (F7)", async () => {
    await hydrate();
    const oldDek = generateDek();
    setDek(oldDek, 1); // this tab's stale in-memory state (dekTouched latch is now set)
    await persist.flushed();

    // ANOTHER tab rotated the generation and persisted the new state
    const newDek = generateDek();
    await idbPut("meta", newDek, "e2eeDek");
    await idbPut("meta", "session", "e2eeDekOrigin");
    await idbPut("meta", 2, "e2eeDekEpoch");
    await idbPut("meta", 2, "e2eeEpoch");
    await idbPut("meta", "e2ee", "e2eeTier");

    await rehydrateKeysFromPeer(); // the "keys" broadcast handler
    expect(Buffer.from(getDek()!).toString("hex")).toBe(Buffer.from(newDek).toString("hex"));
    expect(isDekValidForEpoch(2)).toBe(true);
    expect(getTierMeta()).toEqual({ tier: "e2ee", epoch: 2 });
  });

  it("R3: setDek with a NULL epoch installs the key UNVALIDATED (pairing on a checkpoint-less budget)", async () => {
    await hydrate();
    setDek(generateDek(), null); // installed, but no authenticated use vouched for it yet
    expect(getDek()).not.toBeNull();
    expect(isDekValidForEpoch(0)).toBe(false);
    expect(isDekValidForEpoch(1)).toBe(false);
    await persist.flushed();
    __resetDekForTests();
    await hydrate();
    expect(getDek()).not.toBeNull(); // the key survives a reload…
    expect(isDekValidForEpoch(1)).toBe(false); // …but stays untrusted until validated
  });

  it("R4: clearDek destroys the pending upgrade-ceremony record (it holds a RAW candidate DEK)", async () => {
    await hydrate();
    await idbPut("meta", { budgetId: "b", dek: generateDek(), wrappedDek: "v2.x", snapshotBlob: "v2.y" }, "e2eePendingUpgrade");
    setDek(generateDek(), 1);
    clearDek(); // "forget the key" — disable, a rotation-detected drop, sign-out flows
    await persist.flushed();
    expect(await idbGet("meta", "e2eePendingUpgrade")).toBeNull(); // no raw key left behind
  });

  it("clearDek forgets the validation epoch too", async () => {
    await hydrate();
    setDek(generateDek(), 3);
    clearDek();
    expect(isDekValidForEpoch(3)).toBe(false);
    await persist.flushed();
    __resetDekForTests();
    await hydrate();
    expect(getDek()).toBeNull();
    expect(isDekValidForEpoch(3)).toBe(false);
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
