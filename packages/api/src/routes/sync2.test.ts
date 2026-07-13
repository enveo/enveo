/**
 * Pure sync2 input-validation tests (zod) — no DB. DB logic (push/pull/
 * snapshot, enable/disable, epoch guards) is covered e2e in stage 2.
 */
import { E2EE_DISABLE_CONFIRM } from "@enveo/shared";
import { describe, expect, it } from "bun:test";
import {
  e2eeDisableInput,
  e2eeEnableInput,
  sync2PushInput,
  sync2RekeyInput,
  sync2ResetInput,
  sync2SnapshotInput,
} from "./sync2";

const UUID = "11111111-1111-1111-1111-111111111111";

describe("sync2 — input validation", () => {
  it("push: accepts a valid batch", () => {
    const r = sync2PushInput.safeParse({
      epoch: 1,
      ops: [{ opId: UUID, ciphertext: "v1.AAAAAAAA" }],
    });
    expect(r.success).toBe(true);
  });

  it("push: rejects empty ops", () => {
    expect(sync2PushInput.safeParse({ epoch: 1, ops: [] }).success).toBe(false);
  });

  it("push: budgetId (the per-request tenant assertion) is optional and must be a uuid", () => {
    const ops = [{ opId: UUID, ciphertext: "v1.AAAAAAAA" }];
    expect(sync2PushInput.safeParse({ epoch: 1, budgetId: UUID, ops }).success).toBe(true);
    expect(sync2PushInput.safeParse({ epoch: 1, budgetId: "nope", ops }).success).toBe(false);
    // a legacy replica cannot name its budget — the epoch alone does NOT identify a tenant
    // (two independently-encrypted budgets both sit at epoch 1), so this is the one gap left
    expect(sync2PushInput.safeParse({ epoch: 1, ops }).success).toBe(true);
  });

  it("push: rejects a bad opId uuid and a too-short ciphertext", () => {
    expect(
      sync2PushInput.safeParse({ epoch: 1, ops: [{ opId: "not-a-uuid", ciphertext: "v1.AAAAAAAA" }] })
        .success,
    ).toBe(false);
    expect(
      sync2PushInput.safeParse({ epoch: 1, ops: [{ opId: UUID, ciphertext: "x" }] }).success,
    ).toBe(false);
  });

  it("push: rejects a batch > 500 and a non-integer epoch", () => {
    const ops = Array.from({ length: 501 }, () => ({ opId: UUID, ciphertext: "v1.AAAAAAAA" }));
    expect(sync2PushInput.safeParse({ epoch: 1, ops }).success).toBe(false);
    expect(
      sync2PushInput.safeParse({ epoch: 1.5, ops: [{ opId: UUID, ciphertext: "v1.AAAAAAAA" }] })
        .success,
    ).toBe(false);
  });

  it("snapshot: requires integer epoch/uptoSeq and a non-empty blob", () => {
    expect(sync2SnapshotInput.safeParse({ epoch: 2, uptoSeq: 10, blob: "v1.zzz" }).success).toBe(true);
    expect(sync2SnapshotInput.safeParse({ epoch: 2, uptoSeq: -1, blob: "v1.zzz" }).success).toBe(false);
    expect(sync2SnapshotInput.safeParse({ epoch: 2, uptoSeq: 0, blob: "" }).success).toBe(false);
  });

  it("snapshot: takes the owner assertion (the checkpoint upload OVERWRITES a whole budget)", () => {
    // POST /sync2/snapshot UPSERTs the resolved budget's only checkpoint (blob AND uptoSeq), and
    // the client fires it in the BACKGROUND at the end of a cycle — the widest window there is
    // for a cookie swapped in another tab. The epoch cannot catch it (two independently-encrypted
    // budgets both sit at epoch 1), so the body names the tenant the client verified.
    expect(
      sync2SnapshotInput.safeParse({ epoch: 2, uptoSeq: 10, blob: "v1.z", userId: "user-A" }).success,
    ).toBe(true);
    expect(sync2SnapshotInput.safeParse({ epoch: 2, uptoSeq: 10, blob: "v1.z", userId: "" }).success).toBe(false);
    // a pre-2.0 client omits it — then there is simply nothing to assert
    expect(sync2SnapshotInput.safeParse({ epoch: 2, uptoSeq: 10, blob: "v1.z" }).success).toBe(true);
  });

  it("enable: requires wrappedDek + kdfParams + snapshotBlob", () => {
    expect(
      e2eeEnableInput.safeParse({ wrappedDek: "v1.a", kdfParams: "{}", snapshotBlob: "v1.b" }).success,
    ).toBe(true);
    expect(e2eeEnableInput.safeParse({ wrappedDek: "", kdfParams: "{}", snapshotBlob: "v1.b" }).success).toBe(false);
    expect(e2eeEnableInput.safeParse({ wrappedDek: "v1.a", kdfParams: "{}" }).success).toBe(false);
  });

  /* The WIRE literal must stay locale-independent ASCII: the word the user TYPES is localized
     (i18n `e2ee.disableWord`) and checked client-side, so a Polish literal on the wire would
     make the whole flow untypeable on a keyboard without Ł/Ą. */
  it("disable: the confirmation literal on the wire is ASCII (typeable in every locale)", () => {
    expect(E2EE_DISABLE_CONFIRM).toMatch(/^[\x20-\x7e]+$/);
  });

  it("disable: requires EXACTLY the confirmation literal", () => {
    const emptyLedger = {
      accounts: [],
      groups: [],
      envelopes: [],
      categories: [],
      places: [],
      recurrences: [],
      allocations: [],
      transactions: [],
    };
    expect(e2eeDisableInput.safeParse({ confirm: E2EE_DISABLE_CONFIRM, ledger: emptyLedger }).success).toBe(true);
    expect(e2eeDisableInput.safeParse({ confirm: "disable-e2ee", ledger: emptyLedger }).success).toBe(false);
    // the LOCALIZED word the user types never reaches the wire — only the fixed constant does
    expect(e2eeDisableInput.safeParse({ confirm: "WYŁĄCZ-E2EE", ledger: emptyLedger }).success).toBe(false);
    expect(e2eeDisableInput.safeParse({ confirm: "YES", ledger: emptyLedger }).success).toBe(false);
    expect(e2eeDisableInput.safeParse({ ledger: emptyLedger }).success).toBe(false);
  });

  it("rekey: requires non-empty wrappedDek and kdfParams, and takes the owner assertion", () => {
    expect(sync2RekeyInput.safeParse({ wrappedDek: "v1.a", kdfParams: "{}" }).success).toBe(true);
    expect(sync2RekeyInput.safeParse({ wrappedDek: "", kdfParams: "{}" }).success).toBe(false);
    expect(sync2RekeyInput.safeParse({ wrappedDek: "v1.a" }).success).toBe(false);
    // the client derives the KEK (Argon2id) BEFORE calling — seconds in which the cookie can be
    // swapped, after which this device's password would re-key ANOTHER account's budget
    expect(sync2RekeyInput.safeParse({ wrappedDek: "v1.a", kdfParams: "{}", userId: "user-A" }).success).toBe(true);
  });

  it("reset: integer epoch, optional uptoCursor (≥0), non-empty blob", () => {
    expect(sync2ResetInput.safeParse({ epoch: 3, snapshotBlob: "v1.zzz" }).success).toBe(true);
    expect(sync2ResetInput.safeParse({ epoch: 3, uptoCursor: 42, snapshotBlob: "v1.zzz" }).success).toBe(true);
    expect(sync2ResetInput.safeParse({ epoch: 3, uptoCursor: -1, snapshotBlob: "v1.zzz" }).success).toBe(false);
    expect(sync2ResetInput.safeParse({ epoch: 3.5, snapshotBlob: "v1.zzz" }).success).toBe(false);
    expect(sync2ResetInput.safeParse({ epoch: 3, snapshotBlob: "" }).success).toBe(false);
  });

  /* The per-request OWNER assertion (ownerAssertionFails): each of these routes OVERWRITES the
     session user's whole budget (reset drops the journal and swaps the checkpoint; enable/disable
     rebuild it wholesale), the target is resolved from the session cookie alone, and the client's
     ownership check happened in an EARLIER request — the cookie can be swapped in between (the
     epoch cannot tell tenants apart: two independently-encrypted budgets both sit at epoch 1). */
  it("reset / enable / disable carry an optional userId (the per-request owner assertion)", () => {
    const emptyLedger = {
      accounts: [],
      groups: [],
      envelopes: [],
      categories: [],
      places: [],
      recurrences: [],
      allocations: [],
      transactions: [],
    };
    expect(sync2ResetInput.safeParse({ epoch: 3, snapshotBlob: "v1.z", userId: "user-A" }).success).toBe(true);
    expect(sync2ResetInput.safeParse({ epoch: 3, snapshotBlob: "v1.z", userId: "" }).success).toBe(false);
    expect(
      e2eeEnableInput.safeParse({ wrappedDek: "v1.a", kdfParams: "{}", snapshotBlob: "v1.b", userId: "user-A" })
        .success,
    ).toBe(true);
    expect(
      e2eeDisableInput.safeParse({ confirm: E2EE_DISABLE_CONFIRM, ledger: emptyLedger, userId: "user-A" }).success,
    ).toBe(true);
    // a pre-2.0 client omits it — then there is simply nothing to assert
    expect(e2eeDisableInput.safeParse({ confirm: E2EE_DISABLE_CONFIRM, ledger: emptyLedger }).success).toBe(true);
  });
});
