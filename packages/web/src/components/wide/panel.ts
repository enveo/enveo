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
 * App, since nothing outside the wide shell needs it); PR6 adds `txn`/`acct`/`add`/the form
 * sheets. Every `switch` a caller writes over `.kind` must stay EXHAUSTIVE (a `never` check) so a
 * future kind is a compile error at every consumer, not a silently-unhandled case.
 */
export type PanelView =
  | { kind: "empty"; hint: "envelope" | "report" | "generic" }
  | { kind: "envelope"; envelopeId: string; month: string }
  | { kind: "report"; view: ReportTab }
  | { kind: "widgets"; widgetId: WideWidgetId };

/**
 * An open envelope wins on ANY screen — it is push-nav, like the phone's full-screen summary
 * (an envelope opened from Reports still shows the envelope). Reports without a selected
 * subview, and every other screen, get the `empty` variant with a per-screen hint rather than a
 * forced selection (mockup inconsistencies 1 and 2 — a real boot has no preseeded selection and
 * the demo never draws an empty panel; both readings are pinned by the tests below).
 *
 * `widgetSettings` only ever resolves to the `widgets` kind on the `start` screen — `WideShell`
 * clears its local state whenever `screen` changes away from `start`, but this function stays
 * total and defensive about that discipline rather than trusting it (a stale non-null value on
 * any other screen is simply ignored here, never surfaced).
 */
export function resolvePanel(a: {
  screen: ScreenId;
  reportsView: ReportView;
  envView: { envelopeId: string; month: string } | null;
  widgetSettings?: WideWidgetId | null;
}): PanelView {
  if (a.envView) return { kind: "envelope", envelopeId: a.envView.envelopeId, month: a.envView.month };
  if (a.screen === "reports") return a.reportsView === "overview" ? { kind: "empty", hint: "report" } : { kind: "report", view: a.reportsView };
  if (a.screen === "start" && a.widgetSettings) return { kind: "widgets", widgetId: a.widgetSettings };
  if (a.screen === "start" || a.screen === "budget") return { kind: "empty", hint: "envelope" };
  return { kind: "empty", hint: "generic" }; // transactions/accounts/settings/addExpense until PR6's <Surface>
}
