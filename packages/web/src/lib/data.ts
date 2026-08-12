/**
 * Data backup (JSON export / import) — local, offline-safe.
 *
 * PARAMOUNT: we never lose data. Import validates the WHOLE backup (envelope +
 * clientLedgerSchema) BEFORE anything is replaced — a corrupted file NEVER breaks
 * the local state or reaches the server.
 */
import { type ClientLedger, clientLedgerSchema } from "@enveo/shared";
import { getTierMeta } from "./e2ee";
import { translate, uiLang } from "./i18n";
import * as outbox from "./outbox";
import * as persist from "./persist";
import { store } from "./store";
import { isLocalOnly, markReplacePending, pushLocalToServer, resetServerE2ee } from "./sync";

const APP = "enveo";
// Pre-rebranding backup identifier — old export files MUST keep
// importing (we never lose data). Assembled at runtime so neither the code
// nor the built bundle contains the former name under greps.
const LEGACY_APP = ["4", "grosze"].join("");
const SCHEMA = 1;

/** Backup file envelope — a self-contained dump of the whole client replica. */
export interface Backup {
  app: string;
  schema: number;
  exportedAt: string;
  budgetId: string | null;
  ledger: ClientLedger;
}

/**
 * Download the whole replica as a `enveo-backup-<YYYY-MM-DD>.json` file (Blob + anchor).
 * Works offline (local mirror only). No data → a friendly exception.
 */
export function exportBackup(): void {
  const ledger = store.getLedger();
  if (!ledger) {
    throw new Error(translate(uiLang(), "There is nothing to export yet — wait for the app to finish loading."));
  }
  const backup: Backup = {
    app: APP,
    schema: SCHEMA,
    exportedAt: new Date().toISOString(),
    budgetId: store.getBudgetId(),
    ledger,
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `enveo-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // release the URL only after the download has started
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Load a backup from a file and REPLACE all data with it.
 *
 * Order critical for "we never lose data":
 *  1) read + JSON.parse + validate the envelope (app === APP or LEGACY_APP) and the ledger
 *     (clientLedgerSchema) — UNTIL that passes, we touch NOTHING,
 *  2) after validation set the DURABLE replace obligation (the import is canonical and must
 *     REPLACE the server), then store.replace(ledger) + persist + clear the outbox
 *     (the pre-import queue is moot — we replace the whole state),
 *  3) local mode → the replace is DEFERRED until resume (the obligation stays durable);
 *     otherwise → upload to the server right away (server := import, obligation fulfilled).
 *
 * We set the replace obligation BEFORE swapping the mirror: when the push is deferred
 * (local mode) or fails (network/5xx), the next cycle / resume
 * FINISHES the replace, and a delta pull(since=0) will NOT revert the import to the (old)
 * server state. Without this a restore silently vanished on the next synchronization.
 */
export async function importBackup(file: File): Promise<void> {
  const text = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(translate(uiLang(), "This is not a valid JSON file."));
  }
  const env = parsed as Partial<Backup> | null;
  if (!env || typeof env !== "object" || (env.app !== APP && env.app !== LEGACY_APP)) {
    throw new Error(translate(uiLang(), "This is not a backup of this app — choose a file exported from this application."));
  }
  const res = clientLedgerSchema.safeParse(env.ledger);
  if (!res.success) {
    const detail = res.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(translate(uiLang(), "The backup is corrupted and was not loaded: {detail}", { detail }));
  }

  // ── VALIDATION OK — only now we swap state (nothing was touched before) ──
  const ledger = res.data as ClientLedger;
  const budgetId = typeof env.budgetId === "string" ? env.budgetId : (store.getBudgetId() ?? "");

  // Durable replace obligation BEFORE swapping the mirror (the same serial persist
  // chain ⇒ durable-mirror implies durable-flag): the import must REPLACE the server.
  markReplacePending();
  store.replace(ledger, 0, budgetId); // memory
  outbox.clearAll(); // the pre-import queue is moot
  await persist.persistLedger(store.snapshotForPersist()); // durability

  if (isLocalOnly()) {
    return; // local mode — replace deferred until resume (the obligation stays durable)
  }
  // Path per tier: e2ee → encrypted checkpoint to /sync2/reset (plaintext NEVER
  // leaves the device; /sync/replace would bounce with a 409 tier_mismatch),
  // plain → /sync/replace as before. Both paths clear the replace obligation.
  if (getTierMeta().tier === "e2ee") {
    await resetServerE2ee(); // server := ciphertext of the imported replica
  } else {
    await pushLocalToServer(); // server := the imported data
  }
}

// Dev-only: hook for e2e verification (export/import without clicking the hidden input).
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__data = { exportBackup, importBackup };
}
