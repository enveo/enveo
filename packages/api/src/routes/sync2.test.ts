/**
 * Pure sync2 input-validation tests (zod) — no DB. DB logic (push/pull/
 * snapshot, enable/disable, epoch guards) is covered e2e in stage 2.
 */
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

  it("enable: requires wrappedDek + kdfParams + snapshotBlob", () => {
    expect(
      e2eeEnableInput.safeParse({ wrappedDek: "v1.a", kdfParams: "{}", snapshotBlob: "v1.b" }).success,
    ).toBe(true);
    expect(e2eeEnableInput.safeParse({ wrappedDek: "", kdfParams: "{}", snapshotBlob: "v1.b" }).success).toBe(false);
    expect(e2eeEnableInput.safeParse({ wrappedDek: "v1.a", kdfParams: "{}" }).success).toBe(false);
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
    expect(e2eeDisableInput.safeParse({ confirm: "WYŁĄCZ-E2EE", ledger: emptyLedger }).success).toBe(true);
    expect(e2eeDisableInput.safeParse({ confirm: "wyłącz-e2ee", ledger: emptyLedger }).success).toBe(false);
    expect(e2eeDisableInput.safeParse({ confirm: "TAK", ledger: emptyLedger }).success).toBe(false);
    expect(e2eeDisableInput.safeParse({ ledger: emptyLedger }).success).toBe(false);
  });

  it("rekey: requires non-empty wrappedDek and kdfParams", () => {
    expect(sync2RekeyInput.safeParse({ wrappedDek: "v1.a", kdfParams: "{}" }).success).toBe(true);
    expect(sync2RekeyInput.safeParse({ wrappedDek: "", kdfParams: "{}" }).success).toBe(false);
    expect(sync2RekeyInput.safeParse({ wrappedDek: "v1.a" }).success).toBe(false);
  });

  it("reset: integer epoch, optional uptoCursor (≥0), non-empty blob", () => {
    expect(sync2ResetInput.safeParse({ epoch: 3, snapshotBlob: "v1.zzz" }).success).toBe(true);
    expect(sync2ResetInput.safeParse({ epoch: 3, uptoCursor: 42, snapshotBlob: "v1.zzz" }).success).toBe(true);
    expect(sync2ResetInput.safeParse({ epoch: 3, uptoCursor: -1, snapshotBlob: "v1.zzz" }).success).toBe(false);
    expect(sync2ResetInput.safeParse({ epoch: 3.5, snapshotBlob: "v1.zzz" }).success).toBe(false);
    expect(sync2ResetInput.safeParse({ epoch: 3, snapshotBlob: "" }).success).toBe(false);
  });
});
