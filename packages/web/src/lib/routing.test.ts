import { describe, expect, test } from "bun:test";
import type { ScreenId } from "../components/chrome";
import type { ReportView } from "../screens/reports/types";
import { historyAction, parseUrl, type Route, routeToUrl } from "./routing";

const SCREENS: readonly ScreenId[] = ["start", "budget", "transactions", "accounts", "reports", "settings", "addExpense"];
const REPORT_VIEWS: readonly ReportView[] = ["overview", "assets", "cashflow", "spending", "budgets", "goals", "month", "trends"];
const ENV_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

function parse(url: string): Route {
  const [pathname, search = ""] = url.split("?");
  return parseUrl(pathname ?? "", search ? `?${search}` : "");
}

describe("routeToUrl / parseUrl round-trip", () => {
  for (const screen of SCREENS) {
    for (const reportsView of REPORT_VIEWS) {
      // reportsView is only meaningful for the reports screen; every other screen normalises
      // it away on parse, so only assert the round-trip where it can actually survive.
      if (screen !== "reports" && reportsView !== "overview") continue;
      for (const envelopeId of [null, ENV_ID]) {
        const route: Route = { screen, reportsView, envelopeId };
        test(`${screen} / ${reportsView} / env=${envelopeId ?? "none"}`, () => {
          expect(parse(routeToUrl(route))).toEqual(route);
        });
      }
    }
  }
});

describe("routeToUrl", () => {
  test("start with no envelope is the bare root", () => {
    expect(routeToUrl({ screen: "start", reportsView: "overview", envelopeId: null })).toBe("/");
  });

  test("reports overview has no subpath", () => {
    expect(routeToUrl({ screen: "reports", reportsView: "overview", envelopeId: null })).toBe("/reports");
  });

  test("reports with a tab appends the subpath", () => {
    expect(routeToUrl({ screen: "reports", reportsView: "assets", envelopeId: null })).toBe("/reports/assets");
  });

  test("addExpense maps to the /add slug", () => {
    expect(routeToUrl({ screen: "addExpense", reportsView: "overview", envelopeId: null })).toBe("/add");
  });

  test("a non-reports screen never gets a reports subpath even if reportsView is set", () => {
    // routeToUrl only special-cases screen === "reports"; every other screen ignores reportsView.
    expect(routeToUrl({ screen: "budget", reportsView: "assets", envelopeId: null })).toBe("/budget");
  });

  test("envelopeId appends ?env=, URL-encoded", () => {
    expect(routeToUrl({ screen: "budget", reportsView: "overview", envelopeId: ENV_ID })).toBe(`/budget?env=${ENV_ID}`);
  });

  test("envelopeId on the bare root still gets a leading path", () => {
    expect(routeToUrl({ screen: "start", reportsView: "overview", envelopeId: ENV_ID })).toBe(`/?env=${ENV_ID}`);
  });
});

describe("parseUrl", () => {
  test("unknown path falls back to start", () => {
    expect(parseUrl("/nonsense", "")).toEqual({ screen: "start", reportsView: "overview", envelopeId: null });
  });

  test("/reports/nonsense falls back to the reports hub, not start", () => {
    expect(parseUrl("/reports/nonsense", "")).toEqual({ screen: "reports", reportsView: "overview", envelopeId: null });
  });

  test("trailing slash is tolerated", () => {
    expect(parseUrl("/budget/", "")).toEqual({ screen: "budget", reportsView: "overview", envelopeId: null });
    expect(parseUrl("/reports/assets/", "")).toEqual({ screen: "reports", reportsView: "assets", envelopeId: null });
  });

  test("leading double slash is tolerated", () => {
    expect(parseUrl("//budget", "")).toEqual({ screen: "budget", reportsView: "overview", envelopeId: null });
  });

  test("empty path is start", () => {
    expect(parseUrl("", "")).toEqual({ screen: "start", reportsView: "overview", envelopeId: null });
  });

  test("/add parses to a fresh addExpense screen (no way to carry an editTxn — not serialisable)", () => {
    expect(parseUrl("/add", "")).toEqual({ screen: "addExpense", reportsView: "overview", envelopeId: null });
  });

  test("a report tab is only honoured under /reports — it is not a top-level screen", () => {
    expect(parseUrl("/assets", "")).toEqual({ screen: "start", reportsView: "overview", envelopeId: null });
  });

  test("a valid ?env= is accepted", () => {
    expect(parseUrl("/budget", `?env=${ENV_ID}`)).toEqual({ screen: "budget", reportsView: "overview", envelopeId: ENV_ID });
  });

  test("hostile ?env=<script> is rejected by the UUID-shape guard", () => {
    expect(parseUrl("/budget", "?env=%3Cscript%3Ealert(1)%3C%2Fscript%3E")).toEqual({
      screen: "budget",
      reportsView: "overview",
      envelopeId: null,
    });
  });

  test("an ?env= that is merely too short is rejected", () => {
    expect(parseUrl("/budget", "?env=not-a-uuid")).toEqual({ screen: "budget", reportsView: "overview", envelopeId: null });
  });

  test("an empty ?env= is treated as absent", () => {
    expect(parseUrl("/budget", "?env=")).toEqual({ screen: "budget", reportsView: "overview", envelopeId: null });
  });

  test("extra query params besides env are ignored", () => {
    expect(parseUrl("/budget", `?foo=bar&env=${ENV_ID}&baz=qux`)).toEqual({
      screen: "budget",
      reportsView: "overview",
      envelopeId: ENV_ID,
    });
  });
});

describe("historyAction (entry-0 contract at the codec/glue seam)", () => {
  test("activation on a deep load stamps entry 0 in place — url unchanged, entry unstamped", () => {
    expect(historyAction(false, false, false)).toBe("stamp");
  });

  test("the FIRST navigation after activation PUSHES — never replaces the start entry", () => {
    // The regression this pins: stamping at the first CHANGE instead of at activation hit
    // `history.state == null` here and rewrote entry 0's URL to the DESTINATION, so hardware
    // back from the first in-session navigation exited the app.
    expect(historyAction(true, true, false)).toBe("push");
  });

  test("a settled pass (stamped, url in sync) touches nothing", () => {
    expect(historyAction(false, true, false)).toBe("none");
  });

  test("a URL change before entry 0 is stamped replaces in place (deep-load canonicalisation)", () => {
    // e.g. a stale ?env dropped on boot, or /reports/nonsense normalising to /reports — the
    // start entry is corrected, not duplicated.
    expect(historyAction(true, false, false)).toBe("replace");
  });

  test("a popstate correction replaces the entry just landed on, never pushes", () => {
    expect(historyAction(true, true, true)).toBe("replace");
  });

  test("popstate back onto the stamped entry 0 with the url already in sync is a no-op", () => {
    // entry 0 carries `false` — stamped (non-null), just not a pushed entry.
    expect(historyAction(false, true, true)).toBe("none");
  });
});

describe("no History side effects", () => {
  test("parseUrl and routeToUrl never touch window.history or location", () => {
    // Pure functions: calling them in a bun:test environment (no DOM/History API at all)
    // must not throw. If either function reached for a global, this test would fail to run.
    expect(() => parseUrl("/budget/assets", "?env=x")).not.toThrow();
    expect(() => routeToUrl({ screen: "reports", reportsView: "trends", envelopeId: ENV_ID })).not.toThrow();
  });
});
