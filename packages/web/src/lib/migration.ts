import {
  ActualExportError,
  type ActualTables,
  API_REQUEST_MAX_BYTES,
  actualTablesToMigrationSource,
  buildMigrationLedger,
  type ClientLedger,
  clientLedgerSchema,
  type MigrationReceipt,
  type MigrationSource,
  type YnabPlan,
  YnabPlanError,
  ynabPlanToMigrationSource,
} from "@enveo/shared";
import { replaceLocalData, uploadReplacedData } from "./data";
import { currentMonth } from "./dates";
import { getTierMeta } from "./e2ee";
import { type Message, msg } from "./i18n";
import { MigrationFileTooLarge, YnabRequestError } from "./migrationSources";
import { customEnvelopeStyle } from "./onboardingTemplate";
import { store } from "./store";
import { clearReplacePending, fullResync, syncNowCompleted } from "./sync";
import { UnauthorizedError } from "./sync/contracts";
import { ACCOUNT_COLORS } from "./theme";

export interface PreparedMigration {
  ledger: ClientLedger;
  receipt: MigrationReceipt;
}

/** A migration replaces the ledger wholesale, so it may only land where there is no history to lose. */
export function migrationBlockedByData(ledger: ClientLedger | null): boolean {
  return !ledger || ledger.transactions.length > 0 || ledger.allocations.length > 0;
}

function prepare(source: MigrationSource): PreparedMigration {
  const ledger = store.getLedger();
  const budget = ledger?.budgets.find((candidate) => candidate.id === store.getBudgetId()) ?? ledger?.budgets[0];
  if (!budget) throw new Error("budget_mismatch");
  return buildMigrationLedger(source, {
    budget,
    newId: () => crypto.randomUUID(),
    envelopeStyle: customEnvelopeStyle,
    accountStyle: (index) => ({ color: ACCOUNT_COLORS[index % ACCOUNT_COLORS.length]!, icon: "wallet" }),
  });
}

export const prepareYnabMigration = (plan: YnabPlan): PreparedMigration => prepare(ynabPlanToMigrationSource(plan, currentMonth()));

export const prepareActualMigration = (tables: ActualTables): PreparedMigration => prepare(actualTablesToMigrationSource(tables, currentMonth()));

/** Ciphertext is base64 of the JSON plus its envelope, so an E2EE upload needs the extra margin. */
const E2EE_UPLOAD_GROWTH = 1.4;
/** The request wraps the ledger with the owner assertion and, on E2EE, the checkpoint fields. */
const UPLOAD_WRAPPER_BYTES = 1024;

export function migrationFitsUpload(ledger: ClientLedger, tier: "plain" | "e2ee"): boolean {
  const bytes = new Blob([JSON.stringify(ledger)]).size;
  return bytes * (tier === "e2ee" ? E2EE_UPLOAD_GROWTH : 1) + UPLOAD_WRAPPER_BYTES <= API_REQUEST_MAX_BYTES;
}

export class MigrationUploadPending extends Error {
  constructor(cause: unknown) {
    super("migration_upload_pending", { cause });
    this.name = "MigrationUploadPending";
  }
}

/** Only a lost connection or a server fault can heal by itself. Anything else the server said is its
 *  answer to this ledger, and repeating the same upload would get the same answer forever. */
export function uploadFailureIsRetryable(cause: unknown): boolean {
  if (cause instanceof TypeError) return true;
  const message = cause instanceof Error ? cause.message : "";
  return cause instanceof UnauthorizedError || /\b5\d\d\b/.test(message);
}

/**
 * Everything that can refuse happens before the local replica changes: a replacement the server
 * can never accept would otherwise stay owed forever. The completed sync is what proves the budget
 * is empty on the server too, including a transaction another device added while the receipt was
 * open or long before this replica last went offline.
 * Known gap: a write landing between this sync and the upload is still overwritten; closing that
 * needs a conditional replace on the server, worth it once budgets are shared between people.
 */
export async function applyMigration(prepared: PreparedMigration): Promise<void> {
  const ledger = clientLedgerSchema.parse(prepared.ledger) as ClientLedger;
  if (!migrationFitsUpload(ledger, getTierMeta().tier)) throw new Error("migration_too_large");
  if (!(await syncNowCompleted("migration"))) throw new Error("migration_needs_connection");
  if (migrationBlockedByData(store.getLedger())) throw new Error("migration_needs_empty_budget");
  const budgetId = store.getBudgetId();
  if (!budgetId) throw new Error("budget_mismatch");
  await replaceLocalData(ledger, budgetId);
  try {
    await uploadReplacedData();
  } catch (cause) {
    if (uploadFailureIsRetryable(cause)) throw new MigrationUploadPending(cause);
    // Back to the server's empty budget: the obligation could never be fulfilled.
    clearReplacePending();
    await fullResync();
    throw new Error("migration_rejected");
  }
}

export function migrationErrorMessage(error: unknown): Message {
  if (error instanceof YnabRequestError) {
    if (error.status === 401) return msg("YNAB did not accept this token. Check that you copied all of it.");
    if (error.status === 429) return msg("YNAB is limiting requests right now. Try again in an hour.");
    return msg("YNAB could not be reached. Try again in a moment.");
  }
  if (error instanceof YnabPlanError) {
    return error.code === "unsupported_currency"
      ? msg("Enveo only supports currencies with two decimals, and this budget uses another one.")
      : msg("This is not a YNAB budget file.");
  }
  if (error instanceof ActualExportError) {
    return error.code === "unsupported_currency"
      ? msg("Enveo only supports currencies with two decimals, and this budget uses another one.")
      : msg("This is not an Actual Budget export. Choose the zip file from Settings → Export data.");
  }
  if (error instanceof MigrationFileTooLarge) return msg("This file is too large to read in the browser.");
  if (error instanceof Error && error.message === "migration_needs_empty_budget") return msg("This budget already has transactions, so nothing was changed.");
  if (error instanceof Error && error.message === "migration_needs_connection")
    return msg("Enveo could not reach the server to confirm this budget is empty, so nothing was changed. Try again when you are online.");
  if (error instanceof Error && error.message === "migration_rejected") return msg("The server refused this budget, so it was not brought in.");
  if (error instanceof Error && error.message === "migration_too_large")
    return msg("This budget has more history than one upload can carry, so nothing was changed.");
  if (error instanceof TypeError) return msg("YNAB could not be reached. Try again in a moment.");
  return msg("The import did not finish, and your budget was not changed.");
}
