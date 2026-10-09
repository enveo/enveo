import type { ExploreStep } from "@enveo/shared";
import type { ScreenId } from "../components/chrome";
import { decodePath, encodePath } from "../screens/reports/spendingPath";
import type { ReportTab, ReportView } from "../screens/reports/types";

/** `spendPath`: the Spending report's drill-down, one history entry per level. */
export type Route = { screen: ScreenId; reportsView: ReportView; envelopeId: string | null; spendPath?: readonly ExploreStep[] };

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
  const q = new URLSearchParams();
  if (r.envelopeId && r.screen !== "addExpense") q.set("env", r.envelopeId);
  if (r.screen === "reports" && r.reportsView === "spending" && r.spendPath?.length) q.set("p", encodePath(r.spendPath));
  const qs = q.toString().replaceAll("%7E", "~");
  return qs ? `${path}?${qs}` : path;
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
  const q = new URLSearchParams(search);
  const env = q.get("env");
  const reportsView = screen === "reports" && tab ? tab : "overview";
  const spendPath = reportsView === "spending" ? decodePath(q.get("p")) : [];
  return {
    screen,
    reportsView,

    envelopeId: env?.length === 36 ? env : null,
    ...(spendPath.length ? { spendPath } : {}),
  };
}
