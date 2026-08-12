import { computeStateResponse, type StateResponse } from "@enveo/shared";
import { useMemo, useSyncExternalStore } from "react";
import { translate, uiLang, type Message, msg } from "./i18n";
import { store } from "./store";
import { getSyncStatus, subscribeSyncStatus, type SyncStatus } from "./sync";

 
export type { AccountView, EnvelopeView, StateResponse } from "@enveo/shared";
import { AI_IMPORT_EXTRACT_TIMEOUT_MS, type AiLocale, type BudgetSuggestProfile, type BudgetSuggestResponse, type ClientLedger } from "@enveo/shared";
import { timeoutSignal } from "./timeoutSignal";
export type { BudgetSuggestProfile, BudgetSuggestResponse } from "@enveo/shared";

 
export interface ImportItem {
  date: string;
  amount: number;
  

  type: "expense" | "income" | "transfer";
  isRefund?: boolean;
  toAccountId?: string | null;
  name: string;
  tag: string;
  rawPlace?: string | null; // raw bank description → source_ref (not shown in the UI, carried into apply)
  envelopeId: string | null;
  envelopeName?: string | null;
  categoryId?: string | null;
  categoryName?: string | null;
  placeName?: string | null;
  

  currency?: string;
  /** Original foreign amount + code (e.g. "5.00 USD") when this row is a converted/settled
   *  charge — shown as a muted caption; "" or absent otherwise. */
  fxOriginal?: string;
}



export interface EditedImportItem {
  type: "expense" | "income" | "transfer";
  accountId: string;
  toAccountId: string | null;
  isRefund: boolean;
  amount: number;
  date: string;
  name: string;
  envelopeId: string | null;
  categoryId: string | null;
  placeName: string | null;
  note: string;
}


export type ImportApplyItem = Omit<ImportItem, "type"> & Partial<EditedImportItem> & { type: "expense" | "income" | "transfer"; force?: boolean };
export interface ImportApplyResponse {
  added: number;
  skipped: number;
  dryRun: boolean;
  results: Array<ImportItem & { status: "added" | "exists" | "probable" }>;
}

/**
 * Server error CODES (snake_case) → dictionary key. The API never sends prose: it answers with a
 * stable machine code (structured detail rides in its own field), and the CLIENT owns the wording
 * in every locale. Keep this the single mapping point — an unknown code (older/newer server) falls
 * through to the raw text, so the user always sees something rather than an empty error.
 */
const ERROR_KEYS: Record<string, Message> = {
  ai_unavailable: msg("The server has no OpenAI key configured. Set OPENAI_API_KEY and restart the app, or use your own key in Settings → Artificial intelligence."),  
  ai_upstream_error: msg("OpenAI rejected the request — check the key and the model, then try again."),  
  upstream: msg("OpenAI rejected the request — check the key and the model, then try again."),  
  /* Transport failures get their OWN honest wording (since the AI-transport package): a timeout
     or an unreachable service is NOT a key/model problem — the same two codes come from the
     server routes (openaiHttp.ts classification) and from our own transport (openai.ts, http()). */
  ai_timeout: msg("The AI service took too long to answer — nothing was changed. Try again in a moment."),  
  ai_unreachable: msg("Could not reach the AI service — check the network connection and try again."),  
  backup_invalid: msg("This is not a valid backup file — nothing was loaded."), // /sync/replace — the payload is not a ledger
  foreign_ref: msg("The data references records that do not exist here (a corrupted or foreign file). Nothing was changed."),  
  budget_mismatch: msg("The signed-in account changed while the data was being sent — nothing was written. Reload the app and try again."),  
  budget_not_empty: msg("The budget is not empty — demo data can only be loaded into an empty budget."),  
  too_large: msg("The upload is too large — try fewer (or smaller) screenshots."),  
  internal: msg("The server hit an unexpected error. Nothing was changed — try again."),

  /* Client-side codes — the same contract: lib/* throws a CODE (never a sentence, never a locale),
     the wording lives here. They reach a user through the very same setError(apiErrorMessage(e)). */
  foreign_replica: msg("This device's local copy could not be confirmed to belong to the signed-in account — nothing was sent to the server. Settings → Sync explains what happened and what you can do."), // assertOwnReplica — the replica is not the session's
  no_local_replica: msg("The local copy of the budget has not loaded yet — nothing was sent. Reload the app and try again."),  
  no_encryption_key: msg("This device has no encryption key — unlock the budget with your password (or a pairing code) and try again."),  
  empty_unbound_replica: msg("There is no data on this device to send — nothing was sent to the server. Reload the app to fetch your budget first."),  
  bad_ciphertext: msg("The encrypted data could not be read on this device — nothing was changed. Make sure the app is up to date, or restore from a backup."), // crypto.ts — envelope this build cannot read (corrupt/foreign)
  bad_pairing_code: msg("This is not a valid pairing code — copy it again from the device where the budget is already unlocked."), // crypto.ts — decodePairing on a code that is not ours
  ai_consent_required: msg("AI is not set up on this device. Pick a mode in Settings → Artificial intelligence (with your own key, paste it there)."),  
  


  ai_offline: msg("You are offline — screenshot import needs a connection. Manual entry works without one."), // fetch never left the device — the normal state of an offline PWA
  ai_key_invalid: msg("OpenAI rejected your key — check it in Settings → Artificial intelligence."),  

  

  invalid_email_or_password: msg("Wrong email or password."),
  invalid_email: msg("That does not look like a valid email address."),
  user_already_exists: msg("An account with this email already exists — sign in instead."),
  password_too_short: msg("The password must be at least 8 characters."),
  password_too_long: msg("That password is too long."),
  signups_closed: msg("Registration is closed on this server."),  
  sign_in_failed: msg("Could not sign in — please try again."),  
  sign_up_failed: msg("Could not create the account — please try again."),
  auth_meta_failed: msg("Could not sign in — please try again."),  
};

 
function localizeError(code: string): string {
  const key = ERROR_KEYS[code];
  return key ? translate(uiLang(), key) : code;
}

 
export function apiErrorMessage(e: unknown): string {
  const m = String((e as Error).message ?? e);
  const i = m.indexOf("{");
  if (i >= 0) {
    try {
      const parsed = JSON.parse(m.slice(i)) as { error?: string };
      if (parsed.error) return localizeError(parsed.error);
    } catch {
       
    }
  }
  return localizeError(m); // sentinels thrown client-side (foreign_replica); otherwise the raw text
}

 




async function http<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const t = timeoutMs === undefined ? undefined : timeoutSignal(timeoutMs);
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: t?.signal,
    });
  } catch (e) {
    if (!t) throw e;
    if (t.timedOut()) throw new Error("ai_timeout");
    throw new Error(typeof navigator !== "undefined" && navigator.onLine === false ? "ai_offline" : "ai_unreachable");
  } finally {
    t?.clear();
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${res.status} ${txt}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}






export const api = {
   
  aiInfo: () => http<{ serverAi: boolean }>("GET", "/ai/info"),

  /* `locale` = the UI language (any BCP-47 tag): the model writes its names, notes and
     rationales in it. Not to be confused with demoSeed's pl|en, which picks a SEED DATASET. */
  importExtract: (images: string[], locale: AiLocale) => http<{ items: ImportItem[] }>("POST", "/import/extract", { images, locale }, AI_IMPORT_EXTRACT_TIMEOUT_MS),
  /* `budgetId` = the same PER-REQUEST tenant assertion as the sync push: the batch creates
     FRESH transactions in whatever budget the session cookie resolves to, and the cookie can
     be swapped in another tab while the import sheet is open. The caller passes the replica's
     budgetId (after assertOwnReplica); the server refuses a mismatch (409 budget_mismatch,
     nothing written). */
  importApply: (b: { accountId: string; budgetId?: string; items: ImportApplyItem[]; dryRun?: boolean }) =>
    http<ImportApplyResponse>("POST", "/import/apply", b),

  budgetSuggest: (b: { month: string; profile: BudgetSuggestProfile; customPrompt?: string; ledger?: ClientLedger; locale: AiLocale; useAi?: boolean }) =>
    http<BudgetSuggestResponse>("POST", "/budget/suggest", b),

  

  demoSeed: (locale: "pl" | "en", userId: string) => http<{ seeded: boolean }>("POST", "/demo/seed", { locale, userId }),
  budgetReset: (userId: string) => http<{ reset: boolean }>("POST", "/budget/reset", { confirm: "RESET", userId }),

  /* E2EE (sync v2) — tier switching and the key envelope; crypto EXCLUSIVELY on
     the client side (lib/crypto.ts) — only ciphertexts travel here.
     `userId` = the PER-REQUEST owner assertion: both routes OVERWRITE the session user's whole
     budget, and the caller's ownership check (assertOwnReplica) is a different request than this
     one — the shared cookie can be swapped in between. The server refuses a body whose userId is
     not the session it resolves (409 budget_mismatch, nothing written). */
  e2eeEnable: (b: { wrappedDek: string; kdfParams: string; snapshotBlob: string; userId: string }) =>
    http<{ epoch: number }>("POST", "/budget/e2ee/enable", b),
  e2eeDisable: (b: { confirm: string; ledger: ClientLedger; userId: string }) =>
    http<{ epoch: number }>("POST", "/budget/e2ee/disable", b),
  e2eeRekey: (b: { wrappedDek: string; kdfParams: string; userId: string }) => http<{ epoch: number }>("POST", "/sync2/rekey", b),
   
  e2eeSnapshot: () =>
    http<{
      budgetId: string;
      epoch: number;
      wrappedDek: string | null;
      kdfParams: string | null;
      uptoSeq: number;
      blob: string | null;
    }>("GET", "/sync2/snapshot"),
};

 

 
export function useLedgerVersion(): number {
  return useSyncExternalStore(store.subscribe, store.getVersion);
}






export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(subscribeSyncStatus, getSyncStatus);
}








export function useStateQuery(month: string): {
  data: StateResponse | undefined;
  isLoading: boolean;
  isError: boolean;
} {
  const version = useLedgerVersion();
  const data = useMemo(() => {
    const ledger = store.getLedger();
    return ledger ? computeStateResponse(ledger, month) : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, month]);
  const failed = store.getBootStatus() === "error";
  return { data, isLoading: !data && !failed, isError: !data && failed };
}
