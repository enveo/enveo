import type { Transaction, WideWidgetId } from "@enveo/shared";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { StateResponse } from "../../lib/api";
import { useTheme } from "../../lib/contexts";
import { monthLabel } from "../../lib/dates";
import { type Message, msg, useT } from "../../lib/i18n";
import { Ico } from "../../lib/icons";
import { InWideShell, type PaneRect, type PaneSurfaceHost } from "../../lib/shellContext";
import { CTA, font, P } from "../../lib/theme";
import { useElementWidth } from "../../lib/useElementWidth";
import { PHONE_COL, type ViewMode } from "../../lib/viewMode";
import type { Tab as AddTab } from "../../screens/Add";
import type { ReportTab, ReportView } from "../../screens/reports/types";
import { WideHome } from "../../screens/WideHome";
import type { ScreenId } from "../chrome";
import { SyncBadge } from "../SyncBadge";
import { UpdatePrompt } from "../UpdatePrompt";
import { FoldTbbStrip } from "./FoldTbbStrip";
import { paneWidthFor } from "./geometry";
import { PanelHost } from "./PanelHost";
import { resolvePanel } from "./panel";
import { Rail } from "./Rail";

/** One right-slot contract (pr4-context.md §13) — computed by App, rendered here verbatim. */
type RightSlot = { label: string; ariaLabel: string; onClick: () => void } | null;

const SCREEN_TITLE: Record<ScreenId, Message> = {
  start: msg("Home"),
  budget: msg("Budget"),
  transactions: msg("Transactions"),
  accounts: msg("Accounts"),
  reports: msg("Reports"),
  // Unreachable here even now that Add IS a wide pane (PR6 Task 5): `BandHeader` only ever
  // receives `primaryScreen` (App.tsx), which resolves to `editReturn` while Add is open and so
  // is never itself "addExpense" (`editReturn` is never set to that value — see `openAddWide`).
  addExpense: msg("Add"),
  settings: msg("Settings"),
};

const PENCIL_D = "M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.1 2.1 0 013 3L12 15l-4 1 1-4 9.5-9.5z";

/** Hollow-two-column glyph for the panel toggle (the mock's bar redrawn as inline SVG — colors
 *  via `style`, never a presentation attribute, per the house SVG-color rule). */
function PanelToggleGlyph({ color }: { color: string }) {
  return (
    <svg width="18" height="14" viewBox="0 0 18 14" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="16" height="12" rx="2.5" style={{ stroke: color }} strokeWidth="1.4" />
      <line x1="11.5" y1="1" x2="11.5" y2="13" style={{ stroke: color }} strokeWidth="1.4" />
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
        gap: "6px 16px",
        padding: `14px ${P}px`,
        borderBottom: `1px solid ${C.line}`,
        flexShrink: 0,
      }}
    >
      <span style={{ fontSize: 18, fontWeight: 700, color: C.text, flexShrink: 0 }}>{t(SCREEN_TITLE[screen])}</span>
      {screen !== "settings" && (
        <div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
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
            <Ico d="M15 19l-7-7 7-7" size={16} color={C.soft} />
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
            <Ico d="M9 5l7 7-7 7" size={16} color={C.soft} />
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
        {rightSlot && (
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
              padding: "0 10px",
              borderRadius: 8,
              border: "none",
              background: "transparent",
              color: C.soft,
              cursor: "pointer",
              flexShrink: 0,
              justifyContent: "center",
            }}
          >
            <Ico d={PENCIL_D} size={15} color={C.soft} />
            {!compact && <span style={{ fontSize: 13, fontWeight: 600 }}>{rightSlot.label}</span>}
          </button>
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
            flexShrink: 0,
            borderRadius: 8,
            border: "none",
            background: panelClosed ? "transparent" : C.inset,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <PanelToggleGlyph color={C.soft} />
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
  /** PR6b Task 3: `Rail`'s account rows deep-link straight into the account pane (a cross-screen
   *  jump — the rail hides on the Accounts screen itself) — same nav-then-select batch as
   *  `openAccount` (App.tsx), threaded through to `Rail` below. */
  onOpenAccount: (id: string) => void;
  /** PR6b Task 4: the account pane's OWN recent-list edit entry point — deliberately separate
   *  from `onEditTxn` above (that one's `editReturn` is hardcoded "reports" for the panel's
   *  report-subview instance; reusing it here reopened Reports behind the edit takeover and lost
   *  `acctView` on save — reproduced live, App.tsx's `editAccountTxn`/`acctViewBeforeEditRef`). */
  onEditAccountTxn: (t: Transaction) => void;
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
 * | AiConsentSheet / InstallSheet / DataSection sheets / EditWidgetsSheet / Accounts sheets | Sheet | sheet | EditWidgetsSheet → PR5's `widgets` pane; Accounts sheets → PR6b |
 * | `UpdatePrompt`                                                     | fixed, viewport-centered on phone | anchored to the primary pane's measured rect on wide (this file, below) — MEASURED to collide with this panel at 1104x992 before the fix | — (closed) |
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
    onOpenAccount,
    onEditAccountTxn,
  } = bag;
  const C = useTheme();
  const { t } = useT();
  const [rootRef, rootW] = useElementWidth<HTMLDivElement>(mode === "desktop" ? 1440 : 1104);
  const paneW = paneWidthFor(mode, rootW);
  // The wide board's gear target (Task 6) — WideShell's OWN local selection, not lifted to App:
  // nothing outside this component needs it (unlike `envView`/`reportsView`, which the URL/deep-
  // link machinery also reads). Reset whenever `screen` changes away from "start" so a stale
  // selection can never resurface the settings panel on an unrelated later visit to Home —
  // `resolvePanel` is also defensive about this (panel.ts), but this is the actual discipline.
  const [widgetSettings, setWidgetSettings] = useState<WideWidgetId | null>(null);
  useEffect(() => {
    // `primaryScreen`, not raw `screen` (PR6 Task 5): opening Add over Start with the widgets
    // panel selected must NOT clear that selection — `primaryScreen` stays "start" throughout
    // (Add lives in the OTHER pane), so this effect never fires just because Add opened/closed.
    if (primaryScreen !== "start") setWidgetSettings(null);
  }, [primaryScreen]);
  const view = resolvePanel({ screen, reportsView, envView, widgetSettings, acctView });
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
    if (view.kind === "envelope") setEnvView(null);
    else if (view.kind === "report") setReportsView("overview");
    else if (view.kind === "widgets") setWidgetSettings(null);
    else if (view.kind === "account") setAcctView(null);
    else if (view.kind === "add") onDoneEdit();
    else setPanelClosed(true);
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
  const selection =
    view.kind === "empty"
      ? null
      : view.kind === "add"
        ? addPreset
        : view.kind === "envelope"
          ? envView
          : view.kind === "widgets"
            ? view.widgetId
            : view.kind === "account"
              ? acctView
              : view.view;
  const prevSelection = useRef(selection);
  useEffect(() => {
    if (selection !== null && selection !== prevSelection.current && panelClosed) setPanelClosed(false);
    prevSelection.current = selection;
  });

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
      if (e.key === "Escape" && panelContains(document.activeElement)) closePanel();
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
        onOpenAccount={onOpenAccount}
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
          rightSlot={rightSlot}
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
              (no props), so moving where it mounts is the only change this required. */}
          <UpdatePrompt />
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
                onWidgetSettings={setWidgetSettings}
              />
            ) : primaryScreen === "settings" ? (
              // Centered column on the WRAPPER, not inside Settings.tsx (zero phone deltas —
              // Settings itself renders identically in every mode). v3's two-column Settings is
              // deferred (D-list, PR6 plan); this is the interim "hosted as-is" treatment.
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  display: "flex",
                  flexDirection: "column",
                  overflow: "hidden",
                  maxWidth: PHONE_COL + 120,
                  margin: "0 auto",
                  width: "100%",
                }}
              >
                {children}
              </div>
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
