import type { Account, Envelope, EnvelopeGroup, WideWidgetId } from "@enveo/shared";
import type { ReportTab, ReportView } from "../../screens/reports/types";
import type { ScreenId } from "../chrome";

/**
 * The wide shell's right panel — WHAT it shows, derived entirely from existing App state
 * (`screen`/`reportsView`/`envView`/`widgetSettings`). This is the demo's `autoPane`/`paneNow`
 * (v3 lines 2422–2425) collapsed into one pure, total function; there is no separate `pane` axis
 * that could disagree with the real navigation state (pr4-context.md §0, "Translation, not port").
 *
 * `panelClosed` (open vs. closed) is a SEPARATE bit and deliberately NOT a parameter here — it
 * is chrome, not navigation (pr4-context.md §12.2), and survives every call to this function
 * unchanged. PR4 ships three kinds (`empty | envelope | report`); PR5 adds `widgets` (the wide
 * Home board's gear target — `widgetSettings` is `WideShell`'s own local selection, not lifted to
 * App, since nothing outside the wide shell needs it); PR6 Task 1 adds `add` (the Add/edit-
 * transaction takeover pane — see below); PR6b Task 3 adds `account` (the v3 `acct` pane — see
 * below); design parity wave C task 3 adds `txn` (the v3 `txn` pane, transactions' own read-only
 * detail card — see below); per-surface popovers remain the one open item, per the epic's
 * reconciliation. Every `switch` a caller writes over `.kind` must stay EXHAUSTIVE (a `never`
 * check) so a future kind is a compile error at every consumer, not a silently-unhandled case.
 *
 * Design parity Wave A Task 1 (owner rule 1, `waveA-t1-brief.md`): the panel is NEVER EMPTY when
 * data exists to show — `envelope`/`report`/`account`/`txn` each gain a `source: "selection" |
 * "fallback"` tag distinguishing "the user actually picked this" from "resolvePanel picked this
 * for you because nothing was picked yet" (the demo's own `envById[st.selEnv] || ENVS[3]` /
 * `acctById[st.selAcct] || ACCTS[0]` / `st.txns.filter(t=>t.id===st.selTxn)[0] || st.txns[0]`
 * defaults, v3:2622/2827/2846). The `empty` kind now survives ONLY for a genuinely empty dataset
 * (no non-archived envelopes/accounts, or no transaction the CURRENT month/search/filter admits,
 * to fall back to) — settings falls through to `account` below, never here. `source` is what
 * `WideShell`'s `closePanel` reads to decide "clear the selection" (pops to the fallback
 * underneath — a no-op-looking but real UX distinction) vs. "collapse the panel" (clearing a
 * fallback that was never a real selection would be a no-op loop).
 */
export type PanelView =
  | { kind: "empty"; hint: "envelope" | "report" | "account" | "generic" }
  | { kind: "envelope"; envelopeId: string; month: string; source: "selection" | "fallback" }
  | { kind: "report"; view: ReportTab; source: "selection" | "fallback" }
  | { kind: "widgets"; widgetId: WideWidgetId }
  | { kind: "account"; accountId: string; source: "selection" | "fallback" } // PR6b — the v3 `acct` pane
  | { kind: "add" }
  | { kind: "txn"; txnId: string; source: "selection" | "fallback" }; // wave C task 3 — the v3 `txn` pane

/**
 * The panel's contextual "first item" per screen (Task 1) — the REAL app's translation of the
 * demo's static `ENVS[3]`/`ACCTS[0]`/`txns[0]` fallbacks into this app's actual display order:
 * group-major then envelope `sort` for envelopes (mirrors Budget's own visual order — see
 * `FillGoalsSheet.tsx`'s identical `groupSortById` resolution), plain `sort` for accounts.
 * Archived envelopes/accounts are never a fallback target (an archived item cannot be the "first"
 * thing a fresh visit shows). `firstTxnId` takes an already-FILTERED transaction list as input
 * (App owns `txQuery`/`txFilters` — this function does no filtering of its own, per Transactions's
 * own query/filter pipeline) rather than computing it. Its real caller (wave C task 3) is
 * `WideShell`, not App: `App.tsx`'s own eager call to this function (feeding the OTHER two fields,
 * and the phone Drawer/Budget-row-highlight consumers that need them) deliberately keeps passing
 * the RAW, unfiltered `state.transactions` — wiring the real `matchesTransactionQuery`/
 * `matchesTransactionFilters` pipeline into that eager module for a field only the lazy panel
 * needs would spend eager-bundle bytes for nothing (App.tsx's own comment has the measured
 * reasoning). `WideShell` (already inside the lazy wide chunk, already importing that pipeline for
 * the band's "{n} shown" caption) calls this function a second time with the properly filtered
 * list before handing the result to `resolvePanel` below.
 */
export interface PanelFallbacks {
  firstEnvelopeId: string | null;
  firstAccountId: string | null;
  firstTxnId: string | null;
  month: string;
}

export function panelFallbacks(
  state: {
    envelopes: ReadonlyArray<Pick<Envelope, "id" | "groupId" | "sort" | "archived">>;
    groups: ReadonlyArray<Pick<EnvelopeGroup, "id" | "sort">>;
    accounts: ReadonlyArray<Pick<Account, "id" | "sort" | "archived">>;
  },
  month: string,
  filteredTxns: ReadonlyArray<{ id: string }>,
): PanelFallbacks {
  const groupSortById = new Map(state.groups.map((g) => [g.id, g.sort]));
  const firstEnvelope = state.envelopes
    .filter((e) => !e.archived)
    .sort(
      (a, b) => (groupSortById.get(a.groupId) ?? Number.MAX_SAFE_INTEGER) - (groupSortById.get(b.groupId) ?? Number.MAX_SAFE_INTEGER) || a.sort - b.sort,
    )[0];
  const firstAccount = state.accounts.filter((a) => !a.archived).sort((a, b) => a.sort - b.sort)[0];
  return {
    firstEnvelopeId: firstEnvelope?.id ?? null,
    firstAccountId: firstAccount?.id ?? null,
    firstTxnId: filteredTxns[0]?.id ?? null,
    month,
  };
}

/**
 * `add` wins over EVERY other input, including an open envelope or report subview — push
 * semantics, matching the demo's `addFrom` behaviour (PR6 plan D2): opening Add over an open
 * envelope pane does not clear `envView`, so closing Add restores the envelope pane
 * derivationally, for free. Checked FIRST for exactly that reason.
 *
 * An open envelope wins on any OTHER screen — it is push-nav, like the phone's full-screen
 * summary (an envelope opened from Reports still shows the envelope). Reports without a selected
 * subview, Start/Budget without an open envelope, Accounts/Settings without a selected account,
 * and — as of design parity wave C task 3 — Transactions without a selected transaction, all fall
 * back to `fb` (Task 1, owner rule 1) instead of the old `empty` placeholder — real content,
 * tagged `source: "fallback"`, per this file's own `PanelFallbacks` doc above. `empty` now
 * survives ONLY when the fallback itself has nothing to offer (an empty envelope/account dataset,
 * or no transaction the current month/search/filter admits) — every screen now has SOME fallback
 * axis, so there is no longer a screen that bottoms out at `empty` merely for owning none.
 *
 * `widgetSettings` only ever resolves to the `widgets` kind on the `start` screen — `WideShell`
 * clears its local state whenever `screen` changes away from `start`, but this function stays
 * total and defensive about that discipline rather than trusting it (a stale non-null value on
 * any other screen is simply ignored here, never surfaced). `txnView` (wave C task 3) is the same
 * discipline, scoped to `transactions` only — a stale value on any other screen is ignored here
 * too (`WideShell`'s bag-field comment has the full reset story: unlike `acctView` below, App
 * never clears `txnView` on plain navigation at all — its only reset path is a vanish effect this
 * function has no part in).
 *
 * `acctView` (PR6b Task 3) used to follow that SAME screen-scoped discipline — but owner round 3
 * item 20 retires it: the rail's own account row no longer navigates at all (App.tsx's
 * `selectRailAccount` sets `acctView` and clears `envView`, nothing else), so the pane must follow
 * that selection on WHATEVER screen the user already is — the exact push-nav precedent `envView`
 * above already set (an envelope opened from Reports still shows the envelope). Checked right
 * after `envView` for the same reason envView is checked before `reports`/`widgetSettings`/`txn`
 * below: the most recently made explicit selection wins. In practice at most one of
 * `envView`/`acctView` is ever non-null at a time (every setter that establishes one clears the
 * other — App.tsx), so this ordering is a tie-break for a caller that violated that discipline,
 * not a real everyday branch. `AccountsScreen`'s own rows and Settings (owner rule 5) still reach
 * this exact same rung — nothing distinguishes "the rail picked this" from "the Accounts list
 * picked this" once `acctView` is set, which is correct: both are real user selections.
 */
export function resolvePanel(
  a: {
    screen: ScreenId;
    reportsView: ReportView;
    envView: { envelopeId: string; month: string } | null;
    widgetSettings?: WideWidgetId | null;
    acctView?: { accountId: string } | null;
    txnView?: { txnId: string } | null;
  },
  fb: PanelFallbacks,
): PanelView {
  if (a.screen === "addExpense") return { kind: "add" };
  if (a.envView) return { kind: "envelope", envelopeId: a.envView.envelopeId, month: a.envView.month, source: "selection" };
  // Owner round 3 item 20: an explicit account pick wins on ANY screen now — see this function's
  // own doc comment above for why this moved up from the accounts/settings-only rung it used to be.
  if (a.acctView) return { kind: "account", accountId: a.acctView.accountId, source: "selection" };
  if (a.screen === "reports") {
    if (a.reportsView !== "overview") return { kind: "report", view: a.reportsView, source: "selection" };
    return { kind: "report", view: "spending", source: "fallback" }; // v3:2213's own `selReport` default
  }
  if (a.screen === "start" && a.widgetSettings) return { kind: "widgets", widgetId: a.widgetSettings };
  if (a.screen === "accounts" || a.screen === "settings") {
    return fb.firstAccountId ? { kind: "account", accountId: fb.firstAccountId, source: "fallback" } : { kind: "empty", hint: "account" };
  }
  if (a.screen === "start" || a.screen === "budget") {
    return fb.firstEnvelopeId ? { kind: "envelope", envelopeId: fb.firstEnvelopeId, month: fb.month, source: "fallback" } : { kind: "empty", hint: "envelope" };
  }
  if (a.screen === "transactions") {
    if (a.txnView) return { kind: "txn", txnId: a.txnView.txnId, source: "selection" };
    return fb.firstTxnId ? { kind: "txn", txnId: fb.firstTxnId, source: "fallback" } : { kind: "empty", hint: "generic" };
  }
  return { kind: "empty", hint: "generic" }; // defensive: every real ScreenId is handled above
}

/**
 * The wide shell's primary pane never shows the Add takeover (it lives in the panel instead, per
 * `resolvePanel` above) — it keeps rendering the screen Add returns to, so the primary pane never
 * flashes/unmounts to the Add screen and back. `editReturn` is App's own state (the screen an
 * edit-in-progress returns to); this is a pure lookup, not a second copy of that state.
 */
export function primaryScreenFor(screen: ScreenId, editReturn: ScreenId): ScreenId {
  return screen === "addExpense" ? editReturn : screen;
}
