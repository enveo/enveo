import { type ReactNode, useEffect, useRef } from "react";
import type { StateResponse } from "../../lib/api";
import { useTheme } from "../../lib/contexts";
import { monthLabel } from "../../lib/dates";
import { type Message, msg, useT } from "../../lib/i18n";
import { Ico } from "../../lib/icons";
import { InWideShell } from "../../lib/shellContext";
import { CTA, font, P } from "../../lib/theme";
import { useElementWidth } from "../../lib/useElementWidth";
import type { ViewMode } from "../../lib/viewMode";
import type { ReportView } from "../../screens/reports/types";
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
    <div
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
  openTxns: (f?: { envId?: string; accId?: string }) => void;
  panelClosed: boolean;
  setEnvView: (v: null) => void;
  setReportsView: (v: "overview") => void;
  setPanelClosed: (closed: boolean) => void;
  /** Task 5's rail card + fold strip need the same `state` every screen already renders from —
   *  App only reaches this branch once `state` exists (`wide`'s own definition), so the call
   *  site passes it with a `!` rather than this type carrying `| undefined` everywhere. */
  state: StateResponse;
  onQuickAdd: (kind: "transfer" | "import" | "suggest") => void;
  onFillGoals: () => void;
  onInstall: () => void;
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
  } = bag;
  const C = useTheme();
  const { t } = useT();
  const [rootRef, rootW] = useElementWidth<HTMLDivElement>(mode === "desktop" ? 1440 : 1104);
  const paneW = paneWidthFor(mode, rootW);
  const view = resolvePanel({ screen, reportsView, envView });
  const panelRef = useRef<HTMLDivElement | null>(null);

  const closePanel = () => {
    if (view.kind === "envelope") setEnvView(null);
    else if (view.kind === "report") setReportsView("overview");
    else setPanelClosed(true);
  };

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
      <div data-wide-primary style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", borderRight: `1px solid ${C.line}` }}>
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
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <InWideShell.Provider value={true}>{children}</InWideShell.Provider>
        </div>
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
        <PanelHost view={view} onClose={closePanel} onOpenTxns={openTxns} />
      </div>
    </div>
  );
}
