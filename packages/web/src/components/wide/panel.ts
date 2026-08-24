import type { WideWidgetId } from "@enveo/shared";
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
 * below); the `txn` pane and per-surface popovers remain open items, per the epic's
 * reconciliation. Every `switch` a caller writes over `.kind` must stay EXHAUSTIVE (a `never`
 * check) so a future kind is a compile error at every consumer, not a silently-unhandled case.
 */
export type PanelView =
  | { kind: "empty"; hint: "envelope" | "report" | "account" | "generic" }
  | { kind: "envelope"; envelopeId: string; month: string }
  | { kind: "report"; view: ReportTab }
  | { kind: "widgets"; widgetId: WideWidgetId }
  | { kind: "account"; accountId: string } // PR6b — the v3 `acct` pane
  | { kind: "add" };

/**
 * `add` wins over EVERY other input, including an open envelope or report subview — push
 * semantics, matching the demo's `addFrom` behaviour (PR6 plan D2): opening Add over an open
 * envelope pane does not clear `envView`, so closing Add restores the envelope pane
 * derivationally, for free. Checked FIRST for exactly that reason.
 *
 * An open envelope wins on any OTHER screen — it is push-nav, like the phone's full-screen
 * summary (an envelope opened from Reports still shows the envelope). Reports without a selected
 * subview, and every other screen, get the `empty` variant with a per-screen hint rather than a
 * forced selection (mockup inconsistencies 1 and 2 — a real boot has no preseeded selection and
 * the demo never draws an empty panel; both readings are pinned by the tests below).
 *
 * `widgetSettings` only ever resolves to the `widgets` kind on the `start` screen — `WideShell`
 * clears its local state whenever `screen` changes away from `start`, but this function stays
 * total and defensive about that discipline rather than trusting it (a stale non-null value on
 * any other screen is simply ignored here, never surfaced). `acctView` (PR6b Task 3) is the same
 * discipline for the `accounts` screen — App owns it (D2: no phone-parity route exists for it,
 * unlike `envView`), and a stale value elsewhere is likewise ignored here.
 */
export function resolvePanel(a: {
  screen: ScreenId;
  reportsView: ReportView;
  envView: { envelopeId: string; month: string } | null;
  widgetSettings?: WideWidgetId | null;
  acctView?: { accountId: string } | null;
}): PanelView {
  if (a.screen === "addExpense") return { kind: "add" };
  if (a.envView) return { kind: "envelope", envelopeId: a.envView.envelopeId, month: a.envView.month };
  if (a.screen === "reports") return a.reportsView === "overview" ? { kind: "empty", hint: "report" } : { kind: "report", view: a.reportsView };
  if (a.screen === "start" && a.widgetSettings) return { kind: "widgets", widgetId: a.widgetSettings };
  if (a.screen === "accounts" && a.acctView) return { kind: "account", accountId: a.acctView.accountId };
  if (a.screen === "accounts") return { kind: "empty", hint: "account" };
  if (a.screen === "start" || a.screen === "budget") return { kind: "empty", hint: "envelope" };
  return { kind: "empty", hint: "generic" }; // transactions/settings — no panel selection of their own (their sheets ride <Surface>, not this resolver)
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
