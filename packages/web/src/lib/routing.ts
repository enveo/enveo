import type { ScreenId } from "../components/chrome";
import type { ReportTab, ReportView } from "../screens/reports/types";

/**
 * A pure, serialisable slice of navigation state: which screen, which report subview
 * (only meaningful when screen === "reports"), and which envelope's summary is open
 * (via `?env=`). The viewed month and transaction filters are session state and are
 * NOT part of this — they are never in the URL. `panelClosed` is chrome, not a place,
 * and is also never part of this (see pr4-context.md §12.2).
 */
export type Route = { screen: ScreenId; reportsView: ReportView; envelopeId: string | null };

// Most screens are their own slug; only these two are irregular (bundle-budget shrink,
// pr4-context.md §11 — one small exceptions table beats two full hand-written ones).
const REGULAR: readonly ScreenId[] = ["budget", "transactions", "accounts", "reports", "activity", "settings"];
const TABS: readonly ReportTab[] = ["assets", "cashflow", "spending", "budgets", "goals", "month", "trends"];

export function routeToUrl(r: Route): string {
  const slug = ({ start: "", addExpense: "add" } as Partial<Record<ScreenId, string>>)[r.screen] ?? r.screen;
  const path = r.screen === "reports" && r.reportsView !== "overview" ? `/reports/${r.reportsView}` : `/${slug}`;
  // The Add pane's URL is the CONSTANT "/add" — `?env` is never serialised while it is open.
  // `doneEdit`'s history.back() contract ("the entry below /add is the screen the edit came
  // from", App.tsx) holds only if two consecutive /add entries can never exist — but `envView`
  // CAN change while the Add pane is open (clicking an envelope row in the wide primary; the
  // change is INVISIBLE because the add kind outranks envelope in resolvePanel), and serialising
  // it pushed a second /add entry: submitting then history.back()'d onto the sibling /add,
  // popstate's nav("addExpense") left the mounted AddScreen (and its filled form) untouched, and
  // the still-enabled submit button wrote a DUPLICATE transaction on the next click (reproduced
  // live, 2026-08-24). Keeping the URL constant makes that push a "none" — the class dies at the
  // source. A deep /add reload landing on a fresh Add with no envelope pane behind it is the
  // already-accepted behaviour (reconciliation ruling: "/add reload lands on a fresh Add").
  return r.envelopeId && r.screen !== "addExpense" ? `${path}?env=${encodeURIComponent(r.envelopeId)}` : path;
}

/**
 * Which single History call App's URL-sync pass makes (App.tsx keeps the calls, this keeps the
 * DECISION pure so the entry-0 contract stays unit-tested):
 * - "stamp" — routing just became active and entry 0 has never been marked (`history.state` is
 *   null): mark it `replaceState(false)` at the CURRENT url, without growing the stack. Stamping
 *   at ACTIVATION rather than at the first change is the whole point — the first in-session
 *   navigation then PUSHES, so hardware/browser back from the first destination returns to the
 *   start URL instead of leaving the app (the old code's first change hit `history.state == null`
 *   and rewrote entry 0's URL to the DESTINATION).
 * - "replace" — a popstate correction, or a URL change while entry 0 is still unstamped (a
 *   deep-load canonicalisation, e.g. a stale `?env` dropped on boot): fix the entry in place.
 * - "push" — every other change is a real new entry.
 */
export function historyAction(urlChanged: boolean, entryStamped: boolean, justPopped: boolean): "push" | "replace" | "stamp" | "none" {
  if (!urlChanged) return entryStamped ? "none" : "stamp";
  return justPopped || !entryStamped ? "replace" : "push";
}

export function parseUrl(pathname: string, search: string): Route {
  const [seg1 = "", seg2 = ""] = pathname.split("/").filter(Boolean);
  const screen: ScreenId = seg1 === "add" ? "addExpense" : (REGULAR as readonly string[]).includes(seg1) ? (seg1 as ScreenId) : "start";
  const tab = (TABS as readonly string[]).includes(seg2) ? (seg2 as ReportTab) : undefined;
  const env = new URLSearchParams(search).get("env");
  return {
    screen,
    reportsView: screen === "reports" && tab ? tab : "overview",
    // Length check, not a full UUID regex (bundle-budget shrink, pr4-context.md §11): a
    // wrong-shape 36-char string is harmless here — App.tsx's post-load effect drops any
    // envelopeId absent from `state.envelopes` before it reaches a lookup.
    envelopeId: env?.length === 36 ? env : null,
  };
}
