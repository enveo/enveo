/**
 * Pure pane-view resolver (panel.ts). Every `screen × envView × reportsView` combination that
 * matters is exercised, plus the load-bearing rules the plan pins:
 *
 *  1. `panelClosed` is not a parameter of `resolvePanel` at all — open/closed survives
 *     navigation because it lives outside this function entirely (asserted here by showing the
 *     resolved view is identical across calls that differ only in what a caller's `panelClosed`
 *     bit happens to be, i.e. this function never needs to know it).
 *  2. An envelope opened from Reports (or from anywhere else) still resolves to the envelope —
 *     `envView` wins over every other input.
 *  3. Design parity Wave A Task 1 (owner rule 1, `waveA-t1-brief.md`) — the panel is NEVER EMPTY
 *     when there is data to fall back to: `envelope`/`report`/`account` resolve to real content
 *     (tagged `source: "fallback"`) even with no explicit selection, using `panelFallbacks`'s
 *     "first item" table. `empty` survives ONLY for a genuinely empty dataset (the fallback id is
 *     null) or for a screen with no panel-selection axis at all (transactions — C3's scope).
 *     Settings (owner rule 5) reads `acctView` exactly like Accounts does — the account context
 *     persists there instead of resolving to `generic`.
 */
import { describe, expect, test } from "bun:test";
import type { ReportTab, ReportView } from "../../screens/reports/types";
import type { ScreenId } from "../chrome";
import { type PanelFallbacks, type PanelView, panelFallbacks, primaryScreenFor, resolvePanel } from "./panel";

const ENV = { envelopeId: "env-1", month: "2026-08" };
const ACCT = { accountId: "acc-1" };
const TXN = { txnId: "txn-1" };
// Fallback table with real ids on every axis — most tests use this so a "no explicit selection"
// call still resolves to CONTENT (the whole point of Task 1), distinguishable from ENV/ACCT above
// by id so a test can tell selection-content from fallback-content apart at a glance.
const FB: PanelFallbacks = { firstEnvelopeId: "env-fb", firstAccountId: "acc-fb", firstTxnId: "txn-fb", month: "2026-08" };
// The genuinely-empty-dataset table (every fallback id null) — `empty` must still survive here.
const EMPTY_FB: PanelFallbacks = { firstEnvelopeId: null, firstAccountId: null, firstTxnId: null, month: "2026-08" };

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
        const view = resolvePanel({ screen, reportsView, envView: ENV }, FB);
        expect(view).toEqual({ kind: "envelope", envelopeId: ENV.envelopeId, month: ENV.month, source: "selection" });
      }
    }
  });

  test("Reports at the hub overview (no envelope, no subview) falls back to the Spending report (v3:2213's own selReport default)", () => {
    expect(resolvePanel({ screen: "reports", reportsView: "overview", envView: null }, FB)).toEqual({
      kind: "report",
      view: "spending",
      source: "fallback",
    });
  });

  test("Reports on any subview (no envelope) resolves to that subview's report pane, as a real selection", () => {
    const tabs: readonly ReportTab[] = ["assets", "cashflow", "spending", "budgets", "goals", "month", "trends"];
    for (const view of tabs) {
      expect(resolvePanel({ screen: "reports", reportsView: view, envView: null }, FB)).toEqual({ kind: "report", view, source: "selection" });
    }
  });

  test("Start and Budget (no envelope) fall back to the first envelope, regardless of reportsView", () => {
    for (const screen of ["start", "budget"] as const) {
      for (const reportsView of REPORT_VIEWS) {
        expect(resolvePanel({ screen, reportsView, envView: null }, FB)).toEqual({
          kind: "envelope",
          envelopeId: FB.firstEnvelopeId!,
          month: FB.month,
          source: "fallback",
        });
      }
    }
  });

  test("Start and Budget resolve to the empty envelope hint ONLY when the fallback dataset is genuinely empty", () => {
    for (const screen of ["start", "budget"] as const) {
      expect(resolvePanel({ screen, reportsView: "overview", envView: null }, EMPTY_FB)).toEqual({ kind: "empty", hint: "envelope" });
    }
  });

  test("Accounts and Settings (no acctView) fall back to the first account, regardless of reportsView", () => {
    for (const screen of ["accounts", "settings"] as const) {
      for (const reportsView of REPORT_VIEWS) {
        expect(resolvePanel({ screen, reportsView, envView: null }, FB)).toEqual({ kind: "account", accountId: FB.firstAccountId!, source: "fallback" });
      }
    }
  });

  test("Accounts and Settings resolve to the empty account hint ONLY when the fallback dataset is genuinely empty", () => {
    for (const screen of ["accounts", "settings"] as const) {
      expect(resolvePanel({ screen, reportsView: "overview", envView: null }, EMPTY_FB)).toEqual({ kind: "empty", hint: "account" });
    }
  });

  test("Settings resolves to the PERSISTED account selection when acctView is present (owner rule 5 — the account context survives a visit to Settings)", () => {
    for (const reportsView of REPORT_VIEWS) {
      expect(resolvePanel({ screen: "settings", reportsView, envView: null, acctView: ACCT }, FB)).toEqual({
        kind: "account",
        accountId: ACCT.accountId,
        source: "selection",
      });
    }
  });

  test("Transactions (no envelope, no txnView) falls back to the first transaction, regardless of reportsView (design parity wave C task 3)", () => {
    for (const reportsView of REPORT_VIEWS) {
      expect(resolvePanel({ screen: "transactions", reportsView, envView: null }, FB)).toEqual({ kind: "txn", txnId: FB.firstTxnId!, source: "fallback" });
    }
  });

  test("Transactions resolves to the empty generic hint ONLY when the fallback dataset is genuinely empty", () => {
    for (const reportsView of REPORT_VIEWS) {
      expect(resolvePanel({ screen: "transactions", reportsView, envView: null }, EMPTY_FB)).toEqual({ kind: "empty", hint: "generic" });
    }
  });

  test("rule 1 — the function takes no panelClosed parameter: two calls differing in nothing this function sees resolve identically", () => {
    // There is no `panelClosed` field on the input type at all (a compile-time guarantee — see
    // the `PanelView`/`resolvePanel` signature). This test pins the runtime half of that
    // contract: calling with the exact same navigation inputs twice is deterministic, so a
    // caller toggling its own separate `panelClosed` bit around these calls can never observe
    // a different resolved view because of it.
    const input = { screen: "reports" as ScreenId, reportsView: "assets" as ReportView, envView: null };
    const first = resolvePanel(input, FB);
    const second = resolvePanel(input, FB);
    expect(first).toEqual(second);
  });

  test("exhaustively covers every kind — no seventh kind sneaks in", () => {
    const kinds = new Set<PanelView["kind"]>();
    for (const screen of SCREENS) {
      for (const reportsView of REPORT_VIEWS) {
        kinds.add(resolvePanel({ screen, reportsView, envView: null }, FB).kind);
        kinds.add(resolvePanel({ screen, reportsView, envView: ENV }, FB).kind);
        kinds.add(resolvePanel({ screen, reportsView, envView: null, widgetSettings: "envelopes" }, FB).kind);
      }
    }
    // With every fallback id populated (FB), "empty" no longer appears in this loop at all —
    // Accounts/Settings fall back to "account" (Task 1) and Transactions now falls back to "txn"
    // (design parity wave C task 3), the last screen that used to bottom out at "empty" here.
    expect([...kinds].sort()).toEqual(["account", "add", "envelope", "report", "txn", "widgets"]);
  });

  describe("PR5's `widgets` kind (the wide board's gear target)", () => {
    test("Start with a widgetSettings selection (no envelope) resolves to the widgets pane", () => {
      expect(resolvePanel({ screen: "start", reportsView: "overview", envView: null, widgetSettings: "spending" }, FB)).toEqual({
        kind: "widgets",
        widgetId: "spending",
      });
    });

    test("an open envelope still wins over a pending widgetSettings selection", () => {
      expect(resolvePanel({ screen: "start", reportsView: "overview", envView: ENV, widgetSettings: "spending" }, FB)).toEqual({
        kind: "envelope",
        envelopeId: ENV.envelopeId,
        month: ENV.month,
        source: "selection",
      });
    });

    test("omitting widgetSettings (undefined, the pre-PR5 call shape) behaves exactly like null — Start falls back to the first envelope", () => {
      expect(resolvePanel({ screen: "start", reportsView: "overview", envView: null }, FB)).toEqual({
        kind: "envelope",
        envelopeId: FB.firstEnvelopeId!,
        month: FB.month,
        source: "fallback",
      });
    });

    test("a widgetSettings selection is ignored on every screen other than Start — a stale value there never leaks into the panel", () => {
      for (const screen of ["budget", "transactions", "accounts", "reports", "addExpense", "settings"] as const) {
        const view = resolvePanel({ screen, reportsView: "overview", envView: null, widgetSettings: "spending" }, FB);
        expect(view.kind).not.toBe("widgets");
      }
    });
  });

  describe("PR6's `add` kind (the Add/edit-transaction takeover pane) — D2's push semantics", () => {
    test("addExpense (no envelope, no report subview) resolves to the add pane, regardless of reportsView", () => {
      for (const reportsView of REPORT_VIEWS) {
        expect(resolvePanel({ screen: "addExpense", reportsView, envView: null }, FB)).toEqual({ kind: "add" });
      }
    });

    test("add wins over an open envelope — an open Add pane is not cleared by envView, so closing it derivationally restores the envelope", () => {
      for (const reportsView of REPORT_VIEWS) {
        expect(resolvePanel({ screen: "addExpense", reportsView, envView: ENV }, FB)).toEqual({ kind: "add" });
      }
    });

    test("add wins over an open report subview", () => {
      const tabs: readonly ReportTab[] = ["assets", "cashflow", "spending", "budgets", "goals", "month", "trends"];
      for (const view of tabs) {
        expect(resolvePanel({ screen: "addExpense", reportsView: view, envView: null }, FB)).toEqual({ kind: "add" });
      }
    });

    test("add wins over a pending widgetSettings selection too (defensive — addExpense never coincides with widgetSettings in practice)", () => {
      expect(resolvePanel({ screen: "addExpense", reportsView: "overview", envView: null, widgetSettings: "spending" }, FB)).toEqual({ kind: "add" });
    });
  });

  describe("PR6b's `account` kind (the v3 `acct` pane, Task 3) — extended by Task 1 with the fallback + Settings rungs", () => {
    test("accounts with a selection resolves to the account pane, as a real selection", () => {
      for (const reportsView of REPORT_VIEWS) {
        expect(resolvePanel({ screen: "accounts", reportsView, envView: null, acctView: ACCT }, FB)).toEqual({
          kind: "account",
          accountId: ACCT.accountId,
          source: "selection",
        });
      }
    });

    test("omitting acctView (undefined) behaves exactly like null — Accounts falls back to the first account", () => {
      expect(resolvePanel({ screen: "accounts", reportsView: "overview", envView: null }, FB)).toEqual({
        kind: "account",
        accountId: FB.firstAccountId!,
        source: "fallback",
      });
    });

    test("an open envelope still wins over a selected account (priority pin — envelope beats account, same as it beats widgets)", () => {
      expect(resolvePanel({ screen: "accounts", reportsView: "overview", envView: ENV, acctView: ACCT }, FB)).toEqual({
        kind: "envelope",
        envelopeId: ENV.envelopeId,
        month: ENV.month,
        source: "selection",
      });
    });

    test("add wins over a selected account too", () => {
      expect(resolvePanel({ screen: "addExpense", reportsView: "overview", envView: null, acctView: ACCT }, FB)).toEqual({ kind: "add" });
    });

    test("a selected account is ignored on every screen other than accounts and settings — a stale value there never leaks into the panel", () => {
      for (const screen of ["start", "budget", "transactions", "reports", "addExpense"] as const) {
        const view = resolvePanel({ screen, reportsView: "overview", envView: null, acctView: ACCT }, FB);
        expect(view.kind).not.toBe("account");
      }
    });
  });

  describe("design parity wave C task 3's `txn` kind (the v3 `txn` pane)", () => {
    test("transactions with a selection resolves to the txn pane, as a real selection", () => {
      for (const reportsView of REPORT_VIEWS) {
        expect(resolvePanel({ screen: "transactions", reportsView, envView: null, txnView: TXN }, FB)).toEqual({
          kind: "txn",
          txnId: TXN.txnId,
          source: "selection",
        });
      }
    });

    test("omitting txnView (undefined) behaves exactly like null — Transactions falls back to the first transaction", () => {
      expect(resolvePanel({ screen: "transactions", reportsView: "overview", envView: null }, FB)).toEqual({
        kind: "txn",
        txnId: FB.firstTxnId!,
        source: "fallback",
      });
    });

    test("an open envelope still wins over a selected txn (priority pin — envelope beats txn, same as it beats account/widgets)", () => {
      expect(resolvePanel({ screen: "transactions", reportsView: "overview", envView: ENV, txnView: TXN }, FB)).toEqual({
        kind: "envelope",
        envelopeId: ENV.envelopeId,
        month: ENV.month,
        source: "selection",
      });
    });

    test("add wins over a selected txn too", () => {
      expect(resolvePanel({ screen: "addExpense", reportsView: "overview", envView: null, txnView: TXN }, FB)).toEqual({ kind: "add" });
    });

    test("a selected txn is ignored on every screen other than transactions — a stale value there never leaks into the panel", () => {
      for (const screen of ["start", "budget", "accounts", "reports", "addExpense", "settings"] as const) {
        const view = resolvePanel({ screen, reportsView: "overview", envView: null, txnView: TXN }, FB);
        expect(view.kind).not.toBe("txn");
      }
    });
  });

  describe("panelFallbacks (the panel's contextual first-item table)", () => {
    const GROUPS = [
      { id: "g1", sort: 1 },
      { id: "g2", sort: 0 },
    ];
    const ENVELOPES = [
      { id: "e-later", groupId: "g1", sort: 0, archived: false },
      { id: "e-archived-first", groupId: "g2", sort: 0, archived: true },
      { id: "e-earlier", groupId: "g2", sort: 1, archived: false },
    ];
    const ACCOUNTS = [
      { id: "a-archived-first", sort: 0, archived: true },
      { id: "a-second", sort: 1, archived: false },
      { id: "a-first", sort: 0, archived: false },
    ];

    test("picks the non-archived envelope earliest in GROUP-major then envelope-sort order (mirrors Budget's own visual order)", () => {
      const fb = panelFallbacks({ envelopes: ENVELOPES, groups: GROUPS, accounts: [] }, "2026-08", []);
      // g2 (sort 0) beats g1 (sort 1); within g2 the archived envelope is skipped, leaving "e-earlier".
      expect(fb.firstEnvelopeId).toBe("e-earlier");
    });

    test("picks the non-archived account earliest by plain `sort`, skipping archived ones", () => {
      const fb = panelFallbacks({ envelopes: [], groups: [], accounts: ACCOUNTS }, "2026-08", []);
      expect(fb.firstAccountId).toBe("a-first");
    });

    test("an orphaned envelope (group not found) sorts last rather than crashing", () => {
      const fb = panelFallbacks({ envelopes: [{ id: "orphan", groupId: "missing-group", sort: 0, archived: false }], groups: [], accounts: [] }, "2026-08", []);
      expect(fb.firstEnvelopeId).toBe("orphan");
    });

    test("no non-archived envelopes/accounts → null fallback ids (the genuinely-empty-dataset case)", () => {
      const fb = panelFallbacks(
        { envelopes: [{ id: "e1", groupId: "g1", sort: 0, archived: true }], groups: GROUPS, accounts: [{ id: "a1", sort: 0, archived: true }] },
        "2026-08",
        [],
      );
      expect(fb.firstEnvelopeId).toBeNull();
      expect(fb.firstAccountId).toBeNull();
    });

    test("firstTxnId is the first entry of the CALLER-filtered list, not `state.transactions` itself — this function does no filtering of its own", () => {
      const fb = panelFallbacks({ envelopes: [], groups: [], accounts: [] }, "2026-08", [{ id: "t2" }, { id: "t1" }]);
      expect(fb.firstTxnId).toBe("t2");
    });

    test("an empty filtered transaction list → null firstTxnId", () => {
      const fb = panelFallbacks({ envelopes: [], groups: [], accounts: [] }, "2026-08", []);
      expect(fb.firstTxnId).toBeNull();
    });

    test("passes `month` straight through, unchanged", () => {
      const fb = panelFallbacks({ envelopes: [], groups: [], accounts: [] }, "2026-11", []);
      expect(fb.month).toBe("2026-11");
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
