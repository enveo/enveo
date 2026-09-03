import { computeStateResponse, type StateResponse } from "@enveo/shared";
import { useMemo, useSyncExternalStore } from "react";
import { type Message, msg, translate, uiLang } from "./i18n";
import { store } from "./store";
import { getSyncStatus, type SyncStatus, subscribeSyncStatus } from "./sync";

/* ── API response shapes — @enveo/shared is the source of truth ──── */
export type { AccountView, EnvelopeView, StateResponse } from "@enveo/shared";

import {
  AI_IMPORT_EXTRACT_TIMEOUT_MS,
  AI_PROXY_CHAT_TIMEOUT_MS,
  type AiLocale,
  type BudgetSuggestProfile,
  type BudgetSuggestResponse,
  type ChatRequest,
  type ClientLedger,
  type OpenAiModel,
  type ReconciledImportRecognitionResult,
} from "@enveo/shared";
import { getAccountPreferencesRemote, patchAccountPreferencesRemote } from "./accountPreferencesRemote";
import { runServerWriteOperation } from "./serverWriteOperations";
import { timeoutSignal } from "./timeoutSignal";

export type { BudgetSuggestProfile, BudgetSuggestResponse } from "@enveo/shared";

/* Complete ledger-candidate shape used only for duplicate dry-run/apply planning.
 * Recognition itself returns the reconciled result so evidence-only rows and explicit
 * duplicate/source-account metadata are not erased. */
export interface ImportItem {
  date: string;
  amount: number;
  /** transfer/isRefund/toAccountId are reviewed recognition candidates. History is
   *  account-scoped evidence only; it never hard-overrides the visible facts. */
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
  /** ISO-4217 of `amount`, as extracted from the screenshot — presentation-only, warns the
   *  user in the review sheet when it differs from the budget's own currency. */
  currency?: string;
  /** Original foreign amount + code (e.g. "5.00 USD") when this row is a converted/settled
   *  charge — shown as a muted caption; "" or absent otherwise. */
  fxOriginal?: string;
}
/** Import item corrections from the editor (AddScreen in draft mode) — spec §3.
 *  Fields go to local import planning merged with the original; rawPlace/source_ref
 *  ALWAYS from the original (the self-learning loop). */
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
/** An item sent to import planning (and the plain dry-run API): the extraction original + OPTIONAL corrections
 *  from the editor (merged in ImportSheet). rawPlace always from the original. */
export type ImportApplyItem = Omit<ImportItem, "type"> &
  Partial<EditedImportItem> & {
    type: "expense" | "income" | "transfer";
    /** Stable Stage-A proposal identity used only by recoverable local job apply. */
    importRowId?: string;
    force?: boolean;
    /** False distinguishes an explicitly cleared expense envelope from missing/automatic input. */
    automaticEnvelopeDefault?: boolean;
  };
export interface ImportApplyResponse {
  added: number;
  skipped: number;
  dryRun: boolean;
  results: Array<ImportItem & { status: "added" | "exists" | "probable"; automaticEnvelopeDefault?: boolean }>;
}

export interface E2eeCredentialResponse {
  configured: boolean;
  budgetId: string;
  epoch: number;
  ciphertext?: string;
}

/**
 * Server error CODES (snake_case) → dictionary key. The API never sends prose: it answers with a
 * stable machine code (structured detail rides in its own field), and the CLIENT owns the wording
 * in every locale. Keep this the single mapping point — an unknown code (older/newer server) falls
 * through to the raw text, so the user always sees something rather than an empty error.
 */
const ERROR_KEYS: Record<string, Message> = {
  ai_unavailable: msg("The server has no OpenAI key configured — server mode is unavailable. Use an existing own key or keep AI on rules."), // screenshot recognition, /budget/suggest, the /api/ai mirror — no operator key
  ai_upstream_error: msg("OpenAI rejected the request — check the key and the model, then try again."), // OpenAI rejected the call or answered unparsably
  upstream: msg("OpenAI rejected the request — check the key and the model, then try again."), // /budget/suggest names the same failure this way
  /* Transport failures get their OWN honest wording (since the AI-transport package): a timeout
     or an unreachable service is NOT a key/model problem — the same two codes come from the
     server routes (openaiHttp.ts classification) and from our own transport (openai.ts, http()). */
  ai_timeout: msg("The AI service took too long to answer — nothing was changed. Try again in a moment."), // the round-trip exceeded its cap (ours or the server's)
  ai_unreachable: msg("Could not reach the AI service — check the network connection and try again."), // a network failure with no answer at all (while online)
  /* Cloud per-user spend budget (429 from every operator-key AI route): the server sends only
     the machine code + retryAfterSeconds — never the recorded spend. One whole phrase. */
  ai_budget_exhausted: msg(
    "The monthly AI allowance for this account is used up — it resets at the start of the next month (UTC). An existing own key can still be selected in Settings → Artificial intelligence.",
  ),
  backup_invalid: msg("This is not a valid backup file — nothing was loaded."), // /sync/replace — the payload is not a ledger
  foreign_ref: msg("The data references records that do not exist here (a corrupted or foreign file). Nothing was changed."), // a reference points outside the budget (corrupt/foreign file)
  budget_mismatch: msg("The signed-in account changed while the data was being sent — nothing was written. Reload the app and try again."), // the session was swapped mid-write — nothing was written
  budget_not_empty: msg("The budget is not empty — demo data can only be loaded into an empty budget."), // /demo/seed only ever fills an empty budget
  too_large: msg("The upload is too large — try fewer (or smaller) screenshots."), // bodyLimit (e.g. too many/too heavy screenshots)
  internal: msg("The server hit an unexpected error. Nothing was changed — try again."),
  invalid_import_job_state: msg("This import expired. Start a new import from the screenshots."),

  /* Client-side codes — the same contract: lib/* throws a CODE (never a sentence, never a locale),
     the wording lives here. They reach a user through the very same setError(apiErrorMessage(e)). */
  foreign_replica: msg(
    "This device's local copy could not be confirmed to belong to the signed-in account — nothing was sent to the server. Settings → Sync explains what happened and what you can do.",
  ), // assertOwnReplica — the replica is not the session's
  no_local_replica: msg("The local copy of the budget has not loaded yet — nothing was sent. Reload the app and try again."), // pushLocalToServer/resetServerE2ee before the mirror booted
  no_encryption_key: msg("This device has no encryption key — unlock the budget with your password (or a pairing code) and try again."), // resetServerE2ee with no DEK on this device (locked)
  empty_unbound_replica: msg("There is no data on this device to send — nothing was sent to the server. Reload the app to fetch your budget first."), // refused: an empty unbound replica can only wipe
  bad_ciphertext: msg("The encrypted data could not be read on this device — nothing was changed. Make sure the app is up to date, or restore from a backup."), // crypto.ts — envelope this build cannot read (corrupt/foreign)
  legacy_ciphertext: msg(
    "This data uses an older encryption format that this version no longer reads — run the encryption upgrade in Settings → Privacy on the device that holds the budget.",
  ), // crypto.ts — a pre-AAD "v1." value reached a normal decrypt (fail-closed by design)
  e2ee_upgrade_required: msg(
    "This budget's encryption must be upgraded before it can sync — open Settings → Privacy on a device that holds the data and run the upgrade.",
  ), // sync2 routes — the server refuses every normal channel of a legacy-format budget
  bad_pairing_code: msg("This is not a valid pairing code — copy it again from the device where the budget is already unlocked."), // crypto.ts — decodePairing on a code that is not ours
  ai_consent_required: msg("AI is not configured. Choose server AI or an existing own key in Settings → Artificial intelligence."), // ai.ts — no usable target (AI off, or byok with no key)
  /* openai.ts — screenshot import is AI-only, so a failed model call is SHOWN (no rules fallback to
     hide it). The transport maps every failure onto a code here; ai_unavailable/ai_upstream_error
     above are reused (the mirror's own codes), these two are client-only. */
  ai_offline: msg("You are offline — screenshot import needs a connection. Manual entry works without one."), // fetch never left the device — the normal state of an offline PWA
  ai_key_invalid: msg("OpenAI rejected your key — check it in Settings → Artificial intelligence."), // byok: OpenAI rejected the user's key (401/403)
  ai_model_unavailable: msg("This OpenAI key cannot use the selected model. Choose another model and try again."),
  credential_not_configured: msg("No OpenAI key is configured for this budget."),
  credential_move_required: msg("Re-enter your OpenAI API key so it can move into the encrypted budget."),
  credential_move_invalid: msg("The OpenAI key changed on another device. Refresh its status and try again."),
  vault_unavailable: msg("The server credential vault is not configured. Ask the server operator to enable it."),
  ai_capability_unsupported: msg("The selected AI provider does not support this feature."),

  /* better-auth codes (lib/auth.ts lowercases them): the library's own `message` is English
     prose, and the login screen is the FIRST thing a non-English user sees. */
  invalid_email_or_password: msg("Wrong email or password."),
  invalid_email: msg("That does not look like a valid email address."),
  user_already_exists: msg("An account with this email already exists — sign in instead."),
  password_too_short: msg("The password must be at least 8 characters."),
  password_too_long: msg("That password is too long."),
  signups_closed: msg("Registration is closed on this server."), // the server gate: this instance takes no new accounts
  sign_in_failed: msg("Could not sign in — please try again."), // generic fallback — an unmapped better-auth code
  sign_up_failed: msg("Could not create the account — please try again."),
  auth_meta_failed: msg("Could not sign in — please try again."), // /api/auth/meta unreachable → same user-facing advice
  device_storage_unavailable: msg("This browser blocked access to storage. Allow site storage before signing in."),
  local_sign_out_cleanup_failed: msg("Enveo could not remove the local copy. The server session has ended; retry the local cleanup before reloading the app."),
  server_sign_out_failed: msg("The server session could not be ended. You are still signed in — try again."),
  sign_out_in_progress: msg("Sign-out is already in progress."),
};

/** Turns a server error code into a sentence in the UI language; unknown codes stay as-is. */
function localizeError(code: string): string {
  const key = ERROR_KEYS[code];
  return key ? translate(uiLang(), key) : code;
}

/** Extracts the error from an API response ("503 {\"error\":\"ai_unavailable\"}" → a localized sentence). */
export function apiErrorMessage(e: unknown): string {
  const m = String((e as Error).message ?? e);
  const i = m.indexOf("{");
  if (i >= 0) {
    try {
      const parsed = JSON.parse(m.slice(i)) as { error?: string };
      if (parsed.error) return localizeError(parsed.error);
    } catch {
      /* ignore */
    }
  }
  return localizeError(m); // sentinels thrown client-side (foreign_replica); otherwise the raw text
}

export function apiErrorBody(e: unknown): { error?: string; tier?: "plain" | "e2ee"; epoch?: number; cipherVersion?: number; budgetId?: string } | null {
  const message = String((e as Error).message ?? e);
  const start = message.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(message.slice(start)) as { error?: string; tier?: "plain" | "e2ee"; epoch?: number; cipherVersion?: number; budgetId?: string };
  } catch {
    return null;
  }
}

/* ── Client ─────────────────────────────────────────────────────────── */
/** `timeoutMs` — only the slow AI recognition route sets it: an explicit cap that
 *  outwaits the server's own budget (see @enveo/shared/aiTransport), with the failure
 *  classified onto the same codes the AI transports use (ai_timeout / ai_offline /
 *  ai_unreachable). Without it the behavior is byte-identical to the old http(). */
export function http<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const request = () => httpImpl<T>(method, path, body, timeoutMs);
  return method === "GET" ? request() : runServerWriteOperation("direct-api-write", request);
}

async function httpImpl<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
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

/**
 * Domain writes NO LONGER go through REST — see `lib/mutate.ts` (local.*):
 * local mirror + outbox + background push. Only online-only operations
 * remain here: imports (AI) and their apply step.
 */
export const api = {
  accountPreferencesGet: getAccountPreferencesRemote,
  accountPreferencesPatch: patchAccountPreferencesRemote,

  /** Whether the server has an OpenAI key configured (the "server" mode available). */
  aiInfo: () => http<{ serverAi: boolean }>("GET", "/ai/info"),

  byokCredentialStatus: (budgetId: string) =>
    http<{ configured: boolean; available: boolean; reason?: "vault_unavailable" }>(
      "GET",
      `/ai/credentials/openai/status?budgetId=${encodeURIComponent(budgetId)}`,
    ),
  byokCredentialSave: (budgetId: string, key: string) => http<{ configured: true }>("PUT", "/ai/credentials/openai", { budgetId, key }),
  byokCredentialDelete: (budgetId: string) => http<{ configured: false }>("DELETE", "/ai/credentials/openai", { budgetId }),
  byokCredentialTest: (budgetId: string, model: OpenAiModel) =>
    http<{ ok: true; model: OpenAiModel }>("POST", "/ai/credentials/openai/test", { budgetId, model }),
  e2eeByokCredentialGet: (budgetId: string) => http<E2eeCredentialResponse>("GET", `/ai/credentials/openai/e2ee?budgetId=${encodeURIComponent(budgetId)}`),
  e2eeByokCredentialSave: (budgetId: string, expectedEpoch: number, ciphertext: string) =>
    http<E2eeCredentialResponse>("PUT", "/ai/credentials/openai/e2ee", { budgetId, expectedEpoch, ciphertext }),
  e2eeByokCredentialDelete: (budgetId: string, expectedEpoch: number) =>
    http<E2eeCredentialResponse>("DELETE", "/ai/credentials/openai/e2ee", { budgetId, expectedEpoch }),
  byokChat: (budgetId: string, model: OpenAiModel, request: ChatRequest) =>
    http<{ content: string }>(
      "POST",
      "/ai/byok/chat",
      { budgetId, model, messages: request.messages, responseFormat: request.responseFormat, reasoningEffort: request.reasoningEffort },
      AI_PROXY_CHAT_TIMEOUT_MS,
    ),
  byokImportExtract: (budgetId: string, model: OpenAiModel, accountId: string, images: string[], locale: AiLocale) =>
    http<ReconciledImportRecognitionResult>("POST", "/ai/byok/import/recognize", { budgetId, model, accountId, images, locale }, AI_IMPORT_EXTRACT_TIMEOUT_MS),

  /* `locale` = the UI language (any BCP-47 tag): the model writes its names, notes and
     rationales in it. Not to be confused with demoSeed's pl|en, which picks a SEED DATASET. */
  importExtract: (accountId: string, images: string[], locale: AiLocale) =>
    http<ReconciledImportRecognitionResult>("POST", "/import/recognize", { accountId, images, locale }, AI_IMPORT_EXTRACT_TIMEOUT_MS),
  /* `budgetId` = the same PER-REQUEST tenant assertion as the sync push: the batch creates
     FRESH transactions in whatever budget the session cookie resolves to, and the cookie can
     be swapped in another tab while the import sheet is open. The caller passes the replica's
     budgetId (after assertOwnReplica); the server refuses a mismatch (409 budget_mismatch,
     nothing written). */
  importApply: (b: { accountId: string; budgetId?: string; items: ImportApplyItem[]; dryRun?: boolean }) =>
    http<ImportApplyResponse>("POST", "/import/apply", b),

  importJobs: {
    create: (input: { id: string; budgetId: string; accountId: string; locale: AiLocale; images: string[] }) =>
      import("./importJobs/api").then(({ importJobsApi }) => importJobsApi.create(input)),
    list: () => import("./importJobs/api").then(({ importJobsApi }) => importJobsApi.list()),
    get: (id: string) => import("./importJobs/api").then(({ importJobsApi }) => importJobsApi.get(id)),
    cancel: (id: string, budgetId: string) => import("./importJobs/api").then(({ importJobsApi }) => importJobsApi.cancel(id, budgetId)),
    retry: (id: string, budgetId: string) => import("./importJobs/api").then(({ importJobsApi }) => importJobsApi.retry(id, budgetId)),
    removeMany: (ids: string[], budgetId: string) => import("./importJobs/api").then(({ importJobsApi }) => importJobsApi.removeMany(ids, budgetId)),
    complete: (id: string, input: { budgetId: string; appliedCount: number; skippedCount: number }) =>
      import("./importJobs/api").then(({ importJobsApi }) => importJobsApi.complete(id, input)),
  },

  budgetSuggest: (b: { month: string; profile: BudgetSuggestProfile; customPrompt?: string; ledger?: ClientLedger; locale: AiLocale; useAi?: boolean }) =>
    http<BudgetSuggestResponse>("POST", "/budget/suggest", b),

  /* `userId` = the same PER-REQUEST owner assertion as the E2EE routes below: both write the
     session user's budget wholesale, so the caller passes the id assertOwnReplica verified. */
  demoSeed: (locale: "pl" | "en", userId: string) => http<{ seeded: boolean }>("POST", "/demo/seed", { locale, userId }),
  budgetReset: (userId: string) => http<{ reset: boolean }>("POST", "/budget/reset", { confirm: "RESET", userId }),

  /* E2EE (sync v2) — tier switching and the key envelope; crypto EXCLUSIVELY on
     the client side (lib/crypto.ts) — only ciphertexts travel here.
     `userId` = the PER-REQUEST owner assertion: both routes OVERWRITE the session user's whole
     budget, and the caller's ownership check (assertOwnReplica) is a different request than this
     one — the shared cookie can be swapped in between. The server refuses a body whose userId is
     not the session it resolves (409 budget_mismatch, nothing written). */
  /* `budgetId` + `nextEpoch` since ciphertext v2: the wrapped DEK and the snapshot are BOUND to
     (budgetId, nextEpoch) by their authenticated context, so the client must name the epoch it
     encrypted for — the server refuses a stale expectation (409 with the current meta). */
  e2eeEnable: (b: {
    wrappedDek: string;
    kdfParams: string;
    snapshotBlob: string;
    userId: string;
    budgetId: string;
    nextEpoch: number;
    credentialAction: { kind: "none" } | { kind: "server-vault-to-e2ee"; ciphertext: string };
  }) => runServerWriteOperation("e2ee-enable", () => http<{ epoch: number }>("POST", "/budget/e2ee/enable", b)),
  e2eeDisable: (b: {
    confirm: string;
    ledger: ClientLedger;
    userId: string;
    budgetId: string;
    expectedEpoch: number;
    credentialAction: { kind: "none" } | { kind: "e2ee-to-server-vault"; key: string };
  }) => runServerWriteOperation("e2ee-disable", () => http<{ epoch: number }>("POST", "/budget/e2ee/disable", b)),
  /* `expectedEpoch` = the epoch the new envelope's AAD was built for: a rekey landing on any
     OTHER generation would permanently brick every unlock (the v2 wrap hard-fails under a
     different epoch), so the server refuses a stale expectation before writing. */
  e2eeRekey: (b: { wrappedDek: string; kdfParams: string; userId: string; expectedEpoch: number }) =>
    runServerWriteOperation("e2ee-rekey", () => http<{ epoch: number }>("POST", "/sync2/rekey", b)),
  /** GET /sync2/snapshot — the session's budgetId + key envelope (password verification on change) + checkpoint. */
  e2eeSnapshot: () =>
    http<{
      budgetId: string;
      epoch: number;
      cipherVersion?: number;
      wrappedDek: string | null;
      kdfParams: string | null;
      uptoSeq: number;
      blob: string | null;
    }>("GET", "/sync2/snapshot"),
};

/* ── Hooks ──────────────────────────────────────────────────────────── */

/** Mirror version — a LedgerStore subscription for hooks that compute locally. */
export function useLedgerVersion(): number {
  return useSyncExternalStore(store.subscribe, store.getVersion);
}

/**
 * Sync engine status for the UI (SyncBadge, the "Synchronization" section). A stable
 * snapshot between changes — safe for useSyncExternalStore (no render
 * loops). Refreshes on every state / outbox queue change.
 */
export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(subscribeSyncStatus, getSyncStatus);
}

/**
 * Month state — COMPUTED LOCALLY from the replica (computeStateResponse, the same
 * code as the server). The {data,isLoading,isError} contract unchanged:
 * - isLoading: hydrate/bootstrap in progress (no local data yet),
 * - isError: first start with no local data and the snapshot failed.
 * Month navigation = pure recomputation, zero network.
 */
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
