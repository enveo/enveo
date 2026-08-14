/**
 * Pure sync2 input-validation tests (zod) — no DB. DB logic (push/pull/
 * snapshot, enable/disable, epoch guards, the v1→v2 upgrade transaction) is
 * covered by the DB-backed suite in sync2.db.test.ts.
 *
 * Since ciphertext format v2 the schemas are the FIRST fail-closed layer:
 * every ciphertext field must carry the "v2." prefix (an old client's "v1."
 * body is a 400 — a legacy budget may not be extended with unauthenticated
 * ciphertext), and the per-request tenant assertions are REQUIRED (the prefix
 * already rejects every pre-v2 client, so no legacy body could legitimately
 * omit them).
 */

import { describe, expect, it } from "bun:test";
import { E2EE_DISABLE_CONFIRM } from "@enveo/shared";
import { e2eeDisableInput, e2eeEnableInput, e2eeUpgradeV2Input, sync2PushInput, sync2RekeyInput, sync2ResetInput, sync2SnapshotInput } from "./sync2";

const UUID = "11111111-1111-1111-1111-111111111111";

const emptyLedger = {
  accounts: [],
  groups: [],
  envelopes: [],
  categories: [],
  places: [],
  allocations: [],
  transactions: [],
};

describe("sync2 — input validation (format v2)", () => {
  it("push: accepts a valid v2 batch that names its budget", () => {
    const r = sync2PushInput.safeParse({
      epoch: 1,
      budgetId: UUID,
      ops: [{ opId: UUID, ciphertext: "v2.AAAAAAAA" }],
    });
    expect(r.success).toBe(true);
  });

  it("push: rejects a v1. ciphertext — an old client may not extend the journal", () => {
    expect(sync2PushInput.safeParse({ epoch: 1, budgetId: UUID, ops: [{ opId: UUID, ciphertext: "v1.AAAAAAAA" }] }).success).toBe(false);
    expect(sync2PushInput.safeParse({ epoch: 1, budgetId: UUID, ops: [{ opId: UUID, ciphertext: "v3.AAAAAAAA" }] }).success).toBe(false);
  });

  it("push: budgetId (the per-request tenant assertion AND the op-AAD context) is REQUIRED", () => {
    const ops = [{ opId: UUID, ciphertext: "v2.AAAAAAAA" }];
    expect(sync2PushInput.safeParse({ epoch: 1, budgetId: UUID, ops }).success).toBe(true);
    expect(sync2PushInput.safeParse({ epoch: 1, budgetId: "nope", ops }).success).toBe(false);
    // v2 rows are encrypted under (budgetId, epoch, opId) — a replica that cannot name its
    // budget cannot have produced them; the old "legacy replica" tolerance is gone on purpose.
    expect(sync2PushInput.safeParse({ epoch: 1, ops }).success).toBe(false);
  });

  it("push: rejects empty ops, a bad opId uuid, a too-short ciphertext, batch > 500, non-integer epoch", () => {
    expect(sync2PushInput.safeParse({ epoch: 1, budgetId: UUID, ops: [] }).success).toBe(false);
    expect(sync2PushInput.safeParse({ epoch: 1, budgetId: UUID, ops: [{ opId: "not-a-uuid", ciphertext: "v2.AAAAAAAA" }] }).success).toBe(false);
    expect(sync2PushInput.safeParse({ epoch: 1, budgetId: UUID, ops: [{ opId: UUID, ciphertext: "v2.x" }] }).success).toBe(false);
    const ops = Array.from({ length: 501 }, () => ({ opId: UUID, ciphertext: "v2.AAAAAAAA" }));
    expect(sync2PushInput.safeParse({ epoch: 1, budgetId: UUID, ops }).success).toBe(false);
    expect(sync2PushInput.safeParse({ epoch: 1.5, budgetId: UUID, ops: [{ opId: UUID, ciphertext: "v2.AAAAAAAA" }] }).success).toBe(false);
  });

  it("snapshot: requires integer epoch/uptoSeq, a v2 blob and the owner assertion", () => {
    expect(sync2SnapshotInput.safeParse({ epoch: 2, uptoSeq: 10, blob: "v2.zzzzzzzz", userId: "user-A" }).success).toBe(true);
    expect(sync2SnapshotInput.safeParse({ epoch: 2, uptoSeq: -1, blob: "v2.zzzzzzzz", userId: "user-A" }).success).toBe(false);
    expect(sync2SnapshotInput.safeParse({ epoch: 2, uptoSeq: 0, blob: "", userId: "user-A" }).success).toBe(false);
    expect(sync2SnapshotInput.safeParse({ epoch: 2, uptoSeq: 10, blob: "v1.zzzzzzzz", userId: "user-A" }).success).toBe(false);
    // POST /sync2/snapshot UPSERTs the resolved budget's only checkpoint and the client fires it
    // in the BACKGROUND — the widest cookie-swap window there is. The assertion is REQUIRED:
    // the v2 prefix already rejects every client old enough to have omitted it.
    expect(sync2SnapshotInput.safeParse({ epoch: 2, uptoSeq: 10, blob: "v2.zzzzzzzz" }).success).toBe(false);
    expect(sync2SnapshotInput.safeParse({ epoch: 2, uptoSeq: 10, blob: "v2.zzzzzzzz", userId: "" }).success).toBe(false);
  });

  it("enable: requires v2 wrappedDek/snapshotBlob, kdfParams, the owner assertion, budgetId and nextEpoch", () => {
    const ok = {
      wrappedDek: "v2.aaaaaaaa",
      kdfParams: "{}",
      snapshotBlob: "v2.bbbbbbbb",
      userId: "user-A",
      budgetId: UUID,
      nextEpoch: 1,
      credentialAction: { kind: "none" },
    };
    expect(e2eeEnableInput.safeParse(ok).success).toBe(true);
    expect(e2eeEnableInput.safeParse({ ...ok, wrappedDek: "v1.aaaaaaaa" }).success).toBe(false); // old client
    expect(e2eeEnableInput.safeParse({ ...ok, snapshotBlob: "v1.bbbbbbbb" }).success).toBe(false);
    expect(e2eeEnableInput.safeParse({ ...ok, wrappedDek: "" }).success).toBe(false);
    expect(e2eeEnableInput.safeParse({ ...ok, userId: undefined }).success).toBe(false);
    expect(e2eeEnableInput.safeParse({ ...ok, budgetId: undefined }).success).toBe(false);
    expect(e2eeEnableInput.safeParse({ ...ok, nextEpoch: undefined }).success).toBe(false);
    expect(e2eeEnableInput.safeParse({ ...ok, nextEpoch: 0 }).success).toBe(false); // enable always bumps to ≥1
    expect(e2eeEnableInput.safeParse({ ...ok, credentialAction: undefined }).success).toBe(false);
    expect(e2eeEnableInput.safeParse({ ...ok, credentialAction: { kind: "server-vault-to-e2ee", ciphertext: "v2.credentialAAAA" } }).success).toBe(true);
    expect(e2eeEnableInput.safeParse({ ...ok, credentialAction: { kind: "server-vault-to-e2ee", ciphertext: "v1.credentialAAAA" } }).success).toBe(false);
    expect(e2eeEnableInput.safeParse({ ...ok, credentialAction: { kind: "server-vault-to-e2ee", ciphertext: `v2.${"a".repeat(8_193)}` } }).success).toBe(false);
  });

  /* The WIRE literal must stay locale-independent ASCII: the word the user TYPES is localized
     (i18n `e2ee.disableWord`) and checked client-side, so a Polish literal on the wire would
     make the whole flow untypeable on a keyboard without Ł/Ą. */
  it("disable: the confirmation literal on the wire is ASCII (typeable in every locale)", () => {
    expect(E2EE_DISABLE_CONFIRM).toMatch(/^[\x20-\x7e]+$/);
  });

  it("disable: requires EXACTLY the confirmation literal and the owner assertion", () => {
    const ok = {
      confirm: E2EE_DISABLE_CONFIRM,
      ledger: emptyLedger,
      userId: "user-A",
      budgetId: UUID,
      expectedEpoch: 2,
      credentialAction: { kind: "none" },
    };
    expect(e2eeDisableInput.safeParse(ok).success).toBe(true);
    expect(e2eeDisableInput.safeParse({ ...ok, confirm: "disable-e2ee" }).success).toBe(false);
    // the LOCALIZED word the user types never reaches the wire — only the fixed constant does
    expect(e2eeDisableInput.safeParse({ ...ok, confirm: "WYŁĄCZ-E2EE" }).success).toBe(false);
    expect(e2eeDisableInput.safeParse({ ...ok, confirm: "YES" }).success).toBe(false);
    expect(e2eeDisableInput.safeParse({ ...ok, confirm: undefined }).success).toBe(false);
    expect(e2eeDisableInput.safeParse({ ...ok, userId: undefined }).success).toBe(false); // assertion required
    expect(e2eeDisableInput.safeParse({ ...ok, budgetId: undefined }).success).toBe(false);
    expect(e2eeDisableInput.safeParse({ ...ok, expectedEpoch: undefined }).success).toBe(false);
    expect(e2eeDisableInput.safeParse({ ...ok, credentialAction: undefined }).success).toBe(false);
    expect(e2eeDisableInput.safeParse({ ...ok, credentialAction: { kind: "e2ee-to-server-vault", key: "sk-move" } }).success).toBe(true);
    expect(e2eeDisableInput.safeParse({ ...ok, credentialAction: { kind: "e2ee-to-server-vault", key: "" } }).success).toBe(false);
  });

  it("rekey: requires a v2 wrappedDek, kdfParams, expectedEpoch and the owner assertion", () => {
    const ok = { wrappedDek: "v2.aaaaaaaa", kdfParams: "{}", userId: "user-A", expectedEpoch: 2 };
    expect(sync2RekeyInput.safeParse(ok).success).toBe(true);
    expect(sync2RekeyInput.safeParse({ ...ok, wrappedDek: "v1.aaaaaaaa" }).success).toBe(false);
    expect(sync2RekeyInput.safeParse({ ...ok, wrappedDek: "" }).success).toBe(false);
    expect(sync2RekeyInput.safeParse({ ...ok, kdfParams: undefined }).success).toBe(false);
    // the new envelope's AAD is bound to ONE epoch — a rekey landing on any other generation
    // would brick every future unlock, so the expectation is REQUIRED and validated
    expect(sync2RekeyInput.safeParse({ ...ok, expectedEpoch: undefined }).success).toBe(false);
    expect(sync2RekeyInput.safeParse({ ...ok, expectedEpoch: -1 }).success).toBe(false);
    expect(sync2RekeyInput.safeParse({ ...ok, expectedEpoch: 1.5 }).success).toBe(false);
    // the client derives the KEK (Argon2id) BEFORE calling — seconds in which the cookie can be
    // swapped, after which this device's password would re-key ANOTHER account's budget
    expect(sync2RekeyInput.safeParse({ ...ok, userId: undefined }).success).toBe(false);
  });

  it("reset: integer epoch, optional uptoCursor (≥0), v2 blob, owner assertion", () => {
    expect(sync2ResetInput.safeParse({ epoch: 3, snapshotBlob: "v2.zzzzzzzz", userId: "user-A" }).success).toBe(true);
    expect(sync2ResetInput.safeParse({ epoch: 3, uptoCursor: 42, snapshotBlob: "v2.zzzzzzzz", userId: "user-A" }).success).toBe(true);
    expect(sync2ResetInput.safeParse({ epoch: 3, uptoCursor: -1, snapshotBlob: "v2.zzzzzzzz", userId: "user-A" }).success).toBe(false);
    expect(sync2ResetInput.safeParse({ epoch: 3.5, snapshotBlob: "v2.zzzzzzzz", userId: "user-A" }).success).toBe(false);
    expect(sync2ResetInput.safeParse({ epoch: 3, snapshotBlob: "v1.zzzzzzzz", userId: "user-A" }).success).toBe(false);
    expect(sync2ResetInput.safeParse({ epoch: 3, snapshotBlob: "v2.zzzzzzzz" }).success).toBe(false);
    expect(sync2ResetInput.safeParse({ epoch: 3, snapshotBlob: "v2.zzzzzzzz", userId: "" }).success).toBe(false);
  });

  /* The upgrade ceremony route — EVERYTHING is required (per the current authoritative write
     policy: this NEW endpoint overwrites the session budget's entire E2EE state, so it carries
     BOTH tenant assertions; there is no pre-existing client to stay compatible with). */
  it("upgrade-v2: requires both tenant assertions, expectedEpoch, cipherVersion 2 and v2 ciphertexts", () => {
    const ok = {
      budgetId: UUID,
      userId: "user-A",
      expectedEpoch: 1,
      cipherVersion: 2,
      wrappedDek: "v2.aaaaaaaa",
      kdfParams: "{}",
      snapshotBlob: "v2.bbbbbbbb",
      credentialAction: { kind: "none" },
    };
    expect(e2eeUpgradeV2Input.safeParse(ok).success).toBe(true);
    expect(e2eeUpgradeV2Input.safeParse({ ...ok, budgetId: undefined }).success).toBe(false); // tenant assertion
    expect(e2eeUpgradeV2Input.safeParse({ ...ok, userId: undefined }).success).toBe(false); // owner assertion
    expect(e2eeUpgradeV2Input.safeParse({ ...ok, userId: "" }).success).toBe(false);
    expect(e2eeUpgradeV2Input.safeParse({ ...ok, expectedEpoch: undefined }).success).toBe(false);
    expect(e2eeUpgradeV2Input.safeParse({ ...ok, expectedEpoch: -1 }).success).toBe(false);
    expect(e2eeUpgradeV2Input.safeParse({ ...ok, cipherVersion: 1 }).success).toBe(false); // the ceremony PRODUCES v2
    expect(e2eeUpgradeV2Input.safeParse({ ...ok, wrappedDek: "v1.aaaaaaaa" }).success).toBe(false); // the old envelope is never reused
    expect(e2eeUpgradeV2Input.safeParse({ ...ok, snapshotBlob: "v1.bbbbbbbb" }).success).toBe(false);
    expect(e2eeUpgradeV2Input.safeParse({ ...ok, snapshotBlob: "" }).success).toBe(false);
    expect(e2eeUpgradeV2Input.safeParse({ ...ok, credentialAction: undefined }).success).toBe(false);
    expect(e2eeUpgradeV2Input.safeParse({ ...ok, credentialAction: { kind: "legacy-local-to-e2ee", ciphertext: "v2.credentialAAAA" } }).success).toBe(true);
    expect(e2eeUpgradeV2Input.safeParse({ ...ok, credentialAction: { kind: "legacy-local-to-e2ee", ciphertext: "v1.credentialAAAA" } }).success).toBe(false);
  });
});
