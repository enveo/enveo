/**
 * DB-backed sync2 / E2EE ciphertext-v2 suite (backlog §2, test group 5) — real Postgres, real
 * route handlers, real transactions. OPT-IN: set TEST_DATABASE_URL to a THROWAWAY Postgres —
 * this suite migrates and WRITES. CI provides a service container; locally:
 *   docker run -d --rm --name enveotest -e POSTGRES_USER=enveo \
 *     -e POSTGRES_PASSWORD=enveo -e POSTGRES_DB=enveo \
 *     -p 127.0.0.1:5499:5432 postgres:16-alpine
 *   TEST_DATABASE_URL=postgres://enveo:enveo@127.0.0.1:5499/enveo \
 *     bun test packages/api/src/routes/sync2.db.test.ts
 * There is deliberately NO fallback to DATABASE_URL (that one points at real data).
 *
 * The scenarios run in ONE child process (the pooled `db` is pinned to env.DATABASE_URL at
 * import time — see api.test-support.ts); this parent asserts its structured output. The child
 * builds the LEGACY budget as a synthetic pre-upgrade fixture (tier e2ee + "v1." ciphertexts +
 * cipher_version 1 — exactly what migration 0021 marks on a real pre-existing E2EE row).
 */
import { describe, expect, it } from "bun:test";
import { runChild } from "../api.test-support";
import { SENTINEL, type Sync2DbOutput } from "./sync2.db.test-child";

const TEST_URL = process.env.TEST_DATABASE_URL ?? "";
if (TEST_URL && TEST_URL === process.env.DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL — this suite writes to the DB.");
}

const CHILD = new URL("./sync2.db.test-child.ts", import.meta.url).pathname;
const CHILD_TIMEOUT_MS = 120_000;

describe.skipIf(!TEST_URL)("sync2 e2ee v2 (DB-backed)", () => {
  let out: Sync2DbOutput;

  it(
    "the child scenario completes against throwaway Postgres",
    async () => {
      out = await runChild<Sync2DbOutput>({
        path: CHILD,
        testUrl: TEST_URL,
        sentinel: SENTINEL,
        cwd: new URL("../..", import.meta.url).pathname,
      });
      expect(out).toBeDefined();
    },
    CHILD_TIMEOUT_MS,
  );

  it("enable refuses a stale nextEpoch and installs format 2 atomically", () => {
    expect(out.enableStaleEpochStatus).toBe(409);
    expect(out.enableStatus).toBe(200);
    expect(out.enabledRow).toEqual({ tier: "e2ee", cipherVersion: 2, epoch: 1, wrappedDek: "v2.wrapAAAA" });
    expect(out.enableSnapshotUptoSeq).toBe(0);
    expect(out.enablePlaintextWiped).toBe(true); // ciphertext first, plaintext wiped only after
    expect(out.enablePreferencesCleared).toBe(true);
    expect(out.completedImportReceiptCleared).toBe(true);
    expect(out.enableImportRevocation).toEqual({ cancelled: 4, detailsCleared: 4, leasesCleared: 4, errorsCleared: 4, imagesDeleted: 0 });
  });

  it("normal v2 push/pull work and round-trip the journal rows", () => {
    expect(out.pushStatus).toBe(200);
    expect(out.pulledOpIds).toHaveLength(2);
    expect(out.pulledCiphertexts.every((ct) => ct.startsWith("v2."))).toBe(true);
    expect(out.resetPreferencesCleared).toBe(true);
  });

  it("password rekey preserves the E2EE credential because the DEK and epoch do not change", () => {
    expect(out.rekeyCredentialPreserved).toBe(true);
    expect(out.rekeyEpochUnchanged).toBe(true);
  });

  it("EVERY normal sync2 route refuses a legacy budget with 409 e2ee_upgrade_required — reads included", () => {
    for (const [name, r] of Object.entries(out.legacyStatuses)) {
      expect({ name, status: r.status }).toEqual({ name, status: 409 });
      expect({ name, error: r.error }).toEqual({ name, error: "e2ee_upgrade_required" });
      expect({ name, cipherVersion: r.cipherVersion }).toEqual({ name, cipherVersion: 1 });
      expect(r.budgetId).toBeTruthy(); // the body NAMES the budget — the upgrade flow's proof needs it
      expect(r.epoch).toBe(1);
    }
    expect(Object.keys(out.legacyStatuses).sort()).toEqual(["disable", "pull", "pushV2", "rekey", "reset", "snapshotGet", "snapshotPost"]);
    expect(out.legacyJournalIntactAfterRefusals).toBe(true); // nothing was written by any refusal
  });

  it("an old client pushing v1. ciphertext is rejected at the boundary (400), not stored", () => {
    expect(out.v1PushStatus).toBe(400);
  });

  it("the upgrade ceremony: epoch +1, envelope rotated, legacy journal DELETED, checkpoint at 0 — one transaction", () => {
    expect(out.upgradeStatus).toBe(200);
    expect(out.upgradeBody?.epoch).toBe(2);
    expect(out.upgradeBody?.cipherVersion).toBe(2);
    expect(out.upgradeBody?.uptoSeq).toBe(0);
    expect(out.upgradedRow?.tier).toBe("e2ee");
    expect(out.upgradedRow?.cipherVersion).toBe(2);
    expect(out.upgradedRow?.epoch).toBe(2);
    expect(out.upgradedRow?.wrappedDek).toBe("v2.newWrapWINNER"); // a FRESH envelope — never the old one
    expect(out.upgradeJournalRowCount).toBe(0); // the entire legacy journal is gone
    expect(out.upgradeSnapshot).toEqual({ uptoSeq: 0, blob: "v2.newCheckpointAAAA" });
    expect(out.upgradePreferencesCleared).toBe(true);
    expect(out.upgradeCredentialRotated).toBe(true);
  });

  it("a retry of the SAME committed attempt is idempotent; a DIFFERENT attempt is a stale-epoch 409", () => {
    expect(out.retryStatus).toBe(200); // the response was lost — the client may safely retry
    expect(out.retryEpoch).toBe(2);
    expect(out.epochAfterRetry).toBe(2); // never two epoch increments
    expect(out.staleAttemptStatus).toBe(409);
    expect(out.staleAttemptEpochInBody).toBe(2); // the loser learns the current generation
    expect(out.staleAttemptCipherVersionInBody).toBe(2); // …and the current FORMAT (R2: no one-way trap)
    expect(out.rowAfterStaleAttempt).toEqual({ epoch: 2, wrappedDek: "v2.newWrapWINNER" }); // untouched
  });

  it("a forced mid-transaction failure rolls back ALL effects (envelope, version, epoch, journal)", () => {
    expect(out.forcedFailureStatus).toBe(500);
    expect(out.rowAfterForcedFailure).toEqual({ cipherVersion: 1, epoch: 1, wrappedDek: "v1.legacyWrap" });
    expect(out.journalIntactAfterForcedFailure).toBe(true);
    expect(out.forcedFailurePreferencesPreserved).toBe(true);
  });

  it("two concurrent upgrades produce ONE generation: one winner, one 409, one epoch bump", () => {
    expect(out.concurrentStatuses).toEqual([200, 409]);
    expect(out.concurrentEpoch).toBe(5); // 4 → 5, exactly once
    expect(out.concurrentEnvelopeIsAWinner).toBe(true); // the stored envelope is the winner's
  });

  it("a cookie-swapped tenant and a foreign budgetId write NOTHING — the budget_mismatch CODE, not a tier guard", () => {
    // userB owns an e2ee v2 budget, so the request reaches (and dies on) the per-request
    // assertions themselves: the specific error code proves it is not TierMismatch in disguise.
    expect(out.cookieSwapStatus).toBe(409);
    expect(out.cookieSwapError).toBe("budget_mismatch");
    expect(out.cookieSwapWroteNothing).toBe(true);
    expect(out.foreignBudgetIdStatus).toBe(409);
    expect(out.foreignBudgetIdError).toBe("budget_mismatch");
  });

  it("disable still restores the plaintext and clears all ciphertext state", () => {
    expect(out.disableStatus).toBe(200);
    expect(out.disabledRow).toEqual({ tier: "plain", wrappedDek: null });
    expect(out.disableCipherStateCleared).toBe(true);
    expect(out.disablePlaintextRestored).toBe(true);
    expect(out.disablePreferencesRestored).toBe(true);
  });

  it("refuses E2EE while a server-vault credential exists without touching either copy", () => {
    expect(out.credentialBlock).toEqual({
      status: 409,
      error: "credential_move_required",
      tier: "plain",
      credentialIntact: true,
      plaintextIntact: true,
    });
  });

  it("moves a server-vault credential into the new E2EE epoch atomically and retries idempotently", () => {
    expect(out.credentialMove).toEqual({
      status: 200,
      retryStatus: 200,
      tier: "e2ee",
      storageKind: "e2ee_ciphertext",
      e2eeEpoch: 1,
      ciphertext: "v2.movedCredential",
      vaultFieldsCleared: true,
      plaintextWiped: true,
    });
  });

  it("moves E2EE BYOK back into the server vault atomically and retries idempotently", () => {
    expect(out.credentialReturnToVault).toEqual({
      forcedFailureStatus: 500,
      rollbackPreserved: true,
      status: 200,
      retryStatus: 200,
      tier: "plain",
      storageKind: "server_vault",
      e2eeEpoch: null,
      vaultFieldsPresent: true,
      openedKey: "sk-returned-secret",
      cipherStateCleared: true,
    });
  });

  it("serializes credential save against E2EE enable and never commits an e2ee + server_vault budget", () => {
    expect(out.credentialRace.saveOutcome).not.toBe("unexpected_error");
    expect(out.credentialRace.forbiddenCombinationAbsent).toBe(true);
    if (out.credentialRace.saveOutcome === "saved") {
      expect(out.credentialRace).toMatchObject({
        enableStatus: 409,
        enableError: "credential_move_required",
        finalTier: "plain",
        credentialCount: 1,
      });
    } else {
      expect(out.credentialRace).toMatchObject({ enableStatus: 200, finalTier: "e2ee", credentialCount: 0 });
    }
  });
});
