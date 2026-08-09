import { useEffect, useRef, useState } from "react";
import type { Transaction } from "@enveo/shared";
import { BottomNav, Drawer, StyleInjector, type ScreenId } from "./components/chrome";
import { EnvActionsSheet } from "./components/EnvActionsSheet";
import { EnvEdit } from "./screens/Budget";
import { InstallBanner } from "./components/InstallBanner";
import { InstallSheet } from "./components/InstallSheet";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { SyncBadge } from "./components/SyncBadge";
import { useStateQuery } from "./lib/api";
import { useTheme } from "./lib/contexts";
import { currentMonth, shiftMonth } from "./lib/dates";
import { useT } from "./lib/i18n";
import { store } from "./lib/store";
import { bootOnce, retryBoot } from "./lib/sync";
import { P, TEAL, font } from "./lib/theme";
import { ForeignReplicaScreen } from "./screens/ForeignReplica";
import { LoginScreen } from "./screens/Login";
import { UnlockScreen } from "./screens/Unlock";
import { StartScreen } from "./screens/Start";
import { BudgetScreen } from "./screens/Budget";
import { EnvelopeScreen } from "./screens/Envelope";
import { TransactionsScreen } from "./screens/Transactions";
import { AccountsScreen } from "./screens/Accounts";
import { ReportsScreen, type ReportTab, type ReportView } from "./screens/Reports";
import { AddScreen, type Tab as AddTab } from "./screens/Add";
import { SettingsScreen } from "./screens/Settings";
import { OnboardingScreen } from "./screens/Onboarding";

export default function App() {
  const C = useTheme();
  const [screen, setScreen] = useState<ScreenId>("start");
  const [month, setMonth] = useState(currentMonth());
  const [drawer, setDrawer] = useState(false);
  const [installSheet, setInstallSheet] = useState(false);
  const [editTxn, setEditTxn] = useState<Transaction | null>(null);
  // Start "quick actions" widget preset for a FRESH Add — read once at mount (AddScreen fully
  // unmounts/remounts with `screen`, so this never leaks into an unrelated later Add). Reset
  // by `nav` on every normal entry (FAB, menu) so it only ever applies to the quick action itself.
  const [addPreset, setAddPreset] = useState<{ tab?: AddTab; importSheet?: boolean }>({});
  // Start "Zasugeruj" quick action — a fresh Budget screen with the suggest sheet already open.
  // Reset by `nav` on every normal entry, same lifecycle as `addPreset`.
  const [budgetSuggest, setBudgetSuggest] = useState(false);
  // Goals-report "Fill ›" deep link — a fresh Budget with the fill-by-goals sheet already
  // open. Same one-shot lifecycle as `budgetSuggest`: `nav` resets it on every normal entry,
  // `openBudgetFillGoals` sets it AFTER `nav` so it wins within the same batch.
  const [budgetFillGoals, setBudgetFillGoals] = useState(false);
  // Reports view kept in App — entering from the menu opens the card overview,
  // while a deep link (the menu's "Envelope budgets" shortcut) goes straight to the given subscreen
  const [reportsView, setReportsView] = useState<ReportView>("overview");
  // full-screen envelope summary (push-nav like transaction editing); back → null
  const [envView, setEnvView] = useState<{ envelopeId: string; month: string } | null>(null);
  // screen to return to after saving/cancelling an edit (default start; from the list → list)
  const [editReturn, setEditReturn] = useState<ScreenId>("start");
  // transaction list filters kept high up so they survive an edit and return
  const [txQuery, setTxQuery] = useState("");
  const [txEnvFilter, setTxEnvFilter] = useState<ReadonlySet<string>>(new Set());
  const [txAccFilter, setTxAccFilter] = useState<ReadonlySet<string>>(new Set());
  const { data: state, isLoading, isError } = useStateQuery(month);

  // local replica boot: hydrate from IDB → (empty ⇒ snapshot) → pull deltas
  useEffect(() => {
    void bootOnce();
  }, []);

  // First-run wizard: EMPTY budget (0 accounts, 0 envelopes, 0 transactions)
  // → OnboardingScreen instead of the screens. `wizard` latch: the account created
  // in step 1 clears `empty`, but the wizard stays until the steps finish (onDone) —
  // otherwise step 2 (envelope template) would never show.
  const empty = !!state && state.accounts.length === 0 && state.envelopes.length === 0 && state.transactions.length === 0;
  const [wizard, setWizard] = useState(false);
  useEffect(() => {
    if (empty) setWizard(true);
  }, [empty]);
  const onboarding = empty || wizard;

  // nav = entry from menu/navigation: a fresh Add returns to start;
  // Reports from the menu always start at the card overview (deep link overrides below)
  const nav = (s: ScreenId) => { if (s !== "addExpense") setEditTxn(null); if (s === "addExpense") setAddPreset({}); if (s === "budget") { setBudgetSuggest(false); setBudgetFillGoals(false); } setEnvView(null); setEditReturn("start"); if (s === "reports") setReportsView("overview"); setScreen(s); };
  // Start "quick actions": Przelew/Ze zrzutu open a FRESH Add pre-set to a tab or with the
  // import sheet already showing; Zasugeruj opens a FRESH Budget with the suggest sheet already
  // open (Wydatek goes through plain `nav` — see Start.tsx).
  const onQuickAdd = (kind: "transfer" | "import" | "suggest") => {
    if (kind === "suggest") {
      setBudgetSuggest(true);
      setScreen("budget");
      return;
    }
    setEditTxn(null);
    setEnvView(null);
    setEditReturn("start");
    setAddPreset(kind === "transfer" ? { tab: "transfer" } : { importSheet: true });
    setScreen("addExpense");
  };
  // Deep link: Reports opened DIRECTLY on a subscreen — the menu's "Envelope budgets" shortcut.
  // setReportsView AFTER nav — within the same batch the last write wins, so it overrides the
  // reset to "overview".
  const openReports = (tab: ReportTab) => { nav("reports"); setReportsView(tab); };
  // Deep link: Goals report's "Fill ›" → a fresh Budget with the fill-by-goals sheet open
  // (same after-`nav` override as `openReports`, so the reset in `nav` doesn't win the batch).
  const openBudgetFillGoals = () => { nav("budget"); setBudgetFillGoals(true); };
  // enter the transaction list with a preselected filter (envelope OR account) — from an
  // envelope/account tile or sheet. Clean, focused view: set the given filter, clear the
  // other dimension and the search box.
  const openTxns = (f?: { envId?: string; accId?: string }) => {
    setTxQuery("");
    setTxEnvFilter(f?.envId ? new Set([f.envId]) : new Set());
    setTxAccFilter(f?.accId ? new Set([f.accId]) : new Set());
    setEditTxn(null);
    setEnvView(null);
    setEditReturn("start");
    setScreen("transactions");
  };
  // tapping an envelope on Start/Budget → action sheet (Transactions / Summary / Edit)
  const [envActions, setEnvActions] = useState<{ envelopeId: string; month: string } | null>(null);
  const [envEdit, setEnvEdit] = useState<string | null>(null);
  const openEnvelope = (envelopeId: string, m: string) => setEnvActions({ envelopeId, month: m });
  const actionsEnv = envActions ? (state?.envelopes.find((e) => e.id === envActions.envelopeId) ?? null) : null;
  const editEnv = envEdit ? (state?.envelopes.find((e) => e.id === envEdit) ?? null) : null;
  // editing from the list: remember where from, to return there (filters preserved)
  // A stale quick-action preset must never leak into an unrelated edit (bypasses `nav`, which
  // otherwise clears it) — e.g. import-sheet-on-mount popping up over a transaction being edited.
  const editTxnFrom = (t: Transaction, from: ScreenId) => { setEditTxn(t); setEditReturn(from); setAddPreset({}); setScreen("addExpense"); };
  const doneEdit = () => { setEditTxn(null); setScreen(editReturn); };
  const prev = () => setMonth((m) => shiftMonth(m, -1));
  const next = () => setMonth((m) => shiftMonth(m, 1));
  const wide = typeof window !== "undefined" && window.innerWidth > 500;
  // Desktop backdrop: on narrow (phone) viewports the ~420px column already fills the
  // screen, so this stays transparent — nothing changes there. On wide viewports it's a
  // full-viewport translucent tint layered over the theme background (set on <html> by
  // ThemeProvider), so the phone-width card reads as a deliberate frame, not a stray
  // narrow window; the existing shadow on the card then separates it from the tint.
  const backdrop = { minHeight: "100dvh", background: wide ? "rgba(0,0,0,0.06)" : "transparent" } as const;

  // Accounts are mandatory: server responded 401 → login screen INSTEAD of the app
  // (no BottomNav/badge). Refreshed via the existing mirror-version mechanism
  // (setBootStatus bumps the version → useStateQuery above re-renders App).
  // After returning from OAuth the page reloads anyway → normal boot.
  const unauthed = store.getBootStatus() === "unauthed";

  // E2EE: budget encrypted, no DEK on this device (BootStatus "locked")
  // → Unlock screen INSTEAD of the app (same pattern as Login); setDek + retryBoot clear it.
  const locked = store.getBootStatus() === "locked";

  // The local replica belongs to ANOTHER account (owner stamp ≠ session — BootStatus "foreign").
  // Every server write is already refused; the app must NOT show (or silently destroy) that
  // account's budget, so the decision screen takes over: export a backup / remove and continue.
  const foreign = store.getBootStatus() === "foreign";

  // Swipe right = go back (screens with a back arrow — pinned PWA has no Safari gesture).
  const canBack = envView !== null || screen === "addExpense" || screen === "settings";
  const back = () => { if (envView) setEnvView(null); else if (screen === "addExpense") { setEditTxn(null); setScreen(editReturn); } else setScreen("start"); };
  const sw = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => { const t = e.touches[0]!; sw.current = { x: t.clientX, y: t.clientY }; };
  const onTouchEnd = (e: React.TouchEvent) => {
    const st = sw.current; sw.current = null;
    if (!st) return;
    const t = e.changedTouches[0]!;
    const dx = t.clientX - st.x, dy = t.clientY - st.y;
    if (canBack) {
      // from the left edge (edge-swipe) or a clear horizontal rightward gesture
      if (dx > 60 && Math.abs(dy) < 45 && (st.x < 40 || dx > 110)) back();
      return;
    }
    // without "back": edge-swipe from the very left edge opens the menu (like a native drawer)
    if (!drawer && !onboarding && st.x < 28 && dx > 60 && Math.abs(dy) < 45) setDrawer(true);
  };

  if (unauthed || locked || foreign) {
    return (
      <div style={backdrop}>
        <div style={{ maxWidth: 420, margin: "0 auto", height: "100dvh", background: C.bg, display: "flex", flexDirection: "column", fontFamily: font, overflow: "hidden", borderRadius: wide ? 24 : 0, boxShadow: wide ? "0 0 80px rgba(0,0,0,0.4)" : "none", WebkitFontSmoothing: "antialiased", position: "relative" }}>
          <StyleInjector />
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", paddingTop: "env(safe-area-inset-top)" }}>
            {unauthed ? <LoginScreen /> : foreign ? <ForeignReplicaScreen /> : <UnlockScreen />}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={backdrop}>
      <div onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} style={{ maxWidth: 420, margin: "0 auto", height: "100dvh", background: C.bg, display: "flex", flexDirection: "column", fontFamily: font, overflow: "hidden", borderRadius: wide ? 24 : 0, boxShadow: wide ? "0 0 80px rgba(0,0,0,0.4)" : "none", WebkitFontSmoothing: "antialiased", position: "relative" }}>
        <StyleInjector />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", paddingTop: "env(safe-area-inset-top)" }}>
          {isLoading && <BootSkeleton />}
          {isError && <FirstBootError />}
          {state && onboarding && <OnboardingScreen onDone={() => setWizard(false)} />}
          {state && !onboarding && envView && (
            <EnvelopeScreen envelopeId={envView.envelopeId} initialMonth={envView.month} onBack={() => setEnvView(null)} onOpenTxns={openTxns} />
          )}
          {state && !onboarding && !envView && (
            <>
              {screen === "start" && <StartScreen state={state} month={month} onOpenTxns={openTxns} onOpenEnvelope={openEnvelope} onMenu={() => setDrawer(true)} onPrev={prev} onNext={next} onNav={nav} onQuickAdd={onQuickAdd} />}
              {screen === "budget" && <BudgetScreen state={state} month={month} onMenu={() => setDrawer(true)} onPrev={prev} onNext={next} onOpenEnvelope={openEnvelope} initialSuggest={budgetSuggest} onSuggestConsumed={() => setBudgetSuggest(false)} initialFillGoals={budgetFillGoals} onFillGoalsConsumed={() => setBudgetFillGoals(false)} />}
              {screen === "transactions" && <TransactionsScreen state={state} month={month} onMenu={() => setDrawer(true)} onPrev={prev} onNext={next} onEditTxn={(t) => editTxnFrom(t, "transactions")} query={txQuery} setQuery={setTxQuery} envFilter={txEnvFilter} setEnvFilter={setTxEnvFilter} accFilter={txAccFilter} setAccFilter={setTxAccFilter} />}
              {screen === "accounts" && <AccountsScreen state={state} onMenu={() => setDrawer(true)} />}
              {screen === "reports" && <ReportsScreen state={state} month={month} view={reportsView} onView={setReportsView} onOpenEnvelope={openEnvelope} onFillGoals={openBudgetFillGoals} onMenu={() => setDrawer(true)} onPrev={prev} onNext={next} />}
              {screen === "addExpense" && <AddScreen state={state} editTxn={editTxn} onDone={doneEdit} initialTab={addPreset.tab} initialImport={addPreset.importSheet} />}
              {screen === "settings" && <SettingsScreen onNav={nav} />}
            </>
          )}
        </div>
        {!["addExpense", "settings"].includes(screen) && !onboarding && !envView && <BottomNav active={screen} onNav={nav} />}
        {/* badge anchors top-right; on Add the header is the type tabs → collision, hide it */}
        {screen !== "addExpense" && <SyncBadge onOpenSync={() => nav("settings")} />}
        <EnvActionsSheet
          env={actionsEnv}
          onClose={() => setEnvActions(null)}
          onTxns={() => { if (envActions) { openTxns({ envId: envActions.envelopeId }); setEnvActions(null); } }}
          onSummary={() => { if (envActions) { setEnvView(envActions); setEnvActions(null); } }}
          onEdit={() => { if (envActions) { setEnvEdit(envActions.envelopeId); setEnvActions(null); } }}
        />
        <EnvEdit env={editEnv} groups={state?.groups ?? []} onClose={() => setEnvEdit(null)} />
        <Drawer open={drawer} onClose={() => setDrawer(false)} onNav={nav} onOpenReports={openReports} onInstall={() => setInstallSheet(true)} />
        {/* not during onboarding: the wizard ends with its own install card (a second ask), the
            BottomNav the banner's offset clears is hidden there, and it must not cover the skeleton */}
        {state && !onboarding && <InstallBanner />}
        <InstallSheet show={installSheet} onClose={() => setInstallSheet(false)} />
        <UpdatePrompt />
      </div>
    </div>
  );
}

/**
 * Screen skeleton during the first bootstrap — the app frame right away instead of an
 * empty "Loading…". Mirrors the Start screen layout (same paddings/grids), so the
 * transition to real content has no jump. On the very first boot there is no data
 * anyway — this is a PERCEIVED improvement; the real speed-up comes from snapshot
 * compression and the local replica persisting between sessions.
 */
function BootSkeleton() {
  const C = useTheme();
  const Box = ({ w, h, r = 12, style }: { w?: number | string; h: number; r?: number; style?: React.CSSProperties }) => (
    <div className="sk" style={{ width: w ?? "100%", height: h, borderRadius: r, background: C.inset, ...style }} />
  );
  return (
    <div className="gs" style={{ flex: 1, overflow: "hidden", paddingBottom: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: `12px ${P}px 6px` }}>
        <Box w={22} h={18} r={6} />
        <Box w={128} h={20} r={8} />
        <Box w={22} h={18} r={6} />
      </div>
      <div style={{ display: "flex", gap: 8, padding: `2px ${P}px 8px`, alignItems: "stretch" }}>
        <div style={{ flex: 1, display: "flex", gap: 16, alignItems: "center" }}>
          <Box w={70} h={34} r={8} />
          <Box w={70} h={34} r={8} />
        </div>
        <Box w={150} h={48} r={12} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, padding: `4px ${P}px 12px` }}>
        {Array.from({ length: 4 }).map((_, i) => <Box key={i} h={66} />)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 7, padding: `0 ${P}px 10px` }}>
        {Array.from({ length: 9 }).map((_, i) => <Box key={i} h={76} />)}
      </div>
    </div>
  );
}

/** First boot with no local replica and no server — the only state in which the app cannot work. */
function FirstBootError() {
  const C = useTheme();
  const { t } = useT();
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 32, textAlign: "center" }}>
      <span style={{ color: C.mute, fontSize: 13, lineHeight: 1.6 }}>{t("The first launch requires a connection to the server")}</span>
      <button
        onClick={() => void retryBoot()}
        style={{ padding: "11px 22px", borderRadius: 11, border: "none", background: TEAL, color: "#fff", fontSize: 13.5, fontWeight: 600, cursor: "pointer", fontFamily: font }}
      >
        {t("Try again")}
      </button>
    </div>
  );
}
