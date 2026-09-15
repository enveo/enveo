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

import { panelFallbacks as computePanelFallbacks, resolvePanel } from "./panel";
import { Rail } from "./Rail";
import { WideSettings } from "./WideSettings";

type RightSlot = { kind: "action"; label: string; ariaLabel: string; onClick: () => void } | { kind: "caption"; text: string } | null;

export type { RightSlot };

const SCREEN_TITLE: Record<ScreenId, Message> = {
  start: msg("Home"),
  budget: msg("Budget"),
  transactions: msg("Transactions"),
  accounts: msg("Accounts"),
  activity: msg("Imports"),
  reports: msg("Reports"),

  addExpense: msg("Add"),
  settings: msg("Settings"),
};

const PENCIL_D = "M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.1 2.1 0 013 3L12 15l-4 1 1-4 9.5-9.5z";

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
        {rightSlot?.kind === "caption" && <span style={{ fontSize: 11.5, color: C.bandMute, flexShrink: 0, whiteSpace: "nowrap" }}>{rightSlot.text}</span>}
        <button
          onClick={onAdd}
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
          {}
          <PanelToggleGlyph color={panelClosed ? C.soft : TEAL} closed={panelClosed} />
        </button>
      </div>
    </div>
  );
}

type WideShellBag = {
  mode: Exclude<ViewMode, "phone">;

  screen: ScreenId;

  primaryScreen: ScreenId;
  nav: (s: ScreenId) => void;
  month: string;
  prev: () => void;
  next: () => void;
  reportsView: ReportView;
  envView: { envelopeId: string; month: string } | null;

  acctView: { accountId: string } | null;

  openTxns: (f?: { envId?: string; accId?: string; envIds?: ReadonlySet<string>; catId?: string; placeId?: string; date?: string }) => void;
  panelClosed: boolean;
  setEnvView: (v: null) => void;

  setAcctView: (v: null) => void;

  setReportsView: (v: ReportView) => void;
  setPanelClosed: (closed: boolean) => void;

  state: StateResponse;
  onQuickAdd: (kind: "transfer" | "import" | "suggest") => void;
  onFillGoals: () => void;
  onInstall: () => void;

  onOpenEnvelope: (envId: string, month: string) => void;
  onEditTxn: (t: Transaction) => void;
  monthDay: string | null;
  onSelectDay: (date: string | null) => void;

  onOpenReport: (tab: ReportTab) => void;
  onOpenMonthDay: (date: string) => void;

  boardEdit: boolean;

  editTxn: Transaction | null;
  addPreset: { tab?: AddTab; importSheet?: boolean };

  onDoneEdit: () => void;

  onAddWide: () => void;

  onSelectAccount: (id: string) => void;

  onEditAccountTxn: (t: Transaction) => void;

  onEditEnvelopeTxn: (t: Transaction) => void;

  txQuery: string;
  txFilters: TransactionFilters;

  txnView: { txnId: string } | null;
  /** Raw setter — the same `setEnvView`/`setAcctView`-decides-when pattern this bag already
   *  documents; `closePanel` and the vanish effect below are the only callers. Selecting a row is a
   *  *different* App entry point (`Transactions.tsx`'s own `onSelectTxn` prop, wired directly at
   *  the primary-pane call site — the row lives in the PRIMARY pane, not this shell's bag). */
  setTxnView: (v: null) => void;

  onEditTxnPanel: (t: Transaction) => void;

  onDuplicateTxnPanel: (t: Transaction) => void;
};

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
  const { t } = useT();

  const filteredTransactions = useMemo<StateResponse["transactions"]>(() => {
    if (primaryScreen !== "transactions") return [];
    const index = createTransactionSearchIndex({ accounts: state.accounts, envelopes: state.envelopes, categories: state.categories, places: state.places });
    return state.transactions.filter((tx) => matchesTransactionQuery(tx, txQuery, index) && matchesTransactionFilters(tx, txFilters));
  }, [primaryScreen, state.accounts, state.envelopes, state.categories, state.places, state.transactions, txQuery, txFilters]);

  const [rootRef, rootW] = useElementWidth<HTMLDivElement>(mode === "desktop" ? 1440 : 1104);
  const paneW = paneWidthFor(mode, rootW);

  const [widgetSettings, setWidgetSettings] = useState<WideWidgetId | null>(null);

  const [widgetPicker, setWidgetPicker] = useState(false);
  useEffect(() => {
    if (primaryScreen !== "start") {
      setWidgetSettings(null);
      setWidgetPicker(false);
    }
  }, [primaryScreen]);

  useEffect(() => {
    if (!boardEdit) setWidgetPicker(false);
  }, [boardEdit]);

  const fallbacksForPanel = useMemo(
    () => computePanelFallbacks({ envelopes: state.envelopes, groups: state.groups, accounts: state.accounts }, month, filteredTransactions),
    [state.envelopes, state.groups, state.accounts, month, filteredTransactions],
  );
  const view = resolvePanel({ screen, reportsView, envView, widgetSettings, widgetPicker, acctView, txnView }, fallbacksForPanel);
  const primaryRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

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

  const panelContains = (el: Element | null): boolean => !!el && (!!panelRef.current?.contains(el) || !!el.closest("[data-wide-panel-portal]"));

  const closePanel = () => {
    const active = document.activeElement;
    if (panelContains(active)) document.querySelector<HTMLElement>("[data-panel-toggle]")?.focus();

    const topSurface = surfaceStack.at(-1);
    if (topSurface) {
      topSurface.close();
      return;
    }

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
      if (view.source === "selection") setTxnView(null);
      else setPanelClosed(true);
    } else setPanelClosed(true);
  };

  const selection =
    view.kind === "empty"
      ? null
      : view.kind === "add"
        ? addPreset
        : view.kind === "envelope"
          ? envView
          : view.kind === "widgets"
            ? view.widgetId
            : view.kind === "widgetPicker"
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

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && (view.kind === "widgetPicker" || panelContains(document.activeElement))) closePanel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

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
          rightSlot={rightSlot}
          panelClosed={panelClosed}
          onTogglePanel={() => (surfaceStack.length > 0 || view.kind === "add" ? closePanel() : setPanelClosed(!panelClosed))}
          compact={mode === "fold" && !panelClosed}
        />
        {mode === "fold" && primaryScreen !== "settings" && (
          <FoldTbbStrip state={state} screen={primaryScreen} onQuickAdd={onQuickAdd} onFillGoals={onFillGoals} onNav={nav} />
        )}
        {}
        <InWideShell.Provider value={{ host: "primary", mode, rects, surfaces: surfaceHost }}>
          {}
          {mode !== "desktop" && <UpdatePrompt />}
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {}
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
                onWidgetSettings={(id) => {
                  setWidgetSettings(id);
                  setWidgetPicker(false);
                  setAcctView(null);
                }}
                onAddWidget={() => {
                  setWidgetPicker(true);
                  setWidgetSettings(null);
                  setEnvView(null);
                  setAcctView(null);
                }}
                onFillGoals={onFillGoals}
              />
            ) : primaryScreen === "settings" ? (
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

          position: "relative",
          transform: panelClosed ? "translateX(100%)" : "translateX(0)",
          marginRight: panelClosed ? -paneW : 0,
          opacity: panelClosed ? 0 : 1,
          transition: "transform 260ms cubic-bezier(0.4,0,0.2,1), margin-right 260ms cubic-bezier(0.4,0,0.2,1), opacity 180ms ease",
        }}
      >
        {}
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
        {}
        <div
          ref={setSurfaceNode}
          data-wide-panel-surfaces
          style={{ position: "absolute", inset: 0, zIndex: 5, display: surfaceStack.length ? "block" : "none" }}
        />
      </div>
    </div>
  );
}
