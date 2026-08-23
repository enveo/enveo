import type { Transaction } from "@enveo/shared";
import { lazy, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { BottomNav, Drawer, type ScreenId, StyleInjector } from "./components/chrome";
import { LazyChunk, useOpenedOnce } from "./components/lazy";
import { StartupSplash } from "./components/StartupSplash";
import { SyncBadge } from "./components/SyncBadge";
import { UpdatePrompt } from "./components/UpdatePrompt";
import { useStateQuery } from "./lib/api";
import { useTheme } from "./lib/contexts";
import { currentMonth, shiftMonth } from "./lib/dates";
import { useT } from "./lib/i18n";
import { parseUrl, routeToUrl } from "./lib/routing";
import { startupPresentation } from "./lib/startupSplash";
import { store } from "./lib/store";
import { bootOnce, retryBoot } from "./lib/sync";
import { font, P, TEAL } from "./lib/theme";
import type { TransactionFilters } from "./lib/transactionSearch";
import { PHONE_COL, useViewMode } from "./lib/viewMode";
import { AddScreen, type Tab as AddTab } from "./screens/Add";
import { LoginScreen } from "./screens/Login";
import type { ReportTab, ReportView } from "./screens/reports/types";
import { StartScreen } from "./screens/Start";

// Code-split routes (§3f).
//
// EAGER, deliberately: everything the app needs to BOOT and to record a transaction. The local
// replica boot and sync engine (`bootOnce`/`store`/`useStateQuery`), the auth guard
// (`LoginScreen` — the screen an unauthenticated boot lands on), the app chrome, `StartScreen`,
// and `AddScreen` with the whole transaction-entry subtree. Those are the first paint and the
// app's most-repeated action; a chunk fetch in front of either would trade real latency for
// bytes we do not need to save.
//
// LAZY: one chunk per screen the user is never on at boot. Reports (the whole suite with its
// charts), Settings (backup/restore, E2EE, pairing QR, the AI panel), the once-per-account
// onboarding wizard, the transaction list, Accounts, the full-screen envelope summary, and the
// two boot-decision screens — Unlock (E2EE passphrase; a plain-tier budget never renders it)
// and ForeignReplica (a replica belonging to another account). Budget and its editor are also
// lazy: the automatic-envelope shared path exceeded the fixed initial-JS ceiling. Every hashed
// chunk is precached by the service worker, so an installed PWA loads all of them offline.
//
// Each mount goes through `LazyChunk`: themed pending state, focused failure boundary.
const ReportsScreen = lazy(() => import("./screens/Reports").then((m) => ({ default: m.ReportsScreen })));
const SettingsScreen = lazy(() => import("./screens/Settings").then((m) => ({ default: m.SettingsScreen })));
const BudgetScreen = lazy(() => import("./screens/Budget").then((m) => ({ default: m.BudgetScreen })));
const EnvEdit = lazy(() => import("./screens/Budget").then((m) => ({ default: m.EnvEdit })));
const OnboardingScreen = lazy(() => import("./screens/Onboarding").then((m) => ({ default: m.OnboardingScreen })));
const TransactionsScreen = lazy(() => import("./screens/Transactions").then((m) => ({ default: m.TransactionsScreen })));
const AccountsScreen = lazy(() => import("./screens/Accounts").then((m) => ({ default: m.AccountsScreen })));
const EnvelopeScreen = lazy(() => import("./screens/Envelope").then((m) => ({ default: m.EnvelopeScreen })));
const UnlockScreen = lazy(() => import("./screens/Unlock").then((m) => ({ default: m.UnlockScreen })));
const ForeignReplicaScreen = lazy(() => import("./screens/ForeignReplica").then((m) => ({ default: m.ForeignReplicaScreen })));
const InstallSheet = lazy(() => import("./components/InstallSheet").then((m) => ({ default: m.InstallSheet })));
const EnvActionsSheet = lazy(() => import("./components/EnvActionsSheet").then((m) => ({ default: m.EnvActionsSheet })));
const InstallBanner = lazy(() => import("./components/InstallBanner").then((m) => ({ default: m.InstallBanner })));
const WideShell = lazy(() => import("./components/wide/WideShell").then((m) => ({ default: m.WideShell })));

const initialTransactionFilters = (): TransactionFilters => ({
  accountIds: new Set(),
  envelopeIds: new Set(),
  placeIds: new Set(),
  categoryIds: new Set(),
  kinds: new Set(),
  amount: null,
});

export default function App() {
  const C = useTheme();
  const { t } = useT();
  // Wide vs. phone layout (spec §5–§10) — first consumer of `viewMode.ts`, already eager for
  // `PHONE_COL` above. `wide` itself is computed below, once `state`/`onboarding` are known.
  const mode = useViewMode();
  // Deep-load restore: which screen/report/envelope a fresh page load should land on — read
  // once (React ignores this argument after the initial render). `parseUrl` always resolves a
  // full `Route`, so no `start`/`overview` fallback is needed here. `panelClosed` stays out of
  // the URL (chrome, not navigation — pr4-context.md §12.2).
  const r0 = parseUrl(location.pathname, location.search);
  const [screen, setScreen] = useState<ScreenId>(r0.screen);
  const [month, setMonth] = useState(currentMonth());
  const [drawer, setDrawer] = useState(false);
  const [installSheet, setInstallSheet] = useState(false);
  const installSheetMounted = useOpenedOnce(installSheet);
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
  // Start's "Edit widgets" and Budget's "Manage envelopes" sheets, lifted from those screens so
  // the wide shell's band right-slot (pr4-context.md §13) can trigger them too — same sheets,
  // same pencil buttons, only the state's home moves (Task 3).
  const [editWidgetsOpen, setEditWidgetsOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  // Wide shell's right-panel open/closed bit — chrome, not navigation (never in the URL/history,
  // pr4-context.md §12.2). App-owned so it survives the `screen`/`reportsView` it is read
  // alongside (WideShell's `resolvePanel`).
  const [panelClosed, setPanelClosed] = useState(false);
  // Reports view kept in App — entering from the menu opens the card overview,
  // while a deep link (the menu's "Envelope budgets" shortcut) goes straight to the given subscreen
  const [reportsView, setReportsView] = useState<ReportView>(r0.reportsView);
  // Month report's selected day, kept in App for the SAME reason as `reportsView`: opening a
  // transaction from the day panel for edit switches `screen` to "addExpense" and back,
  // unmounting ReportsScreen (and MonthReport) in between — local state there would be lost.
  // A full ISO date (not a bare day-of-month integer) so it is unambiguous to clear/compare;
  // reset below whenever the viewed month changes, since a leftover date from a longer month
  // could otherwise silently resurface once the user pages back to a month with that many days.
  const [monthDay, setMonthDay] = useState<string | null>(null);
  useEffect(() => setMonthDay(null), [month]);
  // full-screen envelope summary (push-nav like transaction editing); back → null
  const [envView, setEnvView] = useState<{ envelopeId: string; month: string } | null>(r0.envelopeId ? { envelopeId: r0.envelopeId, month } : null);
  // screen to return to after saving/cancelling an edit (default start; from the list → list)
  const [editReturn, setEditReturn] = useState<ScreenId>("start");
  // transaction list filters kept high up so they survive an edit and return
  const [txQuery, setTxQuery] = useState("");
  const [txFilters, setTxFilters] = useState<TransactionFilters>(initialTransactionFilters);
  const { data: state, isLoading, isError } = useStateQuery(month);
  const bootStatus = useSyncExternalStore(store.subscribe, store.getBootStatus);

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
  const wide = mode !== "phone" && !!state && !onboarding;

  // nav = entry from menu/navigation: a fresh Add returns to start;
  // Reports from the menu always start at the card overview (deep link overrides below)
  const nav = (s: ScreenId) => {
    if (s !== "addExpense") setEditTxn(null);
    if (s === "addExpense") setAddPreset({});
    if (s === "budget") {
      setBudgetSuggest(false);
      setBudgetFillGoals(false);
    }
    setEnvView(null);
    setEditReturn("start");
    if (s === "reports") {
      // Fresh menu entry = the hub overview, with no resurrected day panel — the same
      // fresh-entry semantics reportsView gets. (A month CHANGE clears monthDay via its own
      // effect; this covers re-entering Reports within the same month.)
      setReportsView("overview");
      setMonthDay(null);
    }
    setScreen(s);
  };
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
  const openReports = (tab: ReportTab) => {
    nav("reports");
    setReportsView(tab);
  };
  // Deep link: Goals report's "Fill ›" → a fresh Budget with the fill-by-goals sheet open
  // (same after-`nav` override as `openReports`, so the reset in `nav` doesn't win the batch).
  const openBudgetFillGoals = () => {
    nav("budget");
    setBudgetFillGoals(true);
  };
  // enter the transaction list with a preselected filter (envelope OR account) — from an
  // envelope/account tile or sheet. Clean, focused view: set the given filter, clear the
  // other dimension and the search box.
  const openTxns = (f?: { envId?: string; accId?: string; envIds?: ReadonlySet<string>; catId?: string; placeId?: string }) => {
    setTxQuery("");
    setTxFilters({
      ...initialTransactionFilters(),
      envelopeIds: f?.envIds ? new Set(f.envIds) : f?.envId ? new Set([f.envId]) : new Set(),
      accountIds: f?.accId ? new Set([f.accId]) : new Set(),
      categoryIds: f?.catId ? new Set([f.catId]) : new Set(),
      placeIds: f?.placeId ? new Set([f.placeId]) : new Set(),
    });
    setEditTxn(null);
    setEnvView(null);
    setEditReturn("start");
    setScreen("transactions");
  };
  // tapping an envelope on Start/Budget → action sheet (Transactions / Summary / Edit)
  const [envActions, setEnvActions] = useState<{ envelopeId: string; month: string } | null>(null);
  const envActionsMounted = useOpenedOnce(envActions !== null);
  const [envEdit, setEnvEdit] = useState<string | null>(null);
  // Phone: the action sheet (Transactions / Summary / Edit — EnvActionsSheet below). Wide: no
  // sheet — `envView` wins `resolvePanel` on ANY screen (components/wide/panel.ts), so tapping an
  // envelope opens its summary straight into the panel, like the phone's own push-nav summary.
  // The sheet's other two actions survive on wide: "Transactions" already exists inside
  // `EnvelopeScreen` (`onOpenTxns`); "Edit" arrives with PR6's `envForm` pane — interim, edit via
  // Budget's own row editor, unchanged (pr4-task-7-brief.md).
  const openEnvelope = (envelopeId: string, m: string) => {
    if (mode !== "phone") setEnvView({ envelopeId, month: m });
    else setEnvActions({ envelopeId, month: m });
  };
  const actionsEnv = envActions ? (state?.envelopes.find((e) => e.id === envActions.envelopeId) ?? null) : null;
  const editEnv = envEdit ? (state?.envelopes.find((e) => e.id === envEdit) ?? null) : null;
  // editing from the list: remember where from, to return there (filters preserved)
  // A stale quick-action preset must never leak into an unrelated edit (bypasses `nav`, which
  // otherwise clears it) — e.g. import-sheet-on-mount popping up over a transaction being edited.
  const editTxnFrom = (t: Transaction, from: ScreenId) => {
    setEditTxn(t);
    setEditReturn(from);
    setAddPreset({});
    setScreen("addExpense");
  };
  const doneEdit = () => {
    setEditTxn(null);
    // `history.back()` after a save is correct here: the entry below `/add` is the screen the
    // edit came from, and `editTxn` is already cleared before popstate runs. `history.state`
    // is our own marker — see `back()` below for what `true` vs `false`/`null` mean.
    if (history.state === true) history.back();
    else setScreen(editReturn);
  };
  const prev = () => setMonth((m) => shiftMonth(m, -1));
  const next = () => setMonth((m) => shiftMonth(m, 1));
  // The decorative frame around the phone column: it appears once the window is meaningfully
  // wider than that column (a rounded corner + shadow so the card reads as a deliberate frame,
  // not a stray narrow window). This is NOT the layout mode — it is kept on its historical
  // 500px threshold (PHONE_COL + 80) so this refactor changes no pixels; the layout mode
  // (`useViewMode`) has no consumer yet and lands with the navigation rail in a later PR.
  const framed = typeof window !== "undefined" && window.innerWidth > PHONE_COL + 80;
  // Desktop backdrop: on narrow (phone) viewports the ~420px column already fills the
  // screen, so this stays transparent — nothing changes there. On wide viewports it's a
  // full-viewport translucent tint layered over the theme background (set on <html> by
  // ThemeProvider), so the phone-width card reads as a deliberate frame, not a stray
  // narrow window; the existing shadow on the card then separates it from the tint.
  const backdrop = { minHeight: "100dvh", background: framed ? "rgba(0,0,0,0.06)" : "transparent" } as const;

  // Accounts are mandatory: server responded 401 → login screen INSTEAD of the app
  // (no BottomNav/badge). Refreshed via the existing mirror-version mechanism
  // (setBootStatus bumps the version → useStateQuery above re-renders App).
  // After returning from OAuth the page reloads anyway → normal boot.
  const unauthed = bootStatus === "unauthed";

  // E2EE: budget encrypted, no DEK on this device (BootStatus "locked")
  // → Unlock screen INSTEAD of the app (same pattern as Login); setDek + retryBoot clear it.
  const locked = bootStatus === "locked";

  // The local replica belongs to ANOTHER account (owner stamp ≠ session — BootStatus "foreign").
  // Every server write is already refused; the app must NOT show (or silently destroy) that
  // account's budget, so the decision screen takes over: export a backup / remove and continue.
  const foreign = bootStatus === "foreign";

  // History wiring, one effect: popstate applies the parsed route through `nav()` — reusing its
  // hygiene (clears presets/editTxn/envView), then overrides in the same batch exactly like the
  // existing `openReports` deep-link pattern. The same pass also keeps one URL in sync with
  // (screen, reportsView, envelopeId) — popstate self-suppresses because the derived URL then
  // already equals `location` — and drops a deep-linked envelope id that turns out not to exist
  // (stale link, wrong account) before it reaches the URL. `justPopped` marks that a correction
  // (the drop above) is happening IN REACTION to a popstate rather than a fresh forward
  // navigation: it must fix the entry we just landed on IN PLACE (replaceState), never push a new
  // one — otherwise the stale entry stays in the stack and hardware/browser back re-lands on it
  // forever (deleting the envelope this session, then paging back into it, would loop).
  const justPopped = useRef(false);
  const routingActive = state && !onboarding && !unauthed && !locked && !foreign;
  useEffect(() => {
    const onPop = () => {
      justPopped.current = true;
      const r = parseUrl(location.pathname, location.search);
      nav(r.screen);
      setReportsView(r.reportsView);
      if (r.envelopeId) setEnvView({ envelopeId: r.envelopeId, month });
    };
    window.addEventListener("popstate", onPop);
    if (routingActive) {
      if (envView && !state?.envelopes.some((e) => e.id === envView.envelopeId)) setEnvView(null);
      else {
        const url = routeToUrl({ screen, reportsView, envelopeId: envView?.envelopeId ?? null });
        if (url !== location.pathname + location.search) {
          // entry 0 (never pushed before), and any popstate correction, is replaced in place, no
          // stack growth; every other change is a real pushed entry (see `back()` below for what
          // `true`/`false` mean).
          if (justPopped.current || history.state == null) history.replaceState(history.state ?? false, "", url);
          else history.pushState(true, "", url);
        }
        justPopped.current = false; // settled: consume the correction window whether or not this pass touched history
      }
    }
    return () => window.removeEventListener("popstate", onPop);
  });

  // Swipe right = go back (screens with a back arrow — pinned PWA has no Safari gesture).
  const canBack = envView !== null || screen === "addExpense" || screen === "settings";
  const back = () => {
    // `history.state` is our own tracking marker: `true` on a real pushed entry (the user has
    // navigated at least twice this session) — traverse it so the swipe gesture, the chevrons
    // and the hardware back key land on the SAME entries. `false`/`null` mean entry 0 (the
    // deep-loaded page, stamped in place without growing the stack) — legacy fallback below.
    if (history.state === true) history.back();
    else if (envView) setEnvView(null);
    else if (screen === "addExpense") {
      setEditTxn(null);
      setScreen(editReturn);
    } else setScreen("start");
  };
  const sw = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0]!;
    sw.current = { x: touch.clientX, y: touch.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const st = sw.current;
    sw.current = null;
    if (!st) return;
    const touch = e.changedTouches[0]!;
    const dx = touch.clientX - st.x,
      dy = touch.clientY - st.y;
    if (canBack) {
      // from the left edge (edge-swipe) or a clear horizontal rightward gesture
      if (dx > 60 && Math.abs(dy) < 45 && (st.x < 40 || dx > 110)) back();
      return;
    }
    // without "back": edge-swipe from the very left edge opens the menu (like a native drawer)
    if (!drawer && !onboarding && st.x < 28 && dx > 60 && Math.abs(dy) < 45) setDrawer(true);
  };

  // The per-screen switch, built once regardless of layout (wide's primary pane and phone's
  // content area render the exact same element) — see `wide` below for where it lands.
  const screenEl = state ? (
    <>
      {screen === "start" && (
        <StartScreen
          state={state}
          month={month}
          onOpenTxns={openTxns}
          onOpenEnvelope={openEnvelope}
          onMenu={() => setDrawer(true)}
          onPrev={prev}
          onNext={next}
          onNav={nav}
          onQuickAdd={onQuickAdd}
          editWidgets={editWidgetsOpen}
          onEditWidgets={setEditWidgetsOpen}
        />
      )}
      {screen === "budget" && (
        <LazyChunk onDismiss={() => nav("start")}>
          <BudgetScreen
            state={state}
            month={month}
            onMenu={() => setDrawer(true)}
            onPrev={prev}
            onNext={next}
            onOpenEnvelope={openEnvelope}
            initialSuggest={budgetSuggest}
            onSuggestConsumed={() => setBudgetSuggest(false)}
            initialFillGoals={budgetFillGoals}
            onFillGoalsConsumed={() => setBudgetFillGoals(false)}
            manageOpen={manageOpen}
            onManageOpen={setManageOpen}
          />
        </LazyChunk>
      )}
      {screen === "transactions" && (
        <LazyChunk onDismiss={() => nav("start")}>
          <TransactionsScreen
            state={state}
            month={month}
            onMenu={() => setDrawer(true)}
            onPrev={prev}
            onNext={next}
            onEditTxn={(t) => editTxnFrom(t, "transactions")}
            query={txQuery}
            setQuery={setTxQuery}
            filters={txFilters}
            setFilters={setTxFilters}
          />
        </LazyChunk>
      )}
      {screen === "accounts" && (
        <LazyChunk onDismiss={() => nav("start")}>
          <AccountsScreen state={state} onMenu={() => setDrawer(true)} />
        </LazyChunk>
      )}
      {screen === "reports" && (
        <LazyChunk onDismiss={() => nav("start")}>
          <ReportsScreen
            state={state}
            month={month}
            view={wide ? "overview" : reportsView}
            onView={setReportsView}
            monthDay={monthDay}
            onSelectDay={setMonthDay}
            onOpenEnvelope={openEnvelope}
            onFillGoals={openBudgetFillGoals}
            onEditTxn={(t) => editTxnFrom(t, "reports")}
            onMenu={() => setDrawer(true)}
            onPrev={prev}
            onNext={next}
            onOpenTxns={openTxns}
            // Wide only: `view` above is forced to "overview" so the primary pane always shows
            // the hub (Task 6) — `selected` recovers what report is REALLY open (in the panel)
            // purely so the hub can highlight its card; harmless on phone, where the hub only
            // ever renders when `reportsView` already equals "overview" too (so this stays
            // `undefined` whenever it could matter there).
            selected={reportsView !== "overview" ? reportsView : undefined}
          />
        </LazyChunk>
      )}
      {screen === "addExpense" && (
        <AddScreen state={state} editTxn={editTxn} onDone={doneEdit} initialTab={addPreset.tab} initialImport={addPreset.importSheet} />
      )}
      {screen === "settings" && (
        <LazyChunk onDismiss={() => nav("start")}>
          <SettingsScreen onBack={back} onInstall={() => setInstallSheet(true)} />
        </LazyChunk>
      )}
    </>
  ) : null;

  if (startupPresentation(bootStatus) === "splash") return <StartupSplash />;

  if (unauthed || locked || foreign) {
    return (
      <div style={backdrop}>
        <div
          style={{
            maxWidth: PHONE_COL,
            margin: "0 auto",
            height: "100dvh",
            background: C.bg,
            display: "flex",
            flexDirection: "column",
            fontFamily: font,
            overflow: "hidden",
            borderRadius: framed ? 24 : 0,
            boxShadow: framed ? "0 0 80px rgba(0,0,0,0.4)" : "none",
            WebkitFontSmoothing: "antialiased",
            position: "relative",
          }}
        >
          <StyleInjector />
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", paddingTop: "env(safe-area-inset-top)" }}>
            {unauthed ? <LoginScreen /> : <LazyChunk>{foreign ? <ForeignReplicaScreen /> : <UnlockScreen />}</LazyChunk>}
          </div>
        </div>
      </div>
    );
  }

  // Wide: rail + band + panel replace the phone card entirely (the primary pane renders the
  // SAME `screenEl`) — except on Add, which keeps the phone-column takeover below (interim by
  // design, PR6's `add` pane replaces it — pr4-task-4-brief.md §4e).
  //
  // §13's per-screen band right-slot ("Edit widgets" on Start / "Manage envelopes" on Budget) —
  // restored now that the widget-edit-sheet extraction (pr4-context.md header; the pull-forward
  // of PR5 Task 1) bought back the §3f headroom this needed. Reuses the SAME lifted
  // editWidgetsOpen/manageOpen state Start/Budget already drive their own pencils from, so
  // opening from the band and opening from the phone header stay one piece of state each.
  const wideRightSlot =
    screen === "start"
      ? { label: t("Edit widgets"), ariaLabel: t("Edit widgets"), onClick: () => setEditWidgetsOpen(true) }
      : screen === "budget"
        ? { label: t("Manage envelopes"), ariaLabel: t("Manage envelopes"), onClick: () => setManageOpen(true) }
        : null;

  if (wide && screen !== "addExpense") {
    return (
      <LazyChunk>
        <WideShell
          bag={{
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
            // `wide` already implies `!!state` (its own definition above) — TS can't see through
            // that boolean, so the assertion is the one place this fact needs spelling out.
            state: state!,
            onQuickAdd,
            onFillGoals: openBudgetFillGoals,
            onInstall: () => setInstallSheet(true),
            // Task 6: the panel's own `ReportsScreen` instance needs the exact same entry points
            // the primary pane's already uses, so opening an envelope / editing a transaction /
            // picking a day from a report inside the panel behaves identically to doing it from
            // the hub in the primary pane — same functions, not a wide-only fork of them.
            onOpenEnvelope: openEnvelope,
            onEditTxn: (t) => editTxnFrom(t, "reports"),
            monthDay,
            onSelectDay: setMonthDay,
          }}
          rightSlot={wideRightSlot}
        >
          {screenEl}
        </WideShell>
      </LazyChunk>
    );
  }

  return (
    <div style={backdrop}>
      <div
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        style={{
          maxWidth: PHONE_COL,
          margin: "0 auto",
          height: "100dvh",
          background: C.bg,
          display: "flex",
          flexDirection: "column",
          fontFamily: font,
          overflow: "hidden",
          borderRadius: framed ? 24 : 0,
          boxShadow: framed ? "0 0 80px rgba(0,0,0,0.4)" : "none",
          WebkitFontSmoothing: "antialiased",
          position: "relative",
        }}
      >
        <StyleInjector />
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", paddingTop: "env(safe-area-inset-top)" }}>
          {isLoading && <BootSkeleton />}
          {isError && <FirstBootError />}
          {state && onboarding && (
            <LazyChunk>
              <OnboardingScreen onDone={() => setWizard(false)} />
            </LazyChunk>
          )}
          {state && !onboarding && envView && (
            <LazyChunk onDismiss={() => setEnvView(null)}>
              <EnvelopeScreen envelopeId={envView.envelopeId} initialMonth={envView.month} onBack={back} onOpenTxns={openTxns} />
            </LazyChunk>
          )}
          {state && !onboarding && !envView && screenEl}
        </div>
        {!["addExpense", "settings"].includes(screen) && !onboarding && !envView && <BottomNav active={screen} onNav={nav} />}
        {/* badge anchors top-right; on Add the header is the type tabs → collision, hide it */}
        {screen !== "addExpense" && <SyncBadge onOpenSync={() => nav("settings")} />}
        {envActionsMounted && (
          <LazyChunk variant="overlay" onDismiss={() => setEnvActions(null)}>
            <EnvActionsSheet
              env={actionsEnv}
              onClose={() => setEnvActions(null)}
              onTxns={() => {
                if (envActions) {
                  openTxns({ envId: envActions.envelopeId });
                  setEnvActions(null);
                }
              }}
              onSummary={() => {
                if (envActions) {
                  setEnvView(envActions);
                  setEnvActions(null);
                }
              }}
              onEdit={() => {
                if (envActions) {
                  setEnvEdit(envActions.envelopeId);
                  setEnvActions(null);
                }
              }}
            />
          </LazyChunk>
        )}
        {envEdit && (
          <LazyChunk variant="overlay" onDismiss={() => setEnvEdit(null)}>
            <EnvEdit env={editEnv} groups={state?.groups ?? []} accounts={state?.accounts ?? []} onClose={() => setEnvEdit(null)} />
          </LazyChunk>
        )}
        <Drawer open={drawer} onClose={() => setDrawer(false)} onNav={nav} onOpenReports={openReports} onInstall={() => setInstallSheet(true)} />
        {/* not during onboarding: the wizard ends with its own install card (a second ask), the
            BottomNav the banner's offset clears is hidden there, and it must not cover the skeleton */}
        {state && !onboarding && (
          <LazyChunk variant="silent">
            <InstallBanner />
          </LazyChunk>
        )}
        {installSheetMounted && (
          <LazyChunk variant="overlay" onDismiss={() => setInstallSheet(false)}>
            <InstallSheet show={installSheet} onClose={() => setInstallSheet(false)} />
          </LazyChunk>
        )}
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
        {Array.from({ length: 4 }).map((_, i) => (
          <Box key={i} h={66} />
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 7, padding: `0 ${P}px 10px` }}>
        {Array.from({ length: 9 }).map((_, i) => (
          <Box key={i} h={76} />
        ))}
      </div>
    </div>
  );
}

/** First boot with no local replica and no server — the only state in which the app cannot work. */
function FirstBootError() {
  const C = useTheme();
  const { t } = useT();
  return (
    <div
      style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 32, textAlign: "center" }}
    >
      <span style={{ color: C.mute, fontSize: 13, lineHeight: 1.6 }}>{t("The first launch requires a connection to the server")}</span>
      <button
        onClick={() => void retryBoot()}
        style={{
          padding: "11px 22px",
          borderRadius: 11,
          border: "none",
          background: TEAL,
          color: "#fff",
          fontSize: 13.5,
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: font,
        }}
      >
        {t("Try again")}
      </button>
    </div>
  );
}
