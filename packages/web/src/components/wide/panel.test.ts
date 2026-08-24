/**
 * Pure pane-view resolver (panel.ts). Every `screen × envView × reportsView` combination that
 * matters is exercised, plus the two load-bearing rules the plan pins:
 *
 *  1. `panelClosed` is not a parameter of `resolvePanel` at all — open/closed survives
 *     navigation because it lives outside this function entirely (asserted here by showing the
 *     resolved view is identical across calls that differ only in what a caller's `panelClosed`
 *     bit happens to be, i.e. this function never needs to know it).
 *  2. An envelope opened from Reports (or from anywhere else) still resolves to the envelope —
 *     `envView` wins over every other input.
 */
import { describe, expect, test } from "bun:test";
import type { ReportTab, ReportView } from "../../screens/reports/types";
import type { ScreenId } from "../chrome";
import { type PanelView, primaryScreenFor, resolvePanel } from "./panel";

const ENV = { envelopeId: "env-1", month: "2026-08" };
const SCREENS: readonly ScreenId[] = ["start", "budget", "transactions", "accounts", "reports", "addExpense", "settings"];
// Every screen EXCEPT `addExpense` — PR6 Task 1's `add` kind wins over an open envelope there
// (rule below), so `addExpense` is excluded from the plain "envelope wins" loop and covered by
// its own describe block instead.
const NON_ADD_SCREENS: readonly ScreenId[] = SCREENS.filter((s) => s !== "addExpense");
const REPORT_VIEWS: readonly ReportView[] = ["overview", "assets", "cashflow", "spending", "budgets", "goals", "month", "trends"];

describe("resolvePanel", () => {
  test("an open envelope wins on every screen except addExpense, and every reportsView (rule 2)", () => {
    for (const screen of NON_ADD_SCREENS) {
      for (const reportsView of REPORT_VIEWS) {
        const view = resolvePanel({ screen, reportsView, envView: ENV });
        expect(view).toEqual({ kind: "envelope", envelopeId: ENV.envelopeId, month: ENV.month });
      }
    }
  });

  test("Reports at the hub overview (no envelope) resolves to the report hint", () => {
    expect(resolvePanel({ screen: "reports", reportsView: "overview", envView: null })).toEqual({ kind: "empty", hint: "report" });
  });

  test("Reports on any subview (no envelope) resolves to that subview's report pane", () => {
    const tabs: readonly ReportTab[] = ["assets", "cashflow", "spending", "budgets", "goals", "month", "trends"];
    for (const view of tabs) {
      expect(resolvePanel({ screen: "reports", reportsView: view, envView: null })).toEqual({ kind: "report", view });
    }
  });

  test("Start and Budget (no envelope) resolve to the envelope hint, regardless of reportsView", () => {
    for (const screen of ["start", "budget"] as const) {
      for (const reportsView of REPORT_VIEWS) {
        expect(resolvePanel({ screen, reportsView, envView: null })).toEqual({ kind: "empty", hint: "envelope" });
      }
    }
  });

  test("every other screen (no envelope) resolves to the generic hint, regardless of reportsView — txn/acct/settings stay PR6b scope; addExpense is covered separately below (it now resolves to `add`)", () => {
    for (const screen of ["transactions", "accounts", "settings"] as const) {
      for (const reportsView of REPORT_VIEWS) {
        expect(resolvePanel({ screen, reportsView, envView: null })).toEqual({ kind: "empty", hint: "generic" });
      }
    }
  });

  test("rule 1 — the function takes no panelClosed parameter: two calls differing in nothing this function sees resolve identically", () => {
    // There is no `panelClosed` field on the input type at all (a compile-time guarantee — see
    // the `PanelView`/`resolvePanel` signature). This test pins the runtime half of that
    // contract: calling with the exact same navigation inputs twice is deterministic, so a
    // caller toggling its own separate `panelClosed` bit around these calls can never observe
    // a different resolved view because of it.
    const input = { screen: "reports" as ScreenId, reportsView: "assets" as ReportView, envView: null };
    const first = resolvePanel(input);
    const second = resolvePanel(input);
    expect(first).toEqual(second);
  });

  test("exhaustively covers PR4's three kinds, PR5's `widgets` and PR6's `add` — no sixth kind sneaks in", () => {
    const kinds = new Set<PanelView["kind"]>();
    for (const screen of SCREENS) {
      for (const reportsView of REPORT_VIEWS) {
        kinds.add(resolvePanel({ screen, reportsView, envView: null }).kind);
        kinds.add(resolvePanel({ screen, reportsView, envView: ENV }).kind);
        kinds.add(resolvePanel({ screen, reportsView, envView: null, widgetSettings: "envelopes" }).kind);
      }
    }
    expect([...kinds].sort()).toEqual(["add", "empty", "envelope", "report", "widgets"]);
  });

  describe("PR5's `widgets` kind (the wide board's gear target)", () => {
    test("Start with a widgetSettings selection (no envelope) resolves to the widgets pane", () => {
      expect(resolvePanel({ screen: "start", reportsView: "overview", envView: null, widgetSettings: "spending" })).toEqual({
        kind: "widgets",
        widgetId: "spending",
      });
    });

    test("an open envelope still wins over a pending widgetSettings selection", () => {
      expect(resolvePanel({ screen: "start", reportsView: "overview", envView: ENV, widgetSettings: "spending" })).toEqual({
        kind: "envelope",
        envelopeId: ENV.envelopeId,
        month: ENV.month,
      });
    });

    test("omitting widgetSettings (undefined, the pre-PR5 call shape) behaves exactly like null — Start falls back to the envelope hint", () => {
      expect(resolvePanel({ screen: "start", reportsView: "overview", envView: null })).toEqual({ kind: "empty", hint: "envelope" });
    });

    test("a widgetSettings selection is ignored on every screen other than Start — a stale value there never leaks into the panel", () => {
      for (const screen of ["budget", "transactions", "accounts", "reports", "addExpense", "settings"] as const) {
        const view = resolvePanel({ screen, reportsView: "overview", envView: null, widgetSettings: "spending" });
        expect(view.kind).not.toBe("widgets");
      }
    });
  });

  describe("PR6's `add` kind (the Add/edit-transaction takeover pane) — D2's push semantics", () => {
    test("addExpense (no envelope, no report subview) resolves to the add pane, regardless of reportsView", () => {
      for (const reportsView of REPORT_VIEWS) {
        expect(resolvePanel({ screen: "addExpense", reportsView, envView: null })).toEqual({ kind: "add" });
      }
    });

    test("add wins over an open envelope — an open Add pane is not cleared by envView, so closing it derivationally restores the envelope", () => {
      for (const reportsView of REPORT_VIEWS) {
        expect(resolvePanel({ screen: "addExpense", reportsView, envView: ENV })).toEqual({ kind: "add" });
      }
    });

    test("add wins over an open report subview", () => {
      const tabs: readonly ReportTab[] = ["assets", "cashflow", "spending", "budgets", "goals", "month", "trends"];
      for (const view of tabs) {
        expect(resolvePanel({ screen: "addExpense", reportsView: view, envView: null })).toEqual({ kind: "add" });
      }
    });

    test("add wins over a pending widgetSettings selection too (defensive — addExpense never coincides with widgetSettings in practice)", () => {
      expect(resolvePanel({ screen: "addExpense", reportsView: "overview", envView: null, widgetSettings: "spending" })).toEqual({ kind: "add" });
    });
  });
});

describe("primaryScreenFor", () => {
  test("returns editReturn while the screen is addExpense — the primary pane keeps showing the screen Add returns to, never the Add takeover itself", () => {
    for (const editReturn of SCREENS) {
      expect(primaryScreenFor("addExpense", editReturn)).toBe(editReturn);
    }
  });

  test("returns the screen unchanged for every other screen, regardless of editReturn", () => {
    for (const screen of NON_ADD_SCREENS) {
      for (const editReturn of SCREENS) {
        expect(primaryScreenFor(screen, editReturn)).toBe(screen);
      }
    }
  });
});
