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
const REGULAR: readonly ScreenId[] = ["budget", "transactions", "accounts", "reports", "settings"];
const TABS: readonly ReportTab[] = ["assets", "cashflow", "spending", "budgets", "goals", "month", "trends"];

export function routeToUrl(r: Route): string {
  const slug = ({ start: "", addExpense: "add" } as Partial<Record<ScreenId, string>>)[r.screen] ?? r.screen;
  const path = r.screen === "reports" && r.reportsView !== "overview" ? `/reports/${r.reportsView}` : `/${slug}`;
  return r.envelopeId ? `${path}?env=${encodeURIComponent(r.envelopeId)}` : path;
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
