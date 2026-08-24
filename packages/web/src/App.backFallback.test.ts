/**
 * Pure unit tests for `App.tsx`'s `backFallback` — the entry-0 fallback chain `back()` runs when
 * `history.state !== true` (no real history depth yet: a deep-loaded page, or a direct `back()`
 * call from a chevron/onBack prop with nothing pushed). Kept as its own test file rather than
 * folded into `components/wide/panel.test.ts` because `backFallback` deliberately lives in the
 * EAGER `App.tsx`, not the lazy wide chunk (see the doc comment on `backFallback` itself) — this
 * file exercises exactly that exported function, not the component.
 *
 * Two things this file pins:
 *  1. Every rung PR6 Task 1 adds (`close-env-edit`, `close-env-actions`, `reports-overview`) fires
 *     in the right circumstance and at the right PRIORITY relative to the others.
 *  2. Phone parity: for every state PR4's original inline fallback handled (envView open / Add
 *     open / anything else), the extended function returns the semantically equivalent rung —
 *     the extension changes nothing PR4 already relied on.
 */
import { describe, expect, mock, test } from "bun:test";
import type { BackFallback } from "./App";
import type { ScreenId } from "./components/chrome";
import type { ReportView } from "./screens/reports/types";

// `App.tsx` statically imports `UpdatePrompt.tsx`, which imports the Vite-only virtual module
// `virtual:pwa-register` (real at build time via `vite-plugin-pwa`, unresolvable under plain
// `bun test`, which has no Vite plugin pipeline). Stubbing it here is what makes importing
// `backFallback` straight out of `App.tsx` possible at all, honouring the brief's explicit
// requirement that it live there (not a separate module, so it never becomes an accidental import
// path FROM the lazy wide chunk INTO the eager bundle). `mock.module` must run — and the import of
// `./App` must be dynamic — BEFORE anything statically imports `App.tsx`'s module graph: a plain
// top-level `import { backFallback } from "./App"` is hoisted ahead of any statement in this file,
// including this mock registration, and would fail the exact same resolution error.
mock.module("virtual:pwa-register", () => ({ registerSW: () => () => {} }));
const { backFallback } = (await import("./App")) as typeof import("./App");

const ENV = { envelopeId: "env-1", month: "2026-08" };
const NOTHING_OPEN = { envEditOpen: false, envActionsOpen: false };

function s(over: Partial<Parameters<typeof backFallback>[0]>): Parameters<typeof backFallback>[0] {
  return { screen: "start", envView: null, reportsView: "overview", ...NOTHING_OPEN, ...over };
}

describe("backFallback — the six rungs, most specific first", () => {
  test("rung 1: an open envEdit sheet closes first, regardless of everything else stacked beneath it", () => {
    const cases: Array<Parameters<typeof backFallback>[0]> = [
      s({ envEditOpen: true }),
      s({ envEditOpen: true, envActionsOpen: true }),
      s({ envEditOpen: true, screen: "addExpense" }),
      s({ envEditOpen: true, envView: ENV }),
      s({ envEditOpen: true, screen: "reports", reportsView: "assets" }),
      s({ envEditOpen: true, envActionsOpen: true, screen: "addExpense", envView: ENV }),
    ];
    for (const c of cases) expect(backFallback(c)).toBe("close-env-edit");
  });

  test("rung 2: an open envActions sheet closes next — wins over Add/envelope/reports, loses to envEdit", () => {
    expect(backFallback(s({ envActionsOpen: true }))).toBe("close-env-actions");
    expect(backFallback(s({ envActionsOpen: true, screen: "addExpense" }))).toBe("close-env-actions");
    expect(backFallback(s({ envActionsOpen: true, envView: ENV }))).toBe("close-env-actions");
    expect(backFallback(s({ envActionsOpen: true, screen: "reports", reportsView: "goals" }))).toBe("close-env-actions");
  });

  test("rung 3: the Add pane closes next — wins over an open envelope pane and over a report subview", () => {
    expect(backFallback(s({ screen: "addExpense" }))).toBe("close-add");
    // D2 coexistence: Add opened over an already-open envelope pane. Closing Add first (not the
    // envelope) is exactly what lets closing Add derivationally RESTORE the envelope pane —
    // `envView` was never touched, so the very next resolvePanel call still resolves to it.
    expect(backFallback(s({ screen: "addExpense", envView: ENV }))).toBe("close-add");
    expect(backFallback(s({ screen: "addExpense", reportsView: "cashflow" }))).toBe("close-add");
  });

  test("rung 4: an open envelope pane closes next — wins over an open report subview", () => {
    expect(backFallback(s({ envView: ENV }))).toBe("close-envelope");
    expect(backFallback(s({ envView: ENV, screen: "reports", reportsView: "budgets" }))).toBe("close-envelope");
  });

  test("rung 5: a report subview backs to the hub overview (a genuinely new rung — PR4's inline fallback had no equivalent)", () => {
    const tabs: readonly ReportView[] = ["assets", "cashflow", "spending", "budgets", "goals", "month", "trends"];
    for (const reportsView of tabs) {
      expect(backFallback(s({ screen: "reports", reportsView }))).toBe("reports-overview");
    }
  });

  test("rung 6: any other non-start screen backs to start", () => {
    for (const screen of ["budget", "transactions", "accounts", "settings"] as const satisfies readonly ScreenId[]) {
      expect(backFallback(s({ screen }))).toBe("to-start");
    }
    // Reports AT the overview hub has nowhere shallower than start to fall back to.
    expect(backFallback(s({ screen: "reports", reportsView: "overview" }))).toBe("to-start");
  });

  test("rung 7 (none): already at start with nothing open — do nothing", () => {
    expect(backFallback(s({}))).toBeNull();
  });
});

describe("backFallback — phone parity with PR4's original inline fallback", () => {
  // PR4's inline body (pre-Task-1):
  //   if (envView) setEnvView(null);
  //   else if (screen === "addExpense") { setEditTxn(null); setScreen(editReturn); }
  //   else setScreen("start");
  // i.e. envelope wins, then Add, then everything else falls to start — provided neither of the
  // two NEW sheet layers (envEdit/envActions, impossible on phone before this PR) is open.
  function phoneEquivalent(v: BackFallback): "close-envelope" | "close-add" | "to-start-or-nothing" {
    if (v === "close-envelope") return "close-envelope";
    if (v === "close-add") return "close-add";
    return "to-start-or-nothing"; // "to-start" or null both collapse to PR4's plain `setScreen("start")`
  }

  test("every screen/envView/reportsView combination, with no sheet layer open, resolves to the SAME action PR4's original fallback would have taken", () => {
    const screens: readonly ScreenId[] = ["start", "budget", "transactions", "accounts", "reports", "addExpense", "settings"];
    const reportsViews: readonly ReportView[] = ["overview", "assets", "cashflow", "spending", "budgets", "goals", "month", "trends"];
    for (const screen of screens) {
      for (const reportsView of reportsViews) {
        for (const envView of [null, ENV]) {
          // `screen === "addExpense"` is checked FIRST here (D2's flipped priority — see the
          // dedicated coexistence test above), while PR4's original checked `envView` first. The
          // two orders only disagree on the (addExpense, envView open) combination, which is not
          // a phone-reachable state at all (openEnvelope only ever sets envView when
          // `mode !== "phone"` — App.tsx), so this loop's phone-parity claim holds regardless of
          // which rung is checked first.
          const got = backFallback(s({ screen, reportsView, envView }));
          const expected = screen === "addExpense" ? "close-add" : envView ? "close-envelope" : "to-start-or-nothing";
          expect(phoneEquivalent(got)).toBe(expected);
        }
      }
    }
  });
});
