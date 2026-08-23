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

const SLUGS: ReadonlyArray<readonly [ScreenId, string]> = [
  ["start", ""],
  ["budget", "budget"],
  ["transactions", "transactions"],
  ["accounts", "accounts"],
  ["reports", "reports"],
  ["settings", "settings"],
  ["addExpense", "add"],
];

const TABS: readonly ReportTab[] = ["assets", "cashflow", "spending", "budgets", "goals", "month", "trends"];

const ENVELOPE_ID_RE = /^[0-9a-f-]{36}$/i;

export function routeToUrl(r: Route): string {
  const slug = SLUGS.find(([s]) => s === r.screen)?.[1] ?? "";
  const path = r.screen === "reports" && r.reportsView !== "overview" ? `/reports/${r.reportsView}` : `/${slug}`;
  return r.envelopeId ? `${path}?env=${encodeURIComponent(r.envelopeId)}` : path;
}

export function parseUrl(pathname: string, search: string): Route {
  const [seg1 = "", seg2 = ""] = pathname.replace(/^\/+|\/+$/g, "").split("/");
  const screen = SLUGS.find(([, slug]) => slug === seg1)?.[0] ?? "start";
  const tab = TABS.find((t) => t === seg2);
  const env = new URLSearchParams(search).get("env");
  return {
    screen,
    reportsView: screen === "reports" && tab ? tab : "overview",
    envelopeId: env && ENVELOPE_ID_RE.test(env) ? env : null,
  };
}
