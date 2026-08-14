/**
 * "Delete all data" recovery for an UNPROVEN replica (owner decision, 2026-08-12).
 *
 * The context: "Start from scratch" (Settings → Advanced) is gated on assertOwnReplica(),
 * which throws for a replica whose owner cannot be established — and an unproven replica is
 * exactly the state a user can land in after clearing an unbound replica, where
 * this reset WAS the escape hatch. Instead of a dead-end error, the UI shows ONE dialog
 * ("this device's local copy cannot be linked to this account") with two actions: export a
 * backup of the local copy (it may be the last copy), or delete everything and start fresh.
 *
 * The delete path deliberately does NOT require the replica assertion: the operation sends
 * NOTHING from the replica — /budget/reset wipes the budget the SESSION resolves, so the
 * tenant to assert is the session user, not the replica's unprovable owner. The id still
 * travels in the request body (the per-REQUEST owner assertion every full-budget write
 * carries): this check and the write are two requests, and the cookie can be swapped in
 * between — the server refuses a body whose userId is not the session it resolves (409
 * budget_mismatch, nothing written). assertOwnReplica() itself stays untouched everywhere.
 *
 * The multi-tenant guard's invariant holds: NOTHING here runs unattended. The dialog is the
 * human in the loop — it offers the backup export FIRST, and only an explicit tap on the
 * destructive action starts the sequence below.
 */
import { api } from "./api";
import { endSession, fetchSessionUserId } from "./auth";
import { clearDeviceStoragePolicy } from "./deviceStoragePolicy";
import { clearLastAccountId } from "./lastAccount";
import { clearPersistedSettings } from "./settingsPersist";
import { discardLocalReplica, enterLoginPreservingReplica } from "./sync";

/**
 * Did a server-write guard refuse because the replica is not provably the session's?
 * assertOwnReplica throws the sentinel code "foreign_replica" for BOTH verdicts that block a
 * write (a foreign stamp, an owner that cannot be proved) — for a genuinely FOREIGN stamp
 * enterForeignReplica has already flipped BootStatus, so the app unmounts Settings into
 * ForeignReplicaScreen and the recovery dialog this predicate gates never shows.
 */
export function isUnprovenReplicaError(e: unknown): boolean {
  return e instanceof Error && e.message === "foreign_replica";
}

/** The steps of the recovery sequence — injectable so the ORDER is unit-testable. */
export interface RecoverySteps {
  /** Session user id straight from the server (null = signed out meanwhile). */
  fetchSessionUserId: () => Promise<string | null>;
  /** POST /budget/reset naming the session user (per-request owner assertion). */
  budgetReset: (userId: string) => Promise<unknown>;
  /** End the session (bare — the local wipe follows separately). */
  signOut: () => Promise<void>;
  /** Per-device state that must not outlive the account (the LogoutRow wipe set). */
  clearDeviceStoragePolicy: () => void;
  clearPersistedSettings: () => void;
  clearLastAccountId: () => void;
  /** Wipe mirror + outbox + DEK + local-mode flag, then reload → Login. */
  discardLocalReplica: () => Promise<void>;
  /** No session anymore → Login screen, replica intact (there is no tenant to delete for). */
  enterLogin: () => void;
}

const realSteps: RecoverySteps = {
  fetchSessionUserId,
  budgetReset: (userId) => api.budgetReset(userId),
  signOut: endSession,
  clearDeviceStoragePolicy,
  clearPersistedSettings,
  clearLastAccountId,
  discardLocalReplica,
  enterLogin: enterLoginPreservingReplica,
};

/**
 * "Delete everything and start fresh": server budget reset → sign out → wipe the device.
 *
 * ORDER is load-bearing, in the same spirit as the cloud LogoutRow:
 *  1. the SERVER reset runs first and alone — it needs the session, and a failure (network,
 *     409 budget_mismatch after a cookie swap, 409 tier_mismatch on an e2ee budget) must leave
 *     the device untouched: the local copy may be the last one, and the dialog re-renders the
 *     error with the export still on offer,
 *  2. sign-out BEFORE the wipe — a wipe before a failed sign-out would strand a signed-in
 *     session on an empty replica; a failed sign-out after a successful reset just re-shows
 *     the dialog (retrying the reset is harmless — the budget is already empty),
 *  3. only then the per-device state (storage policy, settings incl. the BYOK key, last-account)
 *     and the replica itself — discardLocalReplica clears the outbox, the local-mode flag and
 *     IDB, then reloads; with no session the boot lands on Login with a clean device.
 *
 * If the session evaporated before step 1 (signed out in another tab), there is nothing to
 * delete on this session's behalf — route to Login and destroy nothing.
 */
export async function deleteEverythingAndStartFresh(steps: RecoverySteps = realSteps): Promise<void> {
  const userId = await steps.fetchSessionUserId();
  if (!userId) {
    steps.enterLogin();
    return;
  }
  await steps.budgetReset(userId); // server FIRST — on failure nothing local is touched
  await steps.signOut(); // before the wipe (see ORDER above)
  steps.clearDeviceStoragePolicy();
  steps.clearPersistedSettings();
  steps.clearLastAccountId();
  await steps.discardLocalReplica(); // wipes + reloads → Login on a clean device
}
