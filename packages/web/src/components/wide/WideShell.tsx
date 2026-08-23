import type { Transaction, WideWidgetId } from "@enveo/shared";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { StateResponse } from "../../lib/api";
import { useTheme } from "../../lib/contexts";
import { monthLabel } from "../../lib/dates";
import { type Message, msg, useT } from "../../lib/i18n";
import { Ico } from "../../lib/icons";
import { InWideShell, type PaneRect } from "../../lib/shellContext";
import { CTA, font, P } from "../../lib/theme";
import { useElementWidth } from "../../lib/useElementWidth";
import type { ViewMode } from "../../lib/viewMode";
import type { Tab as AddTab } from "../../screens/Add";
import type { ReportTab, ReportView } from "../../screens/reports/types";
import { WideHome } from "../../screens/WideHome";
import type { ScreenId } from "../chrome";
import { SyncBadge } from "../SyncBadge";
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
  addExpense: msg("Add"), // unreachable here — wide renders addExpense as the phone takeover (App.tsx)
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
}) {
  const C = useTheme();
  const { t, lang } = useT();
  const toggleLabel = panelClosed ? t("Show the side panel") : t("Hide the side panel");
  return (
    // data-wide-band: stable test hook (same idiom as data-wide-primary/-panel below) — the
    // verification playbook's touch-target sweep selects `[data-wide-band] button`.
    <div
      data-wide-band
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
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
      <div style={{ flex: 1 }} />
      {/* A genuine flex child of the band header, never an overlay above content — see the
          SyncBadge.tsx file header for why `topOffset`-over-the-primary-pane was replaced. */}
      <SyncBadge inline onOpenSync={onOpenSync} />
      {rightSlot && (
        <button
          onClick={rightSlot.onClick}
          aria-label={rightSlot.ariaLabel}
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
          }}
        >
          <Ico d={PENCIL_D} size={15} color={C.soft} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>{rightSlot.label}</span>
        </button>
      )}
      <button
        onClick={onAdd}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          minHeight: 30,
          padding: "0 14px",
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
        {t("Add")}
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
  screen: ScreenId;
  nav: (s: ScreenId) => void;
  month: string;
  prev: () => void;
  next: () => void;
  reportsView: ReportView;
  envView: { envelopeId: string; month: string } | null;
  openTxns: (f?: { envId?: string; accId?: string; envIds?: ReadonlySet<string>; catId?: string; placeId?: string }) => void;
  panelClosed: boolean;
  setEnvView: (v: null) => void;
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
  /** PR6 Task 2: the panel's `add` kind renders `AddScreen` from App's OWN edit/preset state —
   *  same fields `screenEl`'s phone-column `AddScreen` already reads (App.tsx). Threading them
   *  through here is inert until a later task removes the `wide && screen !== "addExpense"` gate
   *  (App.tsx) that keeps `WideShell` from ever mounting while `screen === "addExpense"` today —
   *  same "wired, unreached" precedent as Task 1's `add` `PanelView` kind. */
  editTxn: Transaction | null;
  addPreset: { tab?: AddTab; importSheet?: boolean };
  /** The `add` pane's ✕/back semantics (App's `doneEdit`) — `closePanel` below calls this for the
   *  `add` kind instead of `setPanelClosed(true)`, since closing Add derives back to whatever
   *  pane was open underneath it (D2) rather than collapsing the panel. */
  onDoneEdit: () => void;
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
 */
export function WideShell({ bag, rightSlot = null, children }: { bag: WideShellBag; rightSlot?: RightSlot; children: ReactNode }) {
  const {
    mode,
    screen,
    nav,
    month,
    prev,
    next,
    reportsView,
    envView,
    openTxns,
    panelClosed,
    setEnvView,
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
    if (screen !== "start") setWidgetSettings(null);
  }, [screen]);
  const view = resolvePanel({ screen, reportsView, envView, widgetSettings });
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

  const closePanel = () => {
    if (view.kind === "envelope") setEnvView(null);
    else if (view.kind === "report") setReportsView("overview");
    else if (view.kind === "widgets") setWidgetSettings(null);
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
  // `add` (PR6 Task 1) has no selection VALUE of its own to key the reopen rule on — it is
  // unreached here today (App.tsx never mounts `WideShell` while `screen === "addExpense"`), and
  // when a later task does wire it in, `resolvePanel` already forces `add` open unconditionally
  // (D2's push semantics), so there is nothing for this rule to reopen.
  const selection =
    view.kind === "empty" || view.kind === "add" ? null : view.kind === "envelope" ? envView : view.kind === "widgets" ? view.widgetId : view.view;
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
  useEffect(() => {
    const node = panelRef.current;
    if (!node) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && node.contains(document.activeElement)) closePanel();
    };
    node.addEventListener("keydown", onKeyDown);
    return () => node.removeEventListener("keydown", onKeyDown);
  });

  // Focus policy (pr4-context.md §12.5): opening moves focus nowhere (non-modal). Closing, if
  // focus was inside the panel, restores it to the toggle so nothing is left stranded on a
  // hidden subtree. One `onTransitionEnd` covers every kind — the collapse's three transitions
  // (transform/margin-right/opacity) each fire this, but only the FIRST one finds focus still
  // inside the (now-closed) panel; every later firing is a no-op by construction.
  const onPanelTransitionEnd = (e: React.TransitionEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || !panelClosed) return;
    const active = document.activeElement;
    if (active && panelRef.current?.contains(active)) document.querySelector<HTMLElement>("[data-panel-toggle]")?.focus();
  };

  return (
    <div ref={rootRef} style={{ display: "flex", height: "100dvh", background: C.bg, fontFamily: font, overflow: "hidden" }}>
      <Rail mode={mode} screen={screen} onNav={nav} state={state} onQuickAdd={onQuickAdd} onFillGoals={onFillGoals} onInstall={onInstall} />
      <div ref={primaryRef} data-wide-primary style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", borderRight: `1px solid ${C.line}` }}>
        {/* Mounted inline inside BandHeader (see SyncBadge.tsx) rather than floating over the
            scrollable content below it — dead letters stay visible on wide; the user menu's
            "Sync now" is a convenience, not the alarm channel. The demo's separate band error
            pill (spec lines 198-201) is deliberately NOT implemented — one sync surface, not
            two. */}
        <BandHeader
          screen={screen}
          month={month}
          onPrev={prev}
          onNext={next}
          onAdd={() => nav("addExpense")}
          onOpenSync={() => nav("settings")}
          rightSlot={rightSlot}
          panelClosed={panelClosed}
          onTogglePanel={() => setPanelClosed(!panelClosed)}
        />
        {mode === "fold" && screen !== "settings" && (
          <FoldTbbStrip state={state} screen={screen} onQuickAdd={onQuickAdd} onFillGoals={onFillGoals} onNav={nav} />
        )}
        {/* PR6 Task 2: `InWideShell` now carries `{ host, mode, rects }` instead of PR4's plain
            `true` — scoped to exactly the subtree that renders IN this pane (below the band/
            strip chrome, which reads nothing from it), so a consumer can tell which pane it's in
            rather than only "some wide pane". The panel gets its OWN provider below (`host:
            "panel"`), not this one — `UndoBar`'s wide-anchor branch (reportKit.tsx) reads it from
            panel-hosted report subscreens, which this provider does not cover; see the panel
            provider's comment for why that coverage still holds (task-7 fix round 1's finding,
            preserved by construction: every reader now sits under ONE of the two providers). */}
        <InWideShell.Provider value={{ host: "primary", mode, rects }}>
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {/* Task 6: the wide Home board replaces the phone widget stack entirely on Start — the
                `screenEl` App.tsx built for "start" (a `StartScreen` element) is still constructed
                as `children` (cheap: it's just a React element description) but never rendered
                here, so its own phone-only header/EditWidgetsSheet never mount on wide. */}
            {screen === "start" ? (
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
        <InWideShell.Provider value={{ host: "panel", mode, rects }}>
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
            onPrev={prev}
            onNext={next}
            editTxn={editTxn}
            addPreset={addPreset}
            onDoneEdit={onDoneEdit}
          />
        </InWideShell.Provider>
      </div>
    </div>
  );
}
