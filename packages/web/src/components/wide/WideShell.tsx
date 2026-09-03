import type { Transaction, WideWidgetId } from "@enveo/shared";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { StateResponse } from "../../lib/api";
import { useTheme } from "../../lib/contexts";
import { monthLabel } from "../../lib/dates";
import { type Message, msg, useT } from "../../lib/i18n";
import { Ico } from "../../lib/icons";
import { InWideShell, type PaneRect, type PaneSurfaceHost } from "../../lib/shellContext";
import { CTA, font, TEAL } from "../../lib/theme";
// Design parity wave A close, item 9: the Transactions band caption ("{n} shown") needs the SAME
// filtering `TransactionsScreen` already does — imported HERE (the lazy wide chunk), never from
// App.tsx (eager): App.tsx's own comment on the bag fields below explains why pulling this module
// into the eager bundle would spend the §3f headroom this wave has almost none of left.
import { createTransactionSearchIndex, matchesTransactionFilters, matchesTransactionQuery, type TransactionFilters } from "../../lib/transactionSearch";
import { useElementWidth } from "../../lib/useElementWidth";
import type { ViewMode } from "../../lib/viewMode";
import type { Tab as AddTab } from "../../screens/Add";
import type { ReportTab, ReportView } from "../../screens/reports/types";
import { WideHome } from "../../screens/WideHome";
import type { ScreenId } from "../chrome";
import { SyncBadge } from "../SyncBadge";
import { UpdatePrompt } from "../UpdatePrompt";
import { FoldTbbStrip } from "./FoldTbbStrip";
import { paneWidthFor } from "./geometry";
import { PanelHost } from "./PanelHost";
// Design parity wave C task 3: `panelFallbacks` (the FUNCTION) is imported here under an alias —
// the bag's own `panelFallbacks` field (a plain VALUE, App's eager, unfiltered computation) is
// destructured under its own name below, and this component needs BOTH: the bag's value still
// backs the envelope/account fallbacks (those two have nothing to do with transaction filters),
// while the txn kind needs this function called AGAIN with the properly filtered transaction list
// this lazy chunk already builds (see `fallbacksForPanel` below).
import { panelFallbacks as computePanelFallbacks, resolvePanel } from "./panel";
import { Rail } from "./Rail";
import { WideSettings } from "./WideSettings";

/**
 * One right-slot contract (pr4-context.md §13) — computed by App, rendered here verbatim.
 *
 * Design-parity wave A, task A5 (waveA-t5-brief.md; design v3:202,4351): widened from a single
 * always-clickable shape to two kinds. The design's `headerRight` is ONE plain caption span for
 * every screen — Home/Budget happen to make theirs clickable (`headerRightCursor` is "pointer"
 * only for those two), Accounts/Settings/Reports are inert text. `"action"` keeps today's
 * pencil-button behaviour (still a real ≥30×30-hit button — house touch-target rule — just
 * caption-weight now, see `BandHeader` below); `"caption"` is plain non-interactive text (no
 * button semantics needed: nothing to click, so no touch-target obligation either).
 */
type RightSlot = { kind: "action"; label: string; ariaLabel: string; onClick: () => void } | { kind: "caption"; text: string } | null;

export type { RightSlot };

const SCREEN_TITLE: Record<ScreenId, Message> = {
  start: msg("Home"),
  budget: msg("Budget"),
  transactions: msg("Transactions"),
  accounts: msg("Accounts"),
  activity: msg("Imports"),
  reports: msg("Reports"),
  // Unreachable here even now that Add IS a wide pane (PR6 Task 5): `BandHeader` only ever
  // receives `primaryScreen` (App.tsx), which resolves to `editReturn` while Add is open and so
  // is never itself "addExpense" (`editReturn` is never set to that value — see `openAddWide`).
  addExpense: msg("Add"),
  settings: msg("Settings"),
};

const PENCIL_D = "M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.1 2.1 0 013 3L12 15l-4 1 1-4 9.5-9.5z";

/**
 * The design's own panel-toggle glyph (owner ruling, parity owner round 1 item 4; v3:205-206 +
 * derivations 4155-4161): an 18×14 rounded outline (1.5px stroke, 4px OUTER radius — the border
 * is inside the box, so the stroke centerline sits at 0.75 with rx 3.25) holding a FILLED
 * right-hand column whose width tracks the panel state — 3px closed, 7px open (`panelBtnBarW`).
 * The bar hugs the frame's inner right edge (content box x ≤ 16.5, y 1.5–12.5) and inherits the
 * frame's rounding on its outer corners (inner radius = 4 − 1.5 border = 2.5), exactly what the
 * design's `overflow: hidden` clip produced. Replaces the previous hollow-two-column reading
 * (a centered divider line), which the owner flagged as not matching the design. Colors via
 * `style`, never a presentation attribute, per the house SVG-color rule.
 */
function PanelToggleGlyph({ color, closed }: { color: string; closed: boolean }) {
  const barLeft = closed ? 13.5 : 9.5;
  return (
    <svg width="18" height="14" viewBox="0 0 18 14" fill="none" aria-hidden="true">
      <rect x="0.75" y="0.75" width="16.5" height="12.5" rx="3.25" style={{ stroke: color }} strokeWidth="1.5" />
      <path d={`M${barLeft} 1.5 H14 Q16.5 1.5 16.5 4 V10 Q16.5 12.5 14 12.5 H${barLeft} Z`} style={{ fill: color }} />
    </svg>
  );
}

function BandHeader({
  screen,
  month,
  onPrev,
  onNext,
  onAdd,
  onOpenSync,
  rightSlot,
  panelClosed,
  onTogglePanel,
  compact,
}: {
  screen: ScreenId;
  month: string;
  onPrev: () => void;
  onNext: () => void;
  onAdd: () => void;
  onOpenSync: () => void;
  rightSlot: RightSlot;
  panelClosed: boolean;
  onTogglePanel: () => void;
  /** Narrow primary (fold with the panel open): the rightSlot drops its text label (icon-only,
   *  aria-label/title keep the accessible name). Measured need: Budget's full toolbar is ~616px
   *  wide while the fold's panel-open primary offers ~483px — the +Add and panel-toggle buttons
   *  landed UNDER the panel's own header, unclickable (elementFromPoint returned the panel). */
  compact: boolean;
}) {
  const C = useTheme();
  const { t, lang } = useT();
  const toggleLabel = panelClosed ? t("Show the side panel") : t("Hide the side panel");
  return (
    // data-wide-band: stable test hook (same idiom as data-wide-primary/-panel below) — the
    // verification playbook's touch-target sweep selects `[data-wide-band] button`.
    // flexWrap is the reachability BACKSTOP `compact` alone cannot give: label widths are
    // locale-dependent (pl "Zarządzaj kopertami", de month names), so any single-row budget can
    // be exceeded — wrapping keeps every control inside the pane instead of pushing the trailing
    // buttons under the neighbouring panel's header.
    <div
      data-wide-band
      style={{
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        // Row-gap only ever shows up ONCE the wrap backstop above actually wraps to a second
        // row — a single-row band (the design's own, and every desktop width) renders with true
        // zero vertical padding (design v3:188 `padding: 0 16px` — no vertical term at all), and
        // `minHeight` below alone gives it its 56px. Column-gap (16) is the design's own `gap:14`
        // rounded up to match the 16px horizontal padding it sits beside.
        gap: "6px 16px",
        padding: "0 16px",
        minHeight: 56,
        borderBottom: `1px solid ${C.line}`,
        flexShrink: 0,
      }}
    >
      <span style={{ fontSize: 17, fontWeight: 600, color: C.text, flexShrink: 0 }}>{t(SCREEN_TITLE[screen])}</span>
      {screen !== "settings" && (
        <div style={{ display: "flex", alignItems: "center", gap: 11, flexShrink: 0 }}>
          <button
            onClick={onPrev}
            aria-label={t("Previous month")}
            style={{
              width: 30,
              height: 30,
              border: "none",
              background: "transparent",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ico d="M15 19l-7-7 7-7" size={16} color={C.bandMute} />
          </button>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: C.text, minWidth: 100, textAlign: "center" }}>{monthLabel(month, lang)}</span>
          <button
            onClick={onNext}
            aria-label={t("Next month")}
            style={{
              width: 30,
              height: 30,
              border: "none",
              background: "transparent",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Ico d="M9 5l7 7-7 7" size={16} color={C.bandMute} />
          </button>
        </div>
      )}
      {/* One action CLUSTER, not loose siblings behind a flex:1 spacer: with flexWrap above, a
          spacer would strand whichever trailing buttons wrapped on a left-aligned second row —
          the cluster wraps as a unit and marginLeft:auto keeps it right-aligned on its own row. */}
      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 16 }}>
        {/* A genuine flex child of the band header, never an overlay above content — see the
            SyncBadge.tsx file header for why `topOffset`-over-the-primary-pane was replaced. */}
        <SyncBadge inline onOpenSync={onOpenSync} />
        {rightSlot?.kind === "action" && (
          // Design v3:202 — `headerRight` is a bare caption everywhere (11.5px, bandMute, no
          // border/box); Home/Budget merely happen to make theirs clickable. Still a REAL button
          // with a ≥30px hit area (house touch-target rule) — the caption weight comes from
          // dropping the radius/background/13px-bold text this used to carry, not from losing
          // button semantics.
          <button
            onClick={rightSlot.onClick}
            aria-label={rightSlot.ariaLabel}
            title={compact ? rightSlot.label : undefined}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              minWidth: 30,
              minHeight: 30,
              padding: "0 6px",
              borderRadius: 0,
              border: "none",
              background: "none",
              color: C.bandMute,
              cursor: "pointer",
              flexShrink: 0,
              justifyContent: "center",
            }}
          >
            <Ico d={PENCIL_D} size={13} color={C.bandMute} />
            {!compact && <span style={{ fontSize: 11.5 }}>{rightSlot.label}</span>}
          </button>
        )}
        {rightSlot?.kind === "caption" && (
          // Accounts ("Balance {amount}") / Settings ("Enveo v… · build …") — inert text, no
          // button semantics and so no touch-target obligation (nothing here is clickable).
          <span style={{ fontSize: 11.5, color: C.bandMute, flexShrink: 0, whiteSpace: "nowrap" }}>{rightSlot.text}</span>
        )}
        <button
          onClick={onAdd}
          // Compact drops the CTA's text too (icon-only ＋): the pl/de labels alone push the
          // fold's panel-open row past its ~451px content box — the aria-label/title keep the
          // accessible name, wrapping stays the backstop for transient extra content (SyncBadge).
          aria-label={compact ? t("Add") : undefined}
          title={compact ? t("Add") : undefined}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            minWidth: 30,
            minHeight: 30,
            padding: compact ? "0 10px" : "0 14px",
            borderRadius: 8,
            border: "none",
            background: CTA,
            color: "#fff",
            fontWeight: 700,
            fontSize: 13,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <span aria-hidden style={{ fontSize: 15, lineHeight: 1 }}>
            ＋
          </span>
          {!compact && t("Add")}
        </button>
        <button
          data-panel-toggle
          aria-expanded={!panelClosed}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={onTogglePanel}
          style={{
            width: 30,
            height: 30,
            minWidth: 30,
            minHeight: 30,
            // The border below adds to the box unless sized under it — keeps the touch target at
            // exactly 30×30 (house rule) whichever state is showing, not 32×32 while closed.
            boxSizing: "border-box",
            flexShrink: 0,
            borderRadius: 8,
            // Design parity wave A close, item 7 (v3:4161, `panelBtnBorder`): CLOSED gets a
            // visible hairline (`T.bandLine2`, a fainter tone than `line`/`bandLine`), OPEN stays
            // transparent — this button previously had no border in either state.
            border: `1px solid ${panelClosed ? C.bandLine2 : "transparent"}`,
            // Design v3:4155 (`panelBtnBg`) — the open state is `T.accentSoft`, not the app's
            // generic `inset` tint (Task A2's rail/panel token).
            background: panelClosed ? "transparent" : C.accentSoft,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {/* Design v3:4157 (`panelBtnFg`) — the glyph tracks the same open/closed split as the
              button's own background just above. */}
          <PanelToggleGlyph color={panelClosed ? C.soft : TEAL} closed={panelClosed} />
        </button>
      </div>
    </div>
  );
}

/**
 * Everything WideShell needs from App, EXCEPT `rightSlot` (a computed value, not a plain
 * identifier) and `children` (JSX children stay JSX children) — grouped into one object per
 * pr4-context.md §11's named shrink ("move the wide-branch prop bag construction into
 * WideShell"), applied at the eager→lazy call site the §3f budget is tightest around. Measured
 * result (2026-08-23, this build): grouping alone does NOT shrink the compiled output — esbuild
 * emits `key: value` for a JSX attribute and for an object-literal property identically whether
 * or not the two names match textually, so `mode={mode}` and `{mode}` compile to the same bytes.
 * The real, measured saving here is `setEnvView`/`setReportsView`/`setPanelClosed` carrying the
 * RAW state setters (WideShell decides when to call each, in `closePanel` below) instead of each
 * being wrapped in a one-line arrow at the call site — every wrapper arrow is source the eager
 * chunk has to carry that a raw reference does not. The grouping stays for a smaller reason: one
 * named bag type is easier for PR6 to extend than a thirteen-argument prop list.
 */
type WideShellBag = {
  mode: Exclude<ViewMode, "phone">;
  /** The RAW screen — used ONLY by `resolvePanel` below (it needs the literal `"addExpense"` to
   *  detect the Add pane is open at all). Everything else that asks "which screen is this" reads
   *  `primaryScreen` instead (PR6 Task 5) — see that field's own comment. */
  screen: ScreenId;
  /** The EFFECTIVE screen the primary pane — and every piece of chrome that reads "which screen
   *  is this" (Rail's active highlight, the band header's title/month-nav, the fold TBB strip's
   *  compact styling, the Start/Settings content switch below, the widget-settings reset effect)
   *  — should treat as current (PR6 Task 5). Computed once in App via `primaryScreenFor(screen,
   *  editReturn)` (panel.ts, Task 1): while the Add pane is open this stays whatever screen Add
   *  was opened FROM, so none of the above ever flashes to an "Add" title/state and back — from
   *  their point of view, the primary screen never left. */
  primaryScreen: ScreenId;
  nav: (s: ScreenId) => void;
  month: string;
  prev: () => void;
  next: () => void;
  reportsView: ReportView;
  envView: { envelopeId: string; month: string } | null;
  /** PR6b Task 3: the account-pane selection (D2) — App-owned, like `envView` (unlike
   *  `widgetSettings`, which is WideShell-local): its openers (`AccountsScreen` rows, `Rail`
   *  rows) both render OUTSIDE this component, so WideShell-local state would need a context
   *  channel anyway. NOT URL-serialised (no phone-parity route exists for it). */
  acctView: { accountId: string } | null;
  // Task 1's `panelFallbacks` bag field (App's eager, unfiltered `firstEnvelopeId`/`firstAccountId`/
  // `firstTxnId` table) is GONE as of design parity wave C task 3 — the txn kind needs the FILTERED
  // ordering (panel.ts's own comment), so this component now calls `panelFallbacks` (the function,
  // aliased `computePanelFallbacks` below) itself with the real inputs; App still computes its own
  // copy for the two consumers that render outside this shell (`AccountsScreen`'s row highlight,
  // Budget's `selectedEnvelopeId` — both fine with the unfiltered table, since neither depends on
  // transaction filtering at all) but no longer threads it through here.
  openTxns: (f?: { envId?: string; accId?: string; envIds?: ReadonlySet<string>; catId?: string; placeId?: string }) => void;
  panelClosed: boolean;
  setEnvView: (v: null) => void;
  /** Raw setter — the same `setEnvView`-decides-when pattern this bag already documents;
   *  `closePanel` below is the only caller. */
  setAcctView: (v: null) => void;
  /** Widened from Task 4's `(v: "overview") => void` (the only call `closePanel` below made):
   *  Task 6's panel report variant needs App's REAL `reportsView` setter, so a second
   *  `ReportsScreen` inside the panel can resolve its own back chevron the same way `closePanel`
   *  does. Still the exact same underlying `setState<ReportView>` App has always passed here —
   *  only the type at this boundary grows to match. */
  setReportsView: (v: ReportView) => void;
  setPanelClosed: (closed: boolean) => void;
  /** Task 5's rail card + fold strip need the same `state` every screen already renders from —
   *  App only reaches this branch once `state` exists (`wide`'s own definition), so the call
   *  site passes it with a `!` rather than this type carrying `| undefined` everywhere. */
  state: StateResponse;
  onQuickAdd: (kind: "transfer" | "import" | "suggest") => void;
  onFillGoals: () => void;
  onInstall: () => void;
  /** Task 6: the panel's report variant needs the same envelope/transaction-edit/day-select
   *  entry points the primary pane's `ReportsScreen` already uses — the SAME App functions, so
   *  opening an envelope or editing a transaction from a report inside the panel behaves
   *  identically to doing it from the hub in the primary pane. */
  onOpenEnvelope: (envId: string, month: string) => void;
  onEditTxn: (t: Transaction) => void;
  monthDay: string | null;
  onSelectDay: (date: string | null) => void;
  /** Task 6: the wide Home board's own callbacks — the SAME functions Start's phone stack already
   *  uses for its report-backed widgets (`App.openReports`/the `onOpenMonthDay` deep link), so a
   *  tile behaves identically whether it renders inside `WideHome` or the phone stack. */
  onOpenReport: (tab: ReportTab) => void;
  onOpenMonthDay: (date: string) => void;
  /** Task 6: `WideHome`'s board edit-mode toggle, lifted to `App` the same way Start's/Budget's
   *  `editWidgets`/`manageOpen` were (Task 3's pattern) — the band right-slot (below) reads and
   *  flips it, `WideHome` only reads it. */
  boardEdit: boolean;
  /** PR6 Task 2 wired these, Task 5 makes them live: the panel's `add` kind renders `AddScreen`
   *  from App's OWN edit/preset state — the same fields `screenEl`'s phone-column `AddScreen`
   *  already reads (App.tsx). Task 5 removed the `wide && screen !== "addExpense"` gate that used
   *  to keep `WideShell` from ever mounting while `screen === "addExpense"`, so these now flow
   *  into a real, reachable pane rather than sitting unused. */
  editTxn: Transaction | null;
  addPreset: { tab?: AddTab; importSheet?: boolean };
  /** The `add` pane's ✕/back semantics (App's `doneEdit`) — `closePanel` below calls this for the
   *  `add` kind instead of `setPanelClosed(true)`, since closing Add derives back to whatever
   *  pane was open underneath it (D2) rather than collapsing the panel. */
  onDoneEdit: () => void;
  /** PR6 Task 5: the band header's "+ Add" button opens Add through THIS entry point, never
   *  `nav("addExpense")` — `nav` unconditionally clears `envView`, which would silently discard
   *  an open envelope pane every time Add is opened, breaking D2's push semantics (opening Add
   *  over an open envelope pane must NOT clear it, so closing Add derives back to the envelope
   *  for free). Defined in App.tsx as `openAddWide`. */
  onAddWide: () => void;
  /** Owner round 3 item 20: `Rail`'s account rows SELECT + open the account panel WITHOUT
   *  navigating (App.tsx's `selectRailAccount`) — replaces PR6b Task 3's nav-then-select
   *  `openAccount` binding, which stays wired to `AccountsScreen`'s own rows only (App.tsx). */
  onSelectAccount: (id: string) => void;
  /** PR6b Task 4: the account pane's OWN recent-list edit entry point — deliberately separate
   *  from `onEditTxn` above (that one's `editReturn` is hardcoded "reports" for the panel's
   *  report-subview instance; reusing it here reopened Reports behind the edit takeover and lost
   *  `acctView` on save — reproduced live, App.tsx's `editAccountTxn`/`acctViewBeforeEditRef`). */
  onEditAccountTxn: (t: Transaction) => void;
  /** Design parity wave C task 2: the envelope pane's OWN recent-list edit entry point — same
   *  reason as `onEditAccountTxn` above (the shared `onEditTxn`'s hardcoded "reports" return
   *  screen would be wrong here too), but this one does NOT need a restore-ref: `envView`
   *  round-trips through the URL, so `doneEdit`'s `history.back()` restores both the originating
   *  screen and the envelope pane on its own (App.tsx's `editEnvelopeTxn` has the full case). */
  onEditEnvelopeTxn: (t: Transaction) => void;
  /** Design parity wave A close, item 9: the Transactions band caption's own inputs — App's lifted
   *  `txQuery`/`txFilters` state, the SAME values `TransactionsScreen` filters its list with (see
   *  that component's own props). Threaded as plain data (zero eager-bundle cost); the filtering
   *  itself happens below, inside this lazy chunk. */
  txQuery: string;
  txFilters: TransactionFilters;
  /** Design parity wave C task 3: the `txn` pane's own selection (D2) — App-owned, `acctView`'s
   *  exact pattern (a FRESH `{ txnId }` object per row tap, for the by-reference reopen effect
   *  below; not URL-serialised, no phone route exists for it). Unlike `acctView`, `nav()` never
   *  resets this on ordinary navigation — its only reset path is the vanish effect below (this
   *  component owns the filter pipeline that can tell "still in the current filtered list" from
   *  "dropped by a month/search/filter change"), so an edit-and-return round trip through the Add
   *  pane needs no restore-ref the way `acctViewBeforeEditRef` gives `acctView` (App.tsx never
   *  touches `txnView` on that path at all, so it simply survives it). */
  txnView: { txnId: string } | null;
  /** Raw setter — the same `setEnvView`/`setAcctView`-decides-when pattern this bag already
   *  documents; `closePanel` and the vanish effect below are the only callers. Selecting a row is a
   *  *different* App entry point (`Transactions.tsx`'s own `onSelectTxn` prop, wired directly at
   *  the primary-pane call site — the row lives in the PRIMARY pane, not this shell's bag). */
  setTxnView: (v: null) => void;
  /** Design parity wave C task 3: the txn detail card's OWN Edit entry point. Not a NEW `editReturn`
   *  shape — the SAME `(t) => editTxnFrom(t, "transactions")` binding `TransactionsScreen`'s own
   *  primary-pane row click already uses (App.tsx's `editTxnFromList`), reused verbatim rather than
   *  the shared `onEditTxn` above (whose `editReturn` is hardcoded "reports" for the panel's report
   *  subview and would flash the primary pane there instead). */
  onEditTxnPanel: (t: Transaction) => void;
  /** Design parity wave C task 3, owner rule 2: Duplicate opens the Add pane PREFILLED as a new
   *  transaction cloned from this row — no direct ledger write (App.tsx's `duplicateTxnFromPanel`,
   *  `addPreset.duplicateFrom`'s own preset-mechanics rung, `txnToDuplicatePayload`'s exact
   *  today's-date/no-tag/no-sourceRef/cleared-allocation transform). `editTxn` stays null
   *  throughout, so submit's existing create path is what an explicit Save actually runs. */
  onDuplicateTxnPanel: (t: Transaction) => void;
};

/**
 * The wide app frame (spec §5–§10): a fixed nav rail, a flexing primary column with its own
 * band header, and a fixed-but-clamped right panel whose content is `resolvePanel`'s pure
 * derivation of current App state — never a separate selection to keep in sync.
 *
 * Entirely behind the `LazyChunk`/`lazy()` boundary App.tsx installs — the phone bundle never
 * pays for anything in this file.
 *
 * `rightSlot` defaults to `null` (band renders without the pencil shortcut) so a caller that
 * has nothing to offer (a future screen with no per-screen edit action) never has to construct
 * one. App.tsx now DOES pass a computed value on every screen it renders wide (§13's contract:
 * Start's "Edit widgets" pencil, Budget's "Manage envelopes" pencil, `null` elsewhere) — restored
 * once the widget-edit-sheet extraction (pr4-context.md header; the pull-forward of PR5 Task 1)
 * bought back the §3f headroom this needed. This default is what keeps that wiring a one-line
 * addition at the call site rather than a required prop everywhere.
 *
 * PR6 Task 6 — sheet triage sweep (D4: every current `Sheet`/portal overlay keeps TODAY's
 * presentation in every mode THIS PR, over the shell as a centered modal strip with a full-shell
 * backdrop; v3's converted panes are commissioned as PR6b, not this file):
 *
 * | Surface                                                          | Host today | Wide behaviour this PR | Eventual home |
 * |-------------------------------------------------------------------|------------|------------------------|---------------|
 * | EnvActionsSheet                                                    | Sheet      | phone-only (PR4 §7 fork) | stays phone-only |
 * | EnvEdit / EnvManageSheet (Budget)                                  | Sheet      | pane surface (PR6b)    | — |
 * | BudgetSuggestSheet / FillGoalsSheet                                | Sheet      | pane surface (PR6b)    | — |
 * | AmountPadSheet / DateSheet / AccountPickerSheet / EnvelopePickerSheet (Add) | Sheet | sheet (portals past this panel's transform — see `chrome.tsx`'s `Sheet`) | popovers on desktop (PR6b) |
 * | TransactionFilterSheet                                             | Sheet      | sheet                  | possibly inline filters on wide |
 * | ImportSheet                                                        | portal, full-screen | unchanged    | unchanged |
 * | IconColorPicker                                                    | portal     | unchanged              | unchanged |
 * | AccountEditSheet (`AccountEdit`, row edits + "New account")     | Sheet      | pane surface (PR6b)    | — |
 * | ReconcileSheet (`AccountsWidget`'s per-account sheet + `AccountPanel`'s Reconcile action) | Sheet (phone-only reach — no wide UI could open it before PR6b) | pane surface (PR6b) | — |
 * | AiConsentSheet / InstallSheet / DataSection sheets / EditWidgetsSheet | Sheet | sheet          | EditWidgetsSheet → PR5's `widgets` pane |
 * | `UpdatePrompt`                                                     | fixed, viewport-centered on phone | fold: anchored to the primary pane's measured rect (this file, below) — MEASURED to collide with this panel at 1104x992 before the fix; desktop: replaced by the rail's own update card (design-parity wave A, task A4) | — (closed) |
 *
 * Verified live (throwaway stack, 1440x900 + 1104x992): every Sheet opened from panel-hosted
 * content (Add's pickers) portals to `document.body` and stays viewport-centered with a
 * full-shell backdrop even mid-transition (probed at the exact first frame of this panel's own
 * open animation — `transform`/`opacity` still at their closed starting values); Sheets opened
 * from the primary pane were never at risk (no transformed ancestor) and are unaffected. Escape
 * while focus sits inside the Add pane closes it and returns focus to `[data-panel-toggle]`
 * (PR4's stranded-focus fix, landed in Task 5, re-verified here for both panel-hosted cases).
 */
export function WideShell({ bag, rightSlot = null, children }: { bag: WideShellBag; rightSlot?: RightSlot; children: ReactNode }) {
  const {
    mode,
    screen,
    primaryScreen,
    nav,
    month,
    prev,
    next,
    reportsView,
    envView,
    acctView,
    openTxns,
    panelClosed,
    setEnvView,
    setAcctView,
    setReportsView,
    setPanelClosed,
    state,
    onQuickAdd,
    onFillGoals,
    onInstall,
    onOpenEnvelope,
    onEditTxn,
    monthDay,
    onSelectDay,
    onOpenReport,
    onOpenMonthDay,
    boardEdit,
    editTxn,
    addPreset,
    onDoneEdit,
    onAddWide,
    onSelectAccount,
    onEditAccountTxn,
    onEditEnvelopeTxn,
    txQuery,
    txFilters,
    txnView,
    setTxnView,
    onEditTxnPanel,
    onDuplicateTxnPanel,
  } = bag;
  const C = useTheme();
  const { t, tp } = useT();
  // Design parity wave A close, item 9 (design v3:4351's `headerRight`, the "shown" branch): the
  // SAME query+filter pipeline `TransactionsScreen` uses for its own list, gated to the one screen
  // that needs it (mirrors App.tsx's `globalNetTotal` gate for Accounts/Reports). Design parity
  // wave C task 3 widens this from a bare count to the filtered ARRAY itself — the txn kind's
  // fallback (below) and its vanish effect both need "the same filtered ordering the list
  // renders", not just its length, and this is the one place that pipeline already runs.
  const filteredTransactions = useMemo<StateResponse["transactions"]>(() => {
    if (primaryScreen !== "transactions") return [];
    const index = createTransactionSearchIndex({ accounts: state.accounts, envelopes: state.envelopes, categories: state.categories, places: state.places });
    return state.transactions.filter((tx) => matchesTransactionQuery(tx, txQuery, index) && matchesTransactionFilters(tx, txFilters));
  }, [primaryScreen, state.accounts, state.envelopes, state.categories, state.places, state.transactions, txQuery, txFilters]);
  const rightSlotEffective: RightSlot =
    primaryScreen === "transactions" ? { kind: "caption", text: tp("{n} transaction shown | {n} transactions shown", filteredTransactions.length) } : rightSlot;
  const [rootRef, rootW] = useElementWidth<HTMLDivElement>(mode === "desktop" ? 1440 : 1104);
  const paneW = paneWidthFor(mode, rootW);
  // The wide board's gear target (Task 6) — WideShell's OWN local selection, not lifted to App:
  // nothing outside this component needs it (unlike `envView`/`reportsView`, which the URL/deep-
  // link machinery also reads). Reset whenever `screen` changes away from "start" so a stale
  // selection can never resurface the settings panel on an unrelated later visit to Home —
  // `resolvePanel` is also defensive about this (panel.ts), but this is the actual discipline.
  const [widgetSettings, setWidgetSettings] = useState<WideWidgetId | null>(null);
  // Owner round 6 item 28: the board's add-widget picker — WideShell-local for exactly the reasons
  // `widgetSettings` above is (nothing outside the wide shell needs it), and reset by the same
  // effect below. Boolean, not a selection: the candidates are derived from the replica by the
  // panel body that renders them, so there is nothing here that could go stale against the board.
  const [widgetPicker, setWidgetPicker] = useState(false);
  useEffect(() => {
    // `primaryScreen`, not raw `screen` (PR6 Task 5): opening Add over Start with the widgets
    // panel selected must NOT clear that selection — `primaryScreen` stays "start" throughout
    // (Add lives in the OTHER pane), so this effect never fires just because Add opened/closed.
    if (primaryScreen !== "start") {
      setWidgetSettings(null);
      setWidgetPicker(false);
    }
  }, [primaryScreen]);
  // Leaving edit mode closes the picker with the tile that opened it — the board's own chrome
  // vanishes at that moment (WideHome renders the "+" tile only while `boardEdit`), and a picker
  // that outlived its affordance would keep placing widgets from a board the user is done editing.
  // The design ties the two together the same way (v3:3113 clears `homeAddOpen` with `homeEdit`).
  useEffect(() => {
    if (!boardEdit) setWidgetPicker(false);
  }, [boardEdit]);
  // Design parity wave C task 3: the txn kind's OWN fallback table — `panelFallbacks` (the bag
  // field, computed eagerly by App from the UNFILTERED ledger) stays correct for its other two
  // fields, but `firstTxnId` needs "the same filtered ordering the list renders" (the brief's own
  // words); this lazy chunk already builds that list above, so it is the one place that can call
  // the pure derivation again with the right input rather than patching the bag's own value.
  const fallbacksForPanel = useMemo(
    () => computePanelFallbacks({ envelopes: state.envelopes, groups: state.groups, accounts: state.accounts }, month, filteredTransactions),
    [state.envelopes, state.groups, state.accounts, month, filteredTransactions],
  );
  const view = resolvePanel({ screen, reportsView, envView, widgetSettings, widgetPicker, acctView, txnView }, fallbacksForPanel);
  const primaryRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // PR6 Task 2: both panes' measured geometry, for `InWideShell`'s `WideHostInfo.rects` —
  // `DockedNumpad`'s wide anchor (Task 3) needs a real viewport-relative rect, not the panel's
  // OWN CSS `width` (which stays constant even while closed; only `transform`/`margin-right`
  // animate it out of view — see the panel `<div>` below). `getBoundingClientRect()` is read
  // directly in the observer callback rather than `ResizeObserverEntry.contentRect` (which is
  // offset FROM the observed box, not a viewport position). `panelClosed` is an explicit
  // dependency — and forces `panel: null` per PR4's contract — because the panel node's own box
  // never resizes on open/close (only its transform/margin do), so no resize entry would ever
  // fire to null it out otherwise.
  const [rects, setRects] = useState<{ primary: PaneRect; panel: PaneRect | null }>({ primary: { left: 0, width: 0 }, panel: null });
  useEffect(() => {
    const primaryEl = primaryRef.current;
    const panelEl = panelRef.current;
    const measure = () => {
      const p = primaryEl?.getBoundingClientRect();
      const panelBox = !panelClosed ? panelEl?.getBoundingClientRect() : undefined;
      setRects({
        primary: p ? { left: p.left, width: p.width } : { left: 0, width: 0 },
        panel: panelBox ? { left: panelBox.left, width: panelBox.width } : null,
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (primaryEl) ro.observe(primaryEl);
    if (panelEl) ro.observe(panelEl);
    return () => ro.disconnect();
  }, [panelClosed]);

  // PR6b Task 1: the pane-surface host — a portal TARGET inside the panel column plus a
  // registration stack, so `Surface` (chrome.tsx) can render a `Sheet`-signature body as a panel
  // overlay instead. `surfaceNode` is set by the ref callback on the surfaces `<div>` below (null
  // for the very first frame). `surfaceStack` is a plain array of `{close}` handles — the top of
  // the stack is what Escape/the band toggle close; `register` reopens a collapsed panel (the
  // surface analogue of the selection-reopen effect below) since a surface must never mount
  // invisibly (the `add` kind's own lesson, `selection` below).
  const [surfaceNode, setSurfaceNode] = useState<HTMLElement | null>(null);
  const [surfaceStack, setSurfaceStack] = useState<ReadonlyArray<{ close: () => void }>>([]);
  const surfaceHost = useMemo<PaneSurfaceHost>(
    () => ({
      node: surfaceNode,
      register: (s) => {
        setSurfaceStack((st) => [...st, s]);
        setPanelClosed(false);
        return () => setSurfaceStack((st) => st.filter((x) => x !== s));
      },
    }),
    // deliberately NOT `rects` (`surfaceHost` would otherwise recompute, and re-register nothing —
    // but every consumer's `useEffect(() => host.register(...), [host])` would then re-fire —
    // on every resize).
    [surfaceNode],
  );

  // PR6 Task 5 fix, verified by reproducing the SAME gap on PR4's own `envelope` kind (not
  // introduced by this task, but never exercisable through it before Add existed to test it
  // against): `onPanelTransitionEnd` below restores focus to the toggle only when a CSS
  // transition on THIS pane's transform/margin/opacity actually fires — which only happens when
  // `panelClosed` flips to `true`. Every kind but `empty` closes by clearing its OWN selection
  // instead (`setEnvView(null)`, `onDoneEdit()`, …), never touching `panelClosed` at all, so that
  // handler never ran for them — closing the envelope pane (or, now, Add) via the ✕ button or
  // Escape while focus sat inside it left focus stranded on `<body>` once the focused element
  // unmounted. Checked HERE, synchronously, before the state change below — the one place common
  // to every kind's ✕/Escape close (both call this same function) — so it covers all of them,
  // not just `add`. The toggle button's OWN direct collapse (`onTogglePanel` in the band header)
  // bypasses this function for every kind EXCEPT `add` (which routes through here too — see that
  // prop's own comment) and keeps relying on `onPanelTransitionEnd` for the rest, which still
  // needs to exist for that path — this doesn't replace it, it plugs the gap that path never had.
  //
  // PR6 Task 5 fix: a Sheet opened from panel-hosted content (Add's pickers, ImportSheet's own
  // Sheet/AiConsentSheet) now portals to `document.body` (chrome.tsx's `Sheet` — the panel's own
  // transform breaks `position:fixed`), so it is a REACT descendant of the panel but not a DOM
  // one. Plain `panelRef.current.contains(...)` would treat focus inside it as "outside the
  // panel" for every check below; `data-wide-panel-portal` (set only on that portal's wrapper)
  // closes the gap.
  const panelContains = (el: Element | null): boolean => !!el && (!!panelRef.current?.contains(el) || !!el.closest("[data-wide-panel-portal]"));

  const closePanel = () => {
    const active = document.activeElement;
    if (panelContains(active)) document.querySelector<HTMLElement>("[data-panel-toggle]")?.focus();
    // PR6b: an open surface is a strictly-above overlay (D1) — closing "the panel" while one is
    // open must close only the TOPMOST surface, revealing whatever `resolvePanel` derives
    // underneath, unchanged. No marker needed for the focus check above: a surface lives inside
    // `panelRef`'s own DOM subtree (unlike a portaled `Sheet`), so `panelContains` already covers
    // it natively.
    const topSurface = surfaceStack.at(-1);
    if (topSurface) {
      topSurface.close();
      return;
    }
    // Task 1 (owner rule 1): `envelope`/`report`/`account` now resolve to real content even with
    // no explicit selection (`source: "fallback"` — panel.ts's `resolvePanel`). Clearing a
    // selection that was never made is a no-op (the fallback would just resolve again, unchanged)
    // — so a fallback's ✕/Escape COLLAPSES the panel instead, exactly like the plain `else` branch
    // below always has for `empty`. A real `source: "selection"` keeps clearing, which — since the
    // fallback now backs it up — pops to the contextual fallback shown underneath rather than to a
    // blank placeholder.
    if (view.kind === "envelope") {
      if (view.source === "selection") setEnvView(null);
      else setPanelClosed(true);
    } else if (view.kind === "report") {
      if (view.source === "selection") setReportsView("overview");
      else setPanelClosed(true);
    } else if (view.kind === "widgets") setWidgetSettings(null);
    else if (view.kind === "widgetPicker") setWidgetPicker(false);
    else if (view.kind === "account") {
      if (view.source === "selection") setAcctView(null);
      else setPanelClosed(true);
    } else if (view.kind === "add") onDoneEdit();
    else if (view.kind === "txn") {
      // Design parity wave C task 3: the SAME fallback-vs-selection split as `envelope`/`account`
      // above — a real pick (a row tap) pops to the fallback shown underneath; the fallback itself
      // has nothing to clear (`txnView` is already null when `source` is "fallback" — resolvePanel
      // only falls back when it was absent), so ✕/Escape there just collapses the panel.
      if (view.source === "selection") setTxnView(null);
      else setPanelClosed(true);
    } else setPanelClosed(true);
  };

  // Explicitly opening content re-opens a collapsed panel — the demo's own rule (v3:3597,
  // `openReport` forces the pane open); the band toggle stays the ONLY control that closes
  // chrome. Keyed on the selection VALUE, not just `view.kind`: rail nav can never fire it
  // (`nav()` resets both selection axes, so its resolved view is `empty` — rule 2438, closed
  // survives navigation), while a hub card, an envelope tap (App builds a fresh `envView`
  // object per tap) and a history restore into `?env`/`/reports/{tab}` all change the value —
  // including report→report switches that the kind alone would miss. Selection is compared
  // across renders (a ref, not an effect dep array) so a mere re-render of the same open
  // selection never touches `panelClosed`.
  // `add` (PR6 Task 5) needs the SAME reopen treatment, or opening Add while the panel happens to
  // be collapsed would mount the editor invisibly (translated off-screen, per the panel `<div>`'s
  // own style below) with no way to see it short of the toggle — D2's "wins over every other
  // input" is a promise about `resolvePanel`'s CONTENT resolution, not about `panelClosed`'s
  // independent visibility bit, so nothing else in this file was actually reopening it. `screen`
  // itself doesn't work as the selection value here (it's the same string `"addExpense"` before
  // AND after a second, fresh "+ Add" press — no reference change to key off), so `addPreset` is
  // used instead: every entry point into Add (`nav`, `openAddWide`, `editTxnFrom`, `onQuickAdd`'s
  // transfer/import presets, the popstate handler) sets it to a BRAND NEW object, while nothing
  // inside `AddScreen` itself (typing, tab switches, sheet opens — all local component state)
  // ever touches it, so it stays referentially stable across every re-render where Add merely
  // continues to be open.
  // `account` (PR6b Task 3) needs the SAME by-reference reopen treatment as `envelope`/`add`, for
  // the same reason: App's `openAccount` builds a FRESH `{ accountId }` object per tap (D2), so
  // re-selecting the same already-open account still reopens a manually-collapsed panel. This is
  // why the branch below reads `acctView` (the App-owned selection object) rather than
  // `view.accountId` (a plain string — re-selecting the same account would then compare equal and
  // never retrigger the effect, exactly the lesson `addPreset` already taught for `screen`).
  // Task 1: `report`'s `view.view` is now "spending" even on the FALLBACK (Reports hub, no
  // subview chosen) — reading it directly here would make a plain hub visit look like a real
  // selection and defeat the reopen guard below (`selection !== null`). `view.source` already
  // distinguishes the two cases (panel.ts) — `envelope`/`account` don't need the same treatment
  // since their underlying `envView`/`acctView` are already null exactly when `source` is
  // "fallback" (resolvePanel only falls back when the App-owned selection was absent).
  const selection =
    view.kind === "empty"
      ? null
      : view.kind === "add"
        ? addPreset
        : view.kind === "envelope"
          ? envView
          : view.kind === "widgets"
            ? view.widgetId
            : // Owner round 6 item 28: a constant is enough to reopen a manually-collapsed panel —
              // the picker is a boolean, so "it just opened" is exactly "this differs from whatever
              // was resolved a render ago". Mounting it invisibly is the `add` kind's own lesson.
              view.kind === "widgetPicker"
              ? "widgetPicker"
              : view.kind === "account"
                ? acctView
                : view.kind === "txn"
                  ? txnView
                  : view.source === "selection"
                    ? view.view
                    : null;
  const prevSelection = useRef(selection);
  useEffect(() => {
    if (selection !== null && selection !== prevSelection.current && panelClosed) setPanelClosed(false);
    prevSelection.current = selection;
  });

  // Design parity wave C task 3: `txnView`'s ONLY reset path (its own bag-field comment) — a
  // month change, a search/filter change, or a delete can each drop the selected transaction out
  // of the CURRENT filtered list without ever touching `txnView` itself (App.tsx never resets it
  // on plain navigation, unlike `envView`/`acctView` — see that comment for why no restore-ref is
  // needed for the edit round trip). Once dropped, `resolvePanel` should fall back to the real
  // first item rather than keep asserting a stale "selection" for an id nothing renders any more.
  // Gated on `primaryScreen` (matching `filteredTransactions` above, which is `[]` off-screen) so
  // leaving the Transactions screen and coming back never clears a selection that was never
  // actually invalidated — this effect only judges a selection while it can see the real list.
  useEffect(() => {
    if (primaryScreen === "transactions" && txnView && !filteredTransactions.some((tx) => tx.id === txnView.txnId)) setTxnView(null);
  }, [primaryScreen, txnView, filteredTransactions, setTxnView]);

  // WebKit/iOS: WideShell freshly mounts right after the wide "Add" phone-column takeover
  // unmounts a full-screen fixed overlay (DockedNumpad/pickers, portalled to <body>) that sat
  // ABOVE this panel — a composited (transformed) layer. WebKit can drop that layer's
  // hit-testing afterwards until a repaint (the ImportSheet editor has the same flaw); force one
  // on every fresh mount, the same way (App.tsx never mounts this component while on Add, so
  // "just mounted" already means "possibly just left it"). iPad Safari lands in `fold` mode at
  // 1180×820, so this is not desktop-only paranoia.
  useEffect(() => {
    const root = document.getElementById("root");
    if (!root) return;
    root.style.opacity = "0.9999";
    const raf = requestAnimationFrame(() => {
      root.style.opacity = "";
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  // Escape closes the panel when focus is inside it (pr4-context.md §12.5). Re-attached every
  // render (cheap — one listener) so it always closes over the CURRENT `view`/close semantics,
  // without a dependency array to keep in sync by hand.
  //
  // Attached on `document`, not `panelRef` (PR6 Task 5 fix): a portaled sheet's native keydown
  // never bubbles to `panelRef` at all (it's mounted under `document.body`, a DOM sibling, not a
  // descendant) — `panelContains` is the sole gate now, exactly as it already was in effect for
  // the in-panel case (native bubbling to `panelRef` only ever fired when focus was already
  // inside it).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // The `widgetPicker` kind (owner round 6 item 28) is the one panel view whose opener lives in
      // the OTHER pane: the board's "+" tile keeps focus in the primary pane, so `panelContains`
      // is false for it and Escape would otherwise be dead until the user clicked into the panel.
      // Gated on the RESOLVED kind, not on the raw flag, so this can never close something else
      // that happens to outrank a stale picker flag.
      if (e.key === "Escape" && (view.kind === "widgetPicker" || panelContains(document.activeElement))) closePanel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  // Focus policy (pr4-context.md §12.5): opening moves focus nowhere (non-modal). Closing, if
  // focus was inside the panel, restores it to the toggle so nothing is left stranded on a
  // hidden subtree. This covers the ONE close path `closePanel` above does NOT (see its own
  // comment): the band toggle collapsing an OPEN, content-bearing panel of a kind OTHER than
  // `add` directly (`onTogglePanel`), which flips `panelClosed` without going through
  // `closePanel` at all — the collapse's three transitions (transform/margin-right/opacity) each
  // fire this, but only the FIRST one finds focus still inside the (now-closed) panel; every
  // later firing is a no-op by construction. `closePanel`'s own synchronous check already moved
  // focus for every OTHER close (the ✕ button, Escape, and now the toggle for `add` specifically),
  // so by the time this fires for one of those, `document.activeElement` is already the toggle —
  // outside the panel — making this a harmless no-op there too.
  const onPanelTransitionEnd = (e: React.TransitionEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || !panelClosed) return;
    const active = document.activeElement;
    if (panelContains(active)) document.querySelector<HTMLElement>("[data-panel-toggle]")?.focus();
  };

  return (
    <div ref={rootRef} style={{ display: "flex", height: "100dvh", background: C.bg, fontFamily: font, overflow: "hidden" }}>
      <Rail
        mode={mode}
        screen={primaryScreen}
        onNav={nav}
        state={state}
        onQuickAdd={onQuickAdd}
        onFillGoals={onFillGoals}
        onInstall={onInstall}
        onSelectAccount={onSelectAccount}
        // Owner round 3 item 20: the rail's own row highlight follows the RESOLVED panel content,
        // not `acctView` directly — `view.kind === "account"` is true whether that came from an
        // explicit rail pick, an Accounts-screen row, or the accounts/settings fallback (no
        // explicit pick at all), and the design highlights the row in every one of those cases
        // alike (`accountRows`' own `on = st.selAcct === a.id && paneNow === "acct"`, v3:2661) —
        // never while some OTHER kind (envelope/report/txn/widgets/add) currently owns the panel.
        // `!panelClosed` matches the same collapsed-panel-has-no-highlight rule Transactions'
        // `selectedTxnId` already applies below — a collapsed panel shows nothing selected.
        selectedAccountId={!panelClosed && view.kind === "account" ? view.accountId : null}
      />
      <div ref={primaryRef} data-wide-primary style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", borderRight: `1px solid ${C.line}` }}>
        {/* Mounted inline inside BandHeader (see SyncBadge.tsx) rather than floating over the
            scrollable content below it — dead letters stay visible on wide; the user menu's
            "Sync now" is a convenience, not the alarm channel. The demo's separate band error
            pill (spec lines 198-201) is deliberately NOT implemented — one sync surface, not
            two. */}
        <BandHeader
          screen={primaryScreen}
          month={month}
          onPrev={prev}
          onNext={next}
          onAdd={onAddWide}
          onOpenSync={() => nav("settings")}
          rightSlot={rightSlotEffective}
          panelClosed={panelClosed}
          // PR6 Task 5: while the Add pane is showing, the toggle discards it (`closePanel`'s own
          // `add` branch — same semantics as phone's back gesture from Add today) instead of
          // merely collapsing the panel. A bare `setPanelClosed(true)` would hide the editor
          // without closing it: `screen` would stay `"addExpense"`, so `resolvePanel` keeps
          // resolving to `add` — nothing else here ever un-sets that, and the reopen-on-fresh-
          // `addPreset` effect (see `selection` above) has no reason to fire again, so the panel
          // would simply sit collapsed with a live, hidden, un-discardable edit behind it. Every
          // OTHER kind keeps the collapse-only behavior (the toggle is deliberately NOT the same
          // as ✕/Escape for those — see `closePanel`'s own comment for why "collapse but keep the
          // selection remembered" and "clear the selection" are different actions on purpose).
          // PR6b: an open surface extends the SAME reasoning — collapsing the panel out from under
          // a live surface (a form, reconcile) would hide it with no way back short of reopening
          // and re-navigating; `closePanel` already closes only the topmost surface (its own first
          // rung), so route the toggle there too whenever one is open.
          onTogglePanel={() => (surfaceStack.length > 0 || view.kind === "add" ? closePanel() : setPanelClosed(!panelClosed))}
          // Narrow primary = fold with the panel OPEN (~483px left of a 1104 viewport). Desktop's
          // panel-open primary (~800px at 1440) fits the full labels; so does fold with the
          // panel collapsed.
          compact={mode === "fold" && !panelClosed}
        />
        {mode === "fold" && primaryScreen !== "settings" && (
          <FoldTbbStrip state={state} screen={primaryScreen} onQuickAdd={onQuickAdd} onFillGoals={onFillGoals} onNav={nav} />
        )}
        {/* PR6 Task 2: `InWideShell` now carries `{ host, mode, rects }` instead of PR4's plain
            `true` — scoped to exactly the subtree that renders IN this pane (below the band/
            strip chrome, which reads nothing from it), so a consumer can tell which pane it's in
            rather than only "some wide pane". The panel gets its OWN provider below (`host:
            "panel"`), not this one — `UndoBar`'s wide-anchor branch (reportKit.tsx) reads it from
            panel-hosted report subscreens, which this provider does not cover; see the panel
            provider's comment for why that coverage still holds (task-7 fix round 1's finding,
            preserved by construction: every reader now sits under ONE of the two providers). */}
        <InWideShell.Provider value={{ host: "primary", mode, rects, surfaces: surfaceHost }}>
          {/* Rendered here, not as App.tsx's own sibling of `<WideShell>` (App.tsx still owns the
              PHONE instance) — a `useWideHost()`-gated branch (Task 6) needs to sit inside this
              exact provider to read `rects.primary` and anchor clear of the rail/panel; see that
              component's own comment for the measured collision this replaces. Self-contained
              (no props), so moving where it mounts is the only change this required.
              Design-parity wave A, task A4: desktop moved this surface into the rail's own update
              card (`Rail.tsx`, owner-requirements.md #3 — a rail card, not a primary-pane-anchored
              banner); fold has no rail card section (its own layout gate is a later, separate
              audit pass per wave-context.md), so fold keeps this exact anchored banner. */}
          {mode !== "desktop" && <UpdatePrompt />}
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {/* Task 6: the wide Home board replaces the phone widget stack entirely on Start — the
                `screenEl` App.tsx built for "start" (a `StartScreen` element) is still constructed
                as `children` (cheap: it's just a React element description) but never rendered
                here, so its own phone-only header/EditWidgetsSheet never mount on wide. Keyed on
                `primaryScreen` (PR6 Task 5), not raw `screen`: while Add is open over Start, the
                board must keep rendering underneath it, not be torn down for a raw-`screen`
                mismatch that would otherwise read "addExpense" here. */}
            {primaryScreen === "start" ? (
              <WideHome
                mode={mode}
                state={state}
                month={month}
                onNav={nav}
                onOpenEnvelope={onOpenEnvelope}
                onOpenTxns={openTxns}
                onQuickAdd={onQuickAdd}
                onOpenReport={onOpenReport}
                onOpenMonthDay={onOpenMonthDay}
                edit={boardEdit}
                // `setAcctView(null)` here (owner round 3 review fix, same class as App.tsx's
                // `openEnvelope`/`onSelectTxn`/reports `onView`): the widget gear is exactly as
                // explicit a pick as those, but `resolvePanel` (panel.ts) still checks `acctView`
                // BEFORE the `widgets` rung, so a stale rail account selection from earlier on
                // Home would otherwise outrank it and the panel would stay stuck on the account.
                onWidgetSettings={(id) => {
                  setWidgetSettings(id);
                  setWidgetPicker(false);
                  setAcctView(null);
                }}
                // Owner round 6 item 28: the "+" tile is as explicit a pick as the gear above, so
                // it clears the selections that outrank the board's own panel rungs — including
                // `envView` (an envelope opened from the board's own Envelopes tile would otherwise
                // keep the panel on that envelope and the "+" would look broken).
                onAddWidget={() => {
                  setWidgetPicker(true);
                  setWidgetSettings(null);
                  setEnvView(null);
                  setAcctView(null);
                }}
                onFillGoals={onFillGoals}
              />
            ) : primaryScreen === "settings" ? (
              // Design parity wave E task 3: the design's persistent two-column Settings
              // (v3:675-744) replaces the interim centered-column wrapper. `children` (App.tsx's
              // phone `SettingsScreen`) is still CONSTRUCTED above — cheap, a React element
              // description — but never rendered here, the same treatment `WideHome` already gives
              // the phone Start stack just above: its hub/header/drill-in chrome never mounts on
              // wide.
              <WideSettings mode={mode} />
            ) : (
              children
            )}
          </div>
        </InWideShell.Provider>
      </div>
      <div
        ref={panelRef}
        data-wide-panel
        role="complementary"
        aria-label={t("Details panel")}
        onTransitionEnd={onPanelTransitionEnd}
        style={{
          width: paneW,
          flex: "none",
          minWidth: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          background: C.surface,
          // relative: the anchor for the surfaces overlay `<div>` below (`position: absolute;
          // inset: 0`) — PR6b.
          position: "relative",
          transform: panelClosed ? "translateX(100%)" : "translateX(0)",
          marginRight: panelClosed ? -paneW : 0,
          opacity: panelClosed ? 0 : 1,
          transition: "transform 260ms cubic-bezier(0.4,0,0.2,1), margin-right 260ms cubic-bezier(0.4,0,0.2,1), opacity 180ms ease",
        }}
      >
        {/* This pane's own provider (`host: "panel"`): `resolvePanel`'s `report`/`envelope` kinds
            render a SECOND `ReportsScreen`/`EnvelopeScreen` instance in here (Task 6), and on wide
            a report SUBSCREEN only ever renders here — App forces the primary pane's own
            `ReportsScreen` to the "overview" hub, so that instance sits under the OTHER provider
            above. `UndoBar`'s wide-anchor branch (reportKit.tsx) reads `InWideShell` from exactly
            this panel-hosted subscreen — scoping a provider to only `children` (this pane's
            predecessor bug, task-7 fix round 1) left that toast reading the phone (centered)
            branch every time it actually mattered. */}
        <InWideShell.Provider value={{ host: "panel", mode, rects, surfaces: surfaceHost }}>
          <PanelHost
            view={view}
            onClose={closePanel}
            onOpenTxns={openTxns}
            state={state}
            month={month}
            monthDay={monthDay}
            onSelectDay={onSelectDay}
            onView={setReportsView}
            onOpenEnvelope={onOpenEnvelope}
            onFillGoals={onFillGoals}
            onEditTxn={onEditTxn}
            onEditAccountTxn={onEditAccountTxn}
            onEditEnvelopeTxn={onEditEnvelopeTxn}
            onEditTxnPanel={onEditTxnPanel}
            onDuplicateTxnPanel={onDuplicateTxnPanel}
            onPrev={prev}
            onNext={next}
            editTxn={editTxn}
            addPreset={addPreset}
            onDoneEdit={onDoneEdit}
          />
        </InWideShell.Provider>
        {/* PR6b Task 1: the pane-surface portal target — an open `Surface` (chrome.tsx) renders
            here, absolutely covering `PanelHost`'s derived content above (D1's "strictly-above
            overlay stack"). `display: none` while empty so it never intercepts pointer events
            over `PanelHost` (an empty `position: absolute; inset: 0` div would otherwise sit on
            top of every click). */}
        <div
          ref={setSurfaceNode}
          data-wide-panel-surfaces
          style={{ position: "absolute", inset: 0, zIndex: 5, display: surfaceStack.length ? "block" : "none" }}
        />
      </div>
    </div>
  );
}
