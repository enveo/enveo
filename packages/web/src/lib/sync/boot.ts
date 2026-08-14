/**
 * BOOT (workflow §3c-3) — metadata hydration, snapshot bootstrap, the legacy `planned` sweep
 * and the booting→ready/locked/unauthed/foreign/error transitions, plus the install-once boot
 * promise (bootOnce/retryBoot; StrictMode mounts effects twice). Single owner of
 * lastBootSource.
 */

import { accountPreferences } from "../accountPreferences";
import { devicePreferences } from "../devicePreferences";
import * as e2ee from "../e2ee";
import { idbGet } from "../idb";
import { purgeLegacyPlannedIds } from "../legacyPlanned";
import { migrateLegacySettings } from "../legacySettingsMigration";
import { local } from "../mutate";
import * as outbox from "../outbox";
import * as persist from "../persist";
import { requestPersistentStorage } from "../storage";
import { store } from "../store";
import { type BootSource, UnauthorizedError } from "./contracts";
import { syncNow } from "./cycle";
import { bootOwnerOk, enterUnauthed, verifiedIdentityUserId } from "./identity";
import { hydrateObligations } from "./obligations";
import { replayOutbox } from "./replica";
import { bumpStatus, getLastSyncAt, setLastSyncAt } from "./status";
import { bootstrapReplica, getClientId } from "./transport";

/* ── Boot diagnostics (BootSource type in sync/contracts.ts) ────────────── */

let lastBootSource: BootSource = null;
export function getLastBootSource(): BootSource {
  return lastBootSource;
}

/**
 * Best-effort load of meta flags (lastSyncAt, resyncPending) — each independently
 * and without throwing, so one failed read doesn't skip the other or
 * topple the whole boot. CRITICAL: the durable resync obligation (D1) must reach
 * memory on BOTH boot paths (success and recovery), otherwise a rejected op
 * would leave a "ghost" for the whole session.
 */
async function loadSyncMeta(): Promise<void> {
  try {
    // E2EE state (DEK + tier/epoch + checkpoint counter) — BEFORE bootstrap,
    // so bootstrapReplica picks the right path on the very first shot
    await e2ee.hydrate();
  } catch (e) {
    console.warn("reading e2ee state failed", e);
  }
  try {
    setLastSyncAt((await idbGet<string>("meta", "lastSyncAt")) ?? getLastSyncAt());
  } catch (e) {
    console.warn("reading lastSyncAt failed", e);
  }
  // durable resync + replace obligations (sync/obligations.ts): both must reach memory
  await hydrateObligations();
}

/**
 * One-time client-side sweep for legacy `planned` transactions (see legacyPlanned.ts): on a
 * PLAIN-tier budget migration 0018's server-side DELETE already removed them and the `changes`
 * journal replicates that everywhere, but on E2EE-tier budgets the server never saw plaintext —
 * that DELETE was a no-op there, so a replica that already had `planned` rows keeps them until
 * this sweep catches them. Runs right after the replica is resolved (hydrated/bootstrapped +
 * outbox replayed) and BEFORE `store.setBootStatus("ready")` hands it to the UI, so a leftover
 * row is never rendered even for a frame. `local.deleteTxn` is the normal applyOp+outbox path:
 * the delete pushes encrypted on e2ee, and is an idempotent no-op push on plain (the server
 * already dropped the row). Idempotent overall — nothing is left to find on the next boot.
 *
 * `local` is a plain static import. It used to be a lazy `import("../mutate")` purely to break
 * a cycle: mutate.ts reached `poke` through the `./sync` FACADE, which re-exports this module.
 * The cycle is gone at its source — mutate.ts now imports `poke` from `./sync/cycle` directly —
 * and the dynamic form had to go with it, because mutate.ts is statically imported across the
 * UI, so that `import()` could never split a chunk and only produced a build warning (§3f).
 */
async function sweepLegacyPlanned(): Promise<void> {
  const ledger = store.getLedger();
  if (!ledger) return;
  const ids = purgeLegacyPlannedIds(ledger);
  if (ids.length === 0) return;
  for (const id of ids) local.deleteTxn(id);
}

async function boot(): Promise<void> {
  store.setBootStatus("booting");
  void getClientId(); // persist the installation identifier as early as possible
  void requestPersistentStorage(); // harden durability AS EARLY AS POSSIBLE (anti-eviction iOS)
  try {
    const [hydrated] = await Promise.all([store.hydrate(), outbox.hydrate()]);
    await loadSyncMeta();
    // Whose replica is this? BEFORE it reaches the UI (and before any bootstrap) — see bootOwnerOk
    if (!(await bootOwnerOk())) return;
    const verifiedUserId = verifiedIdentityUserId();
    if (verifiedUserId) {
      await accountPreferences.hydrateForUser(verifiedUserId);
      try {
        await accountPreferences.sync(verifiedUserId);
        await devicePreferences.hydrate();
        await migrateLegacySettings();
      } catch (error) {
        console.warn("legacy preference migration deferred", error);
      }
    }
    if (hydrated === "empty") {
      lastBootSource = "snapshot"; // empty replica ⇒ full snapshot (slow; also after eviction)
      // on the right path per tier; a 409 tier_mismatch along the way switches the path (max 1 retry)
      if ((await bootstrapReplica()) === "locked") {
        // e2ee budget, no DEK — the Unlock screen (T2) provides the key and does retryBoot
        store.setBootStatus("locked");
        return;
      }
    } else {
      lastBootSource = "replica"; // local-first: we started from the local replica
    }
    // REPLAY the outbox onto the mirror — heals a crash between addOutbox of an op and persist
    // (reducers are idempotent: create guards the id, update = full replacement);
    // the mirror was a PREFIX of the outbox, so the replay catches it up (never rolls back)
    replayOutbox();
    await sweepLegacyPlanned();
    if (outbox.size() > 0) void persist.persistLedger(store.snapshotForPersist());
    store.setBootStatus("ready");
    bumpStatus();
    void syncNow("boot");
  } catch (e) {
    if (e instanceof UnauthorizedError) {
      // the backend requires login — login screen instead of a first-start
      // error; after OAuth the page returns to the origin → new boot
      enterUnauthed();
      return;
    }
    if (store.getLedger()) {
      // hydrate yielded data, only network/persist failed — we operate locally.
      lastBootSource = "replica";
      // Read the meta flags HERE too: the resync obligation from IDB must not be lost.
      await loadSyncMeta();
      replayOutbox();
      await sweepLegacyPlanned();
      store.setBootStatus("ready");
      bumpStatus();
      void syncNow("boot");
    } else {
      console.warn("First start without a server connection", e);
      store.setBootStatus("error");
    }
  }
}

let bootPromise: Promise<void> | null = null;

/** Boot once per module lifetime (StrictMode mounts effects 2×). */
export function bootOnce(): Promise<void> {
  if (!bootPromise) bootPromise = boot();
  return bootPromise;
}

/** Retry the first start (the "Try again" button). */
export function retryBoot(): Promise<void> {
  bootPromise = boot();
  return bootPromise;
}
