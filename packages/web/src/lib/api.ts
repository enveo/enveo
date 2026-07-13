import { computeStateResponse, type StateResponse } from "@enveo/shared";
import { useMemo, useSyncExternalStore } from "react";
import { translate, uiLang, type TKey } from "./i18n";
import { store } from "./store";
import { getSyncStatus, subscribeSyncStatus, type SyncStatus } from "./sync";

 
export type { AccountView, EnvelopeView, StateResponse } from "@enveo/shared";
import type { BudgetSuggestProfile, BudgetSuggestResponse, ClientLedger } from "@enveo/shared";
export type { BudgetSuggestProfile, BudgetSuggestResponse } from "@enveo/shared";

export interface QuickAddResponse {
  amount: number | null;
  type: "expense" | "income";
  isRefund: boolean;
  date: string;
  envelopeId: string | null;
  envelopeName: string | null;
  placeId: string | null;
  placeName: string | null;
  categoryId: string | null;
  note: string | null;
  confidence: number;
}

 
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
  confirmed: boolean;
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
const ERROR_KEYS: Record<string, TKey> = {
  ai_unavailable: "err.aiUnavailable",  
  ai_upstream_error: "err.aiUpstream",  
  upstream: "err.aiUpstream",  
  backup_invalid: "err.backupInvalid", // /sync/replace — the payload is not a ledger
  foreign_ref: "err.foreignRef",  
  budget_mismatch: "err.budgetMismatch",  
  budget_not_empty: "err.budgetNotEmpty",  
  too_large: "err.tooLarge",  
  internal: "err.internal",
  foreign_replica: "sync.notOwner",  
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

 
async function http<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${res.status} ${txt}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}






export const api = {
   
  aiInfo: () => http<{ serverAi: boolean }>("GET", "/ai/info"),

  quickAdd: (text: string, locale: "pl" | "en") => http<QuickAddResponse>("POST", "/quick-add", { text, locale }),

  importExtract: (images: string[], locale: "pl" | "en") => http<{ items: ImportItem[] }>("POST", "/import/extract", { images, locale }),
  importApply: (b: { accountId: string; items: ImportApplyItem[]; dryRun?: boolean }) =>
    http<ImportApplyResponse>("POST", "/import/apply", b),

  budgetSuggest: (b: { month: string; profile: BudgetSuggestProfile; customPrompt?: string; ledger?: ClientLedger; locale: "pl" | "en"; useAi?: boolean }) =>
    http<BudgetSuggestResponse>("POST", "/budget/suggest", b),

  demoSeed: (locale: "pl" | "en") => http<{ seeded: boolean }>("POST", "/demo/seed", { locale }),
  budgetReset: () => http<{ reset: boolean }>("POST", "/budget/reset", { confirm: "RESET" }),

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
