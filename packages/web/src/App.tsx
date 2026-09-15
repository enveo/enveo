import { computeStateResponse, type Transaction } from "@enveo/shared";
import { lazy, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { BottomNav, Drawer, type ScreenId, StyleInjector } from "./components/chrome";
import { LazyChunk, useOpenedOnce } from "./components/lazy";
import { SignOutBoundary } from "./components/SignOutShield";
import { StartupSplash } from "./components/StartupSplash";
import { SyncBadge } from "./components/SyncBadge";

import { panelFallbacks, primaryScreenFor } from "./components/wide/panel";

import type { RightSlot } from "./components/wide/WideShell";
import { useLedgerVersion, useStateQuery } from "./lib/api";
import { type BudgetSheetEvent, type BudgetSheetState, budgetSheetAfter } from "./lib/budgetSheet";
import { useMask, useTheme } from "./lib/contexts";
import { currentMonth, shiftMonth } from "./lib/dates";
import { useT } from "./lib/i18n";
import { importManagerBootstrap } from "./lib/importJobs/bootstrap";
import { historyAction, parseUrl, routeToUrl } from "./lib/routing";
import { OpenImportActivity } from "./lib/shellContext";
import { startupPresentation } from "./lib/startupSplash";
import { store } from "./lib/store";
import { bootOnce, retryBoot } from "./lib/sync";
import { font, P, TEAL } from "./lib/theme";
import type { TransactionFilters } from "./lib/transactionSearch";
import { APP_VERSION, buildLabel } from "./lib/version";
import { PHONE_COL, useViewMode } from "./lib/viewMode";
import { AddScreen, type Tab as AddTab } from "./screens/Add";
import type { ReportTab, ReportView } from "./screens/reports/types";
import { StartScreen } from "./screens/Start";

// Code-split routes (§3f).
//
// EAGER, deliberately: everything the app needs to BOOT and to record a transaction. The local
// replica boot and sync engine (`bootOnce`/`store`/`useStateQuery`), the app chrome, `StartScreen`,
// and `AddScreen` with the whole transaction-entry subtree. Those are the authenticated first paint and the
// app's most-repeated action; a chunk fetch in front of either would trade real latency for
// bytes we do not need to save.
//
// LAZY: one chunk per screen the user is never on at boot. Reports (the whole suite with its
// charts), Settings (backup/restore, E2EE, pairing QR, the AI panel), the once-per-account
// onboarding wizard, the transaction list, Accounts, the full-screen envelope summary, and the
// three boot-decision screens — Login, Unlock (E2EE passphrase; a plain-tier budget never renders it)
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
const ActivityScreen = lazy(() => import("./screens/Activity").then((m) => ({ default: m.ActivityScreen })));
const OptionalStatusChrome = lazy(() => import("./components/OptionalStatusChrome").then((m) => ({ default: m.OptionalStatusChrome })));
const EnvelopeScreen = lazy(() => import("./screens/Envelope").then((m) => ({ default: m.EnvelopeScreen })));
const UnlockScreen = lazy(() => import("./screens/Unlock").then((m) => ({ default: m.UnlockScreen })));
const ForeignReplicaScreen = lazy(() => import("./screens/ForeignReplica").then((m) => ({ default: m.ForeignReplicaScreen })));
const LoginScreen = lazy(() => import("./screens/Login").then((m) => ({ default: m.LoginScreen })));
const InstallSheet = lazy(() => import("./components/InstallSheet").then((m) => ({ default: m.InstallSheet })));
const EnvActionsSheet = lazy(() => import("./components/EnvActionsSheet").then((m) => ({ default: m.EnvActionsSheet })));
const InstallBanner = lazy(() => import("./components/InstallBanner").then((m) => ({ default: m.InstallBanner })));
const WideShell = lazy(() => import("./components/wide/WideShell").then((m) => ({ default: m.WideShell })));

const BootShellWide = lazy(() => import("./components/BootShellWide"));

const initialTransactionFilters = (): TransactionFilters => ({
  accountIds: new Set(),
  envelopeIds: new Set(),
  placeIds: new Set(),
  categoryIds: new Set(),
  kinds: new Set(),
  amount: null,
});

export type BackFallback = "close-env-edit" | "close-env-actions" | "close-add" | "close-envelope" | "reports-overview" | "to-start" | null;

export function backFallback(s: {
  screen: ScreenId;
  envView: { envelopeId: string; month: string } | null;
  reportsView: ReportView;
  envEditOpen: boolean;
  envActionsOpen: boolean;
}): BackFallback {
  if (s.envEditOpen) return "close-env-edit";
  if (s.envActionsOpen) return "close-env-actions";
  if (s.screen === "addExpense") return "close-add";
  if (s.envView) return "close-envelope";
  if (s.screen === "reports" && s.reportsView !== "overview") return "reports-overview";
  if (s.screen !== "start") return "to-start";
  return null;
}

function AppContent() {
  const C = useTheme();
  const { t } = useT();
  // Task A5's Accounts band caption ("Balance {amount}") — discreet mode must mask it exactly
  // like every other on-screen amount (house rule).
  const M = useMask();

  const mode = useViewMode();

  const r0 = parseUrl(location.pathname, location.search);
  const [screen, setScreen] = useState<ScreenId>(r0.screen);
  const [month, setMonth] = useState(currentMonth());
  const [drawer, setDrawer] = useState(false);
  const [installSheet, setInstallSheet] = useState(false);
  const installSheetMounted = useOpenedOnce(installSheet);
  const [editTxn, setEditTxn] = useState<Transaction | null>(null);

  const [addPreset, setAddPreset] = useState<{ tab?: AddTab; importSheet?: boolean; duplicateFrom?: Transaction }>({});

  const [budgetSheet, setBudgetSheet] = useState<BudgetSheetState>(null);
  const onBudgetSheet = (event: BudgetSheetEvent) => setBudgetSheet((s) => budgetSheetAfter(s, event));

  const [editWidgetsOpen, setEditWidgetsOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);

  const [wideBoardEdit, setWideBoardEdit] = useState(false);

  const [panelClosed, setPanelClosed] = useState(false);

  const [reportsView, setReportsView] = useState<ReportView>(r0.reportsView);
  // Month report's selected day, kept in App for the SAME reason as `reportsView`: opening a
  // transaction from the day panel for edit switches `screen` to "addExpense" and back,
  // unmounting ReportsScreen (and MonthReport) in between — local state there would be lost.
  // A full ISO date (not a bare day-of-month integer) so it is unambiguous to clear/compare;
  // reset below whenever the viewed month changes, since a leftover date from a longer month
  // could otherwise silently resurface once the user pages back to a month with that many days.
  const [monthDay, setMonthDay] = useState<string | null>(null);
  useEffect(() => setMonthDay(null), [month]);

  const [envView, setEnvView] = useState<{ envelopeId: string; month: string } | null>(r0.envelopeId ? { envelopeId: r0.envelopeId, month } : null);

  const [acctView, setAcctView] = useState<{ accountId: string } | null>(null);

  const acctViewBeforeEditRef = useRef<{ accountId: string } | null>(null);
  useEffect(() => {
    if (screen !== "addExpense") acctViewBeforeEditRef.current = null;
  }, [screen]);

  const [editReturn, setEditReturn] = useState<ScreenId>("start");

  const [txnView, setTxnView] = useState<{ txnId: string } | null>(null);

  const [txQuery, setTxQuery] = useState("");
  const [txFilters, setTxFilters] = useState<TransactionFilters>(initialTransactionFilters);
  const { data: state, isLoading, isError } = useStateQuery(month);
  const bootStatus = useSyncExternalStore(store.subscribe, store.getBootStatus);
  const importManagerStatus = useSyncExternalStore(importManagerBootstrap.subscribe, importManagerBootstrap.getSnapshot);

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

  const primaryScreen = wide ? primaryScreenFor(screen, editReturn) : screen;
  // Accounts/Reports band captions ("Balance {amount}" / "Net worth {amount}", waveA-t5-brief.md
  // + design parity wave A close, item 9) — the SAME GLOBAL total backs both (design's own
  // `netTotal`, demo 4174/4351: one value, read from two spots), computed at `currentMonth()`,
  // never the viewed `month` (house rule; the same computation Accounts.tsx's own header total
  // already uses, non-archived accounts only). Gated to the two screens that show it so phone
  // (and every other wide screen) never pays for the extra recompute.
  const ledgerVersion = useLedgerVersion();
  const globalNetTotal = useMemo(() => {
    if (!wide || (primaryScreen !== "accounts" && primaryScreen !== "reports")) return 0;
    const l = store.getLedger();
    if (!l) return 0;
    return computeStateResponse(l, currentMonth())
      .accounts.filter((a) => !a.archived)
      .reduce((s, a) => s + a.balance, 0);
  }, [ledgerVersion, wide, primaryScreen]);

  const nav = (s: ScreenId) => {
    if (s !== "addExpense") setEditTxn(null);
    if (s === "addExpense") setAddPreset({});
    // EVERY nav target, not just "budget": the open sheet now outlives the Budget screen's mount
    // (it lives here), so leaving Budget has to say out loud what unmounting used to do for free —
    // otherwise coming back would resurrect the sheet the user navigated away from. The deep links
    // that navigate FIRST (`openBudgetFillGoals`, `onQuickAdd("suggest")`) re-open after this call,
    // so their write is the last one in the batch and still wins.
    onBudgetSheet({ kind: "leave" });
    setEnvView(null);

    if (s !== "settings") setAcctView(null);
    // NO `acctViewBeforeEditRef` rung here — abandoning an account-pane edit is handled by the
    // ref's own screen-change effect (the single choke point; see its comment above), which also
    // covers the exits that never come through `nav()` at all (`doneEdit`'s no-history fallback,
    // `onQuickAdd`).
    setEditReturn("start");
    if (s === "reports") {
      setReportsView("overview");
      setMonthDay(null);
    }
    setScreen(s);
  };

  const onQuickAdd = (kind: "transfer" | "import" | "suggest") => {
    if (kind === "suggest") {
      onBudgetSheet({ kind: "open", sheet: "suggest" });
      setScreen("budget");
      return;
    }
    setEditTxn(null);
    setEnvView(null);
    setEditReturn("start");
    setAddPreset(kind === "transfer" ? { tab: "transfer" } : { importSheet: true });
    setScreen("addExpense");
  };

  const openReports = (tab: ReportTab) => {
    nav("reports");
    setReportsView(tab);
  };

  const onOpenMonthDay = (d: string) => {
    openReports("month");
    setMonthDay(d);
  };

  const openBudgetFillGoals = () => {
    nav("budget");
    onBudgetSheet({ kind: "open", sheet: "fillGoals" });
  };

  const openAccount = (id: string) => {
    nav("accounts");
    setAcctView({ accountId: id });
  };

  const selectRailAccount = (id: string) => {
    setEnvView(null);
    setAcctView({ accountId: id });
  };

  const openTxns = (f?: { envId?: string; accId?: string; envIds?: ReadonlySet<string>; catId?: string; placeId?: string; date?: string }) => {
    setTxQuery("");
    setTxFilters({
      ...initialTransactionFilters(),
      envelopeIds: f?.envIds ? new Set(f.envIds) : f?.envId ? new Set([f.envId]) : new Set(),
      accountIds: f?.accId ? new Set([f.accId]) : new Set(),
      categoryIds: f?.catId ? new Set([f.catId]) : new Set(),
      placeIds: f?.placeId ? new Set([f.placeId]) : new Set(),
      date: f?.date ?? null,
    });
    setEditTxn(null);
    setEnvView(null);
    setEditReturn("start");
    setScreen("transactions");
  };

  const [envActions, setEnvActions] = useState<{ envelopeId: string; month: string } | null>(null);
  const envActionsMounted = useOpenedOnce(envActions !== null);
  const [envEdit, setEnvEdit] = useState<string | null>(null);

  const openEnvelope = (envelopeId: string, m: string) => {
    if (mode !== "phone") {
      setEnvView({ envelopeId, month: m });
      setAcctView(null);
    } else setEnvActions({ envelopeId, month: m });
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
  // Wide-only: the account pane's recent-list row → edit (PanelHost's `account` kind). Its OWN
  // `editTxnFrom` binding ("accounts", not the panel report instance's "reports") — see
  // `acctViewBeforeEditRef`'s comment above for why this can't just reuse that shared callback.
  const editAccountTxn = (t: Transaction) => {
    acctViewBeforeEditRef.current = acctView;
    editTxnFrom(t, "accounts");
  };

  const editEnvelopeTxn = (t: Transaction) => editTxnFrom(t, screen);

  const editTxnFromList = (t: Transaction) => editTxnFrom(t, "transactions");

  const duplicateTxnFromPanel = (t: Transaction) => {
    setEditTxn(null);
    setEditReturn("transactions");
    setAddPreset({ duplicateFrom: t });
    setScreen("addExpense");
  };
  const doneEdit = () => {
    setEditTxn(null);
    // `history.back()` after a save is correct here: the entry below `/add` is the screen the
    // edit came from, and `editTxn` is already cleared before popstate runs. `history.state`
    // is our own marker — see `back()` below for what `true` vs `false`/`null` mean.
    // That "entry below /add" premise is GUARANTEED by routeToUrl keeping the add pane's URL a
    // constant "/add" (never `?env`): two consecutive /add entries then cannot exist, so this
    // back() can never land on a sibling /add and leave the filled form (and its enabled submit
    // button) silently in place — the reproduced wide-panel duplicate-submit incident
    // (routing.ts has the full mechanism).
    if (history.state === true) history.back();
    else setScreen(editReturn);
  };

  const openAddWide = () => {
    setEditTxn(null);
    setAddPreset({});
    setEditReturn(screen === "addExpense" ? editReturn : screen);
    setScreen("addExpense");
  };
  const prev = () => {
    setTxFilters((f) => ({ ...f, date: null }));
    setMonth((m) => shiftMonth(m, -1));
  };
  const next = () => {
    setTxFilters((f) => ({ ...f, date: null }));
    setMonth((m) => shiftMonth(m, 1));
  };
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

  const unauthed = bootStatus === "unauthed";

  const locked = bootStatus === "locked";

  // The local replica belongs to ANOTHER account (owner stamp ≠ session — BootStatus "foreign").
  // Every server write is already refused and the app must NOT show that account's budget, so
  // the decision screen takes over: export a backup / remove and continue. On cloud this status
  // is normally never set — the guard silently discards the replica instead (enterForeignReplica)
  // and only its failure path lands here.
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
      setEnvEdit(null);
      setEnvActions(null);
      justPopped.current = true;
      const r = parseUrl(location.pathname, location.search);

      const acctRestore = r.screen === "accounts" ? acctViewBeforeEditRef.current : null;
      nav(r.screen);
      setReportsView(r.reportsView);
      if (r.envelopeId) setEnvView({ envelopeId: r.envelopeId, month });
      if (acctRestore) setAcctView(acctRestore);
    };
    window.addEventListener("popstate", onPop);
    if (routingActive) {
      if (envView && !state?.envelopes.some((e) => e.id === envView.envelopeId)) setEnvView(null);
      else {
        const url = routeToUrl({ screen, reportsView, envelopeId: envView?.envelopeId ?? null });

        const act = historyAction(url !== location.pathname + location.search, history.state != null, justPopped.current);
        if (act === "push") history.pushState(true, "", url);
        else if (act !== "none") history.replaceState(history.state ?? false, "", url);
        justPopped.current = false; // settled: consume the correction window whether or not this pass touched history
      }
    }
    return () => window.removeEventListener("popstate", onPop);
  });

  // Swipe right = go back (screens with a back arrow — pinned PWA has no Safari gesture).
  const canBack = envView !== null || screen === "addExpense" || screen === "settings";
  const back = () => {
    if (history.state === true) {
      history.back();
      return;
    }
    switch (backFallback({ screen, envView, reportsView, envEditOpen: envEdit !== null, envActionsOpen: envActions !== null })) {
      case "close-env-edit":
        setEnvEdit(null);
        break;
      case "close-env-actions":
        setEnvActions(null);
        break;
      case "close-add":
        doneEdit();
        break;
      case "close-envelope":
        setEnvView(null);
        break;
      case "reports-overview":
        setReportsView("overview");
        break;
      case "to-start":
        setScreen("start");
        break;
      case null:
        break;
    }
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
      if (dx > 60 && Math.abs(dy) < 45 && (st.x < 40 || dx > 110)) back();
      return;
    }

    if (!drawer && !onboarding && st.x < 28 && dx > 60 && Math.abs(dy) < 45) setDrawer(true);
  };

  const fallbacks = wide && state ? panelFallbacks(state, month, state.transactions) : null;

  const budgetSelectedEnvelopeId =
    wide && !panelClosed && (screen === "budget" || screen === "start") && !acctView ? (envView?.envelopeId ?? fallbacks?.firstEnvelopeId ?? null) : null;

  const screenEl = state ? (
    <>
      {primaryScreen === "start" && (
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
          onOpenReport={openReports}
          onOpenMonthDay={onOpenMonthDay}
          editWidgets={editWidgetsOpen}
          onEditWidgets={setEditWidgetsOpen}
        />
      )}
      {primaryScreen === "budget" && (
        <LazyChunk onDismiss={() => nav("start")}>
          <BudgetScreen
            state={state}
            month={month}
            onMenu={() => setDrawer(true)}
            onPrev={prev}
            onNext={next}
            onOpenEnvelope={openEnvelope}
            sheet={budgetSheet}
            onSheet={onBudgetSheet}
            manageOpen={manageOpen}
            onManageOpen={setManageOpen}
            selectedEnvelopeId={budgetSelectedEnvelopeId}
          />
        </LazyChunk>
      )}
      {primaryScreen === "transactions" && (
        <LazyChunk onDismiss={() => nav("start")}>
          <TransactionsScreen
            state={state}
            month={month}
            onMenu={() => setDrawer(true)}
            onPrev={prev}
            onNext={next}
            onEditTxn={editTxnFromList}
            query={txQuery}
            setQuery={setTxQuery}
            filters={txFilters}
            setFilters={setTxFilters}
            selectedTxnId={wide && !panelClosed && screen === "transactions" && !envView && !acctView ? txnView?.txnId : null}
            onSelectTxn={(id) => {
              setAcctView(null);
              setTxnView({ txnId: id });
            }}
          />
        </LazyChunk>
      )}
      {primaryScreen === "accounts" && (
        <LazyChunk onDismiss={() => nav("start")}>
          <AccountsScreen
            state={state}
            onMenu={() => setDrawer(true)}
            onOpenAccount={openAccount}
            selectedAccountId={wide ? (acctView?.accountId ?? fallbacks?.firstAccountId ?? null) : null}
          />
        </LazyChunk>
      )}
      {primaryScreen === "activity" && (
        <LazyChunk onDismiss={() => nav("start")}>
          <ActivityScreen state={state} onMenu={() => setDrawer(true)} />
        </LazyChunk>
      )}
      {primaryScreen === "reports" && (
        <LazyChunk onDismiss={() => nav("start")}>
          <ReportsScreen
            state={state}
            month={month}
            view={wide ? "overview" : reportsView}
            onView={(v) => {
              setReportsView(v);
              setAcctView(null);
            }}
            monthDay={monthDay}
            onSelectDay={setMonthDay}
            onOpenEnvelope={openEnvelope}
            onFillGoals={openBudgetFillGoals}
            onEditTxn={(t) => editTxnFrom(t, "reports")}
            onMenu={() => setDrawer(true)}
            onPrev={prev}
            onNext={next}
            onOpenTxns={openTxns}
            selected={wide && !acctView ? (reportsView !== "overview" ? reportsView : "spending") : undefined}
          />
        </LazyChunk>
      )}
      {/* `primaryScreen` is never "addExpense" while `wide` is true (`editReturn` never holds that
          value — see `openAddWide`/`editTxnFrom` — so `primaryScreenFor` never resolves back to
          it); this branch stays reachable for phone, where `primaryScreen === screen` always, and
          the full-screen takeover below IS the current screen. */}
      {primaryScreen === "addExpense" && (
        <AddScreen
          state={state}
          editTxn={editTxn}
          onDone={doneEdit}
          initialTab={addPreset.tab}
          initialImport={addPreset.importSheet}
          duplicateFrom={addPreset.duplicateFrom}
        />
      )}
      {primaryScreen === "settings" && (
        <LazyChunk onDismiss={() => nav("start")}>
          <SettingsScreen onBack={back} onInstall={() => setInstallSheet(true)} />
        </LazyChunk>
      )}
    </>
  ) : null;

  if (startupPresentation(bootStatus) === "splash") return <StartupSplash />;

  if (unauthed || locked || foreign) {
    const bootView = unauthed ? "login" : foreign ? "foreign" : "unlock";
    // Every boot screen is a lazy chunk, and the boot status flips through a SYNC lane (the
    // session store's external-store subscription), so a chunk that suspends with no Suspense
    // boundary above it is a fatal React #426 ("suspended while responding to synchronous
    // input"), not a pending state: on phone the whole tree unmounted and Login never appeared
    // (4.1.4–4.1.7 regression — `LoginScreen` went lazy without joining this boundary). The wide
    // branch below adds its own outer LazyChunk around BootShellWide; this inner one is what
    // makes the PHONE branch safe, so keep every boot screen inside it.
    const bootInner = <LazyChunk>{unauthed ? <LoginScreen /> : foreign ? <ForeignReplicaScreen /> : <UnlockScreen />}</LazyChunk>;

    if (mode !== "phone") {
      return (
        <LazyChunk>
          <BootShellWide mode={mode} view={bootView}>
            {bootInner}
          </BootShellWide>
        </LazyChunk>
      );
    }
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
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", paddingTop: "env(safe-area-inset-top)" }}>{bootInner}</div>
        </div>
      </div>
    );
  }

  if (state && onboarding && mode !== "phone") {
    return (
      <LazyChunk>
        <OnboardingScreen onDone={() => setWizard(false)} />
      </LazyChunk>
    );
  }

  const wideRightSlot: RightSlot =
    primaryScreen === "start"
      ? {
          kind: "action",
          label: wideBoardEdit ? t("Done") : t("Edit widgets"),
          ariaLabel: wideBoardEdit ? t("Done") : t("Edit widgets"),
          onClick: () => setWideBoardEdit(!wideBoardEdit),
        }
      : primaryScreen === "budget"
        ? { kind: "action", label: t("Manage envelopes"), ariaLabel: t("Manage envelopes"), onClick: () => setManageOpen(true) }
        : primaryScreen === "accounts"
          ? { kind: "caption", text: t("Balance {amount}", { amount: M(globalNetTotal) }) }
          : primaryScreen === "reports"
            ? { kind: "caption", text: t("Net worth {amount}", { amount: M(globalNetTotal) }) }
            : primaryScreen === "settings"
              ? { kind: "caption", text: `Enveo v${APP_VERSION}${buildLabel() ? ` · ${buildLabel()}` : ""}` }
              : null;

  if (wide) {
    return (
      <>
        {/* The same global injector the phone card and the login backdrop mount — the wide tree
            returns before either, so without its own instance the wide shell ran on UA defaults:
            body kept its 8px margin (a page-level scrollbar eating real panel width at the 960px
            clamp) and every rule the injector owns (:focus-visible ring, the sp/sk/fu keyframes,
            .rpt-body's first-child reset) was silently off, on wide only. Exactly ONE instance is
            mounted per render — the three returns are exclusive — and the injector itself is
            idempotent (#g4 guard), so a login→wide transition never doubles the style element. */}
        <StyleInjector />
        <LazyChunk>
          <WideShell
            bag={{
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

              state: state!,

              txQuery,
              txFilters,
              onQuickAdd,
              onFillGoals: openBudgetFillGoals,
              onInstall: () => setInstallSheet(true),

              onOpenEnvelope: openEnvelope,
              onEditTxn: (t) => editTxnFrom(t, "reports"),
              monthDay,
              onSelectDay: setMonthDay,

              onOpenReport: openReports,
              onOpenMonthDay,
              boardEdit: wideBoardEdit,

              editTxn,
              addPreset,
              onDoneEdit: doneEdit,

              onAddWide: openAddWide,

              onSelectAccount: selectRailAccount,

              onEditAccountTxn: editAccountTxn,

              onEditEnvelopeTxn: editEnvelopeTxn,

              txnView,
              setTxnView,
              onEditTxnPanel: editTxnFromList,
              onDuplicateTxnPanel: duplicateTxnFromPanel,
            }}
            rightSlot={wideRightSlot}
          >
            {screenEl}
          </WideShell>
        </LazyChunk>
        {}
        <LazyChunk variant="silent">
          <InstallBanner offsetForNav={false} />
        </LazyChunk>
        {installSheetMounted && (
          <LazyChunk variant="overlay" onDismiss={() => setInstallSheet(false)}>
            <InstallSheet show={installSheet} onClose={() => setInstallSheet(false)} />
          </LazyChunk>
        )}
      </>
    );
  }

  return (
    <OpenImportActivity.Provider value={() => nav("activity")}>
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
          {}
          {screen !== "addExpense" && <SyncBadge onOpenSync={() => nav("settings")} />}
          {importManagerStatus === "error" && (
            <div role="status" style={{ position: "absolute", top: "calc(env(safe-area-inset-top) + 13px)", right: 104, zIndex: 62 }}>
              <button
                type="button"
                onClick={() => void importManagerBootstrap.start()}
                aria-label={t("Imports could not be refreshed. Try again.")}
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 999,
                  border: 0,
                  background: "var(--danger)",
                  color: "#fff",
                  cursor: "pointer",
                }}
              >
                !
              </button>
            </div>
          )}
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
              <InstallBanner offsetForNav />
            </LazyChunk>
          )}
          {installSheetMounted && (
            <LazyChunk variant="overlay" onDismiss={() => setInstallSheet(false)}>
              <InstallSheet show={installSheet} onClose={() => setInstallSheet(false)} />
            </LazyChunk>
          )}
          <LazyChunk variant="silent">
            <OptionalStatusChrome showBadges={screen !== "addExpense"} />
          </LazyChunk>
        </div>
      </div>
    </OpenImportActivity.Provider>
  );
}

export default function App() {
  return (
    <SignOutBoundary>
      <AppContent />
    </SignOutBoundary>
  );
}

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
