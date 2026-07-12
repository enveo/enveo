import { computeStateResponse, type StateResponse } from "@enveo/shared";
import { useMemo, useSyncExternalStore } from "react";
import { store } from "./store";
import { getSyncStatus, subscribeSyncStatus, type SyncStatus } from "./sync";

/* ── API response shapes — @enveo/shared is the source of truth ──── */
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

/* Screenshot import (OpenAI, 2 cycles: facts → assignments from history) */
export interface ImportItem {
  date: string;
  amount: number;
  /** transfer/isRefund/toAccountId: proposals LEARNED from confident history
   *  (source_ref) — the server proposes the type deterministically (2026-07-12). */
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
/** Import item corrections from the editor (AddScreen in draft mode) — spec §3.
 *  Fields go to /import/apply merged with the original; rawPlace/source_ref
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
  confirmed: boolean;
}
/** An item sent to /import/apply: the extraction original + OPTIONAL corrections
 *  from the editor (merged in ImportSheet). rawPlace always from the original. */
export type ImportApplyItem = Omit<ImportItem, "type"> & Partial<EditedImportItem> & { type: "expense" | "income" | "transfer"; force?: boolean };
export interface ImportApplyResponse {
  added: number;
  skipped: number;
  dryRun: boolean;
  results: Array<ImportItem & { status: "added" | "exists" | "probable" }>;
}

/** Extracts the error message from an API response ("503 {\"error\":\"…\"}" → "…"). */
export function apiErrorMessage(e: unknown): string {
  const m = String((e as Error).message ?? e);
  const i = m.indexOf("{");
  if (i >= 0) {
    try {
      const parsed = JSON.parse(m.slice(i)) as { error?: string };
      if (parsed.error) return parsed.error;
    } catch {
      /* ignore */
    }
  }
  return m;
}

/* ── Client ─────────────────────────────────────────────────────────── */
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

/**
 * Domain writes NO LONGER go through REST — see `lib/mutate.ts` (local.*):
 * local mirror + outbox + background push. Only online-only operations
 * remain here: quick-add (AI) and imports.
 */
export const api = {
  /** Whether the server has an OpenAI key configured (the "server" mode available). */
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
     the client side (lib/crypto.ts) — only ciphertexts travel here. */
  e2eeEnable: (b: { wrappedDek: string; kdfParams: string; snapshotBlob: string }) =>
    http<{ epoch: number }>("POST", "/budget/e2ee/enable", b),
  e2eeDisable: (b: { confirm: string; ledger: ClientLedger }) =>
    http<{ epoch: number }>("POST", "/budget/e2ee/disable", b),
  e2eeRekey: (b: { wrappedDek: string; kdfParams: string }) => http<{ epoch: number }>("POST", "/sync2/rekey", b),
  /** GET /sync2/snapshot — the session's budgetId + key envelope (password verification on change) + checkpoint. */
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
