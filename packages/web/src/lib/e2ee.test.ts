/**
 * E2EE stage 2 (T1) — encrypting ops/snapshots (e2ee.ts) and applying
 * the decrypted journal onto the mirror (store.applyRemoteOps): roundtrip,
 * skipping own opIds from the outbox (the pending-guard equivalent), the cursor.
 */
import { describe, expect, it } from "bun:test";
import type { ClientLedger, SyncOp } from "@enveo/shared";
import { generateDek } from "./crypto";
import { decryptOps, decryptSnapshot, encryptOp, encryptSnapshot } from "./e2ee";
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
