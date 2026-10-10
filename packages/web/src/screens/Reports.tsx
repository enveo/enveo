import {
  computeCashflowSeries,
  computeDailySpending,
  computeDaySpending,
  computeEnvelopeTrends,
  computeNetWorthSeries,
  computeSpendingByDimension,
  type DaySpending,
  largestExpenses,
  type Transaction,
  topPlaces,
} from "@enveo/shared";
import { useMemo } from "react";
import { type StateResponse, useLedgerVersion } from "../lib/api";
import { useMask } from "../lib/contexts";
import { store } from "../lib/store";
import { AssetsReport } from "./reports/AssetsReport";
import { BudgetsReport } from "./reports/BudgetsReport";
import { CashflowReport } from "./reports/CashflowReport";
import { GoalsReport } from "./reports/GoalsReport";
import { MonthReport } from "./reports/MonthReport";
import { ReportsHub } from "./reports/ReportsHub";
import { SpendingReport } from "./reports/SpendingReport";
import { monthEnd, monthStart, type SpendingView, withPeriod } from "./reports/spendingView";
import { TrendsReport } from "./reports/TrendsReport";
import type { ReportTab, ReportView } from "./reports/types";

export type { ReportTab, ReportView } from "./reports/types";

export function ReportsScreen({
  state,
  month,
  view,
  onView,
  monthDay,
  onSelectDay,
  onOpenEnvelope,
  onFillGoals,
  onEditTxn,
  onMenu,
  onPrev,
  onNext,
  onOpenTxns,
  selected,
  spending,
}: {
  state: StateResponse;
  month: string;
  view: ReportView;
  onView: (v: ReportView) => void;
  monthDay: string | null;
  onSelectDay: (date: string | null) => void;
  onOpenEnvelope: (envId: string, month: string) => void;
  onFillGoals: () => void;
  onEditTxn: (t: Transaction) => void;
  onMenu: () => void;
  onPrev: () => void;
  onNext: () => void;
  onOpenTxns: (f: { envId?: string; envIds?: ReadonlySet<string>; catId?: string; placeId?: string; date?: string }) => void;

  selected?: ReportTab;
  /** The Spending report's state, owned by App. Absent where Spending cannot open (side panel). */
  spending?: {
    view: SpendingView;
    setView: (v: SpendingView, replace?: boolean) => void;
    /** History-aware: goes up one drill level. */
    onBack: () => void;
    onOpenTxn: (txnId: string) => void;
    /** Wide layout: the transaction shown in the side panel instead of the filters. */
    txnId: string | null;
    /** Wide layout: show the filters in the side panel. */
    onOpenFilters?: () => void;
  };
}) {
  const M = useMask();
  const version = useLedgerVersion();

  const netWorth = useMemo(() => {
    if (view !== "assets" && view !== "overview") return [];
    const l = store.getLedger();
    return l ? computeNetWorthSeries(l, month, 12) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, month, view]);

  const cashflow = useMemo(() => {
    if (view !== "cashflow" && view !== "overview" && view !== "month") return [];
    const l = store.getLedger();
    return l ? computeCashflowSeries(l, month, 12) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, month, view]);
  const hubSpending = useMemo(() => {
    if (view !== "overview") return [];
    const l = store.getLedger();
    return l ? computeSpendingByDimension(l, month, month, "envelope") : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, month, view]);

  const dailySpending = useMemo(() => {
    if (view !== "overview" && view !== "month") return [];
    const l = store.getLedger();
    return l ? computeDailySpending(l, month) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, month, view]);

  const envelopeTrends = useMemo(() => {
    if (view !== "overview" && view !== "trends") return [];
    const l = store.getLedger();
    return l ? computeEnvelopeTrends(l, month, 6) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, month, view]);

  const monthPlaces = useMemo(() => {
    if (view !== "month") return [];
    const l = store.getLedger();
    return l ? topPlaces(l, month, month, 5) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, month, view]);
  const monthLargest = useMemo(() => {
    if (view !== "month") return [];
    const l = store.getLedger();
    return l ? largestExpenses(l, month, 5) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, month, view]);

  const dayDetail = useMemo((): DaySpending | null => {
    if (view !== "month" || !monthDay) return null;
    const l = store.getLedger();
    return l ? computeDaySpending(l, monthDay) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, monthDay, view]);

  if (view === "overview") {
    return (
      <ReportsHub
        state={state}
        month={month}
        netWorth={netWorth}
        cashflow={cashflow}
        hubSpending={hubSpending}
        dailySpending={dailySpending}
        envelopeTrends={envelopeTrends}
        onView={(v) => {
          // The hub's Spending card shows the viewed month; its report opens on that month.
          if (v === "spending" && spending)
            spending.setView({ ...spending.view, from: monthStart(month), to: monthEnd(month), custom: false, path: [], grouping: null });
          onView(v);
        }}
        onMenu={onMenu}
        onPrev={onPrev}
        onNext={onNext}
        selected={selected}
      />
    );
  }

  const back = () => onView("overview");
  return (
    <div className="gs" style={{ flex: 1, overflowY: "auto", paddingBottom: 6 }}>
      {view === "assets" && <AssetsReport netWorth={netWorth} state={state} M={M} month={month} onPrev={onPrev} onNext={onNext} onBack={back} />}
      {view === "cashflow" && <CashflowReport cashflow={cashflow} M={M} month={month} onPrev={onPrev} onNext={onNext} onBack={back} />}
      {view === "spending" && spending && (
        <SpendingReport
          state={state}
          view={withPeriod(spending.view)}
          setView={spending.setView}
          onBack={spending.onBack}
          onOpenTxn={spending.onOpenTxn}
          selectedTxnId={spending.txnId}
          filtersOpen={spending.onOpenFilters !== undefined && spending.txnId === null}
          onOpenFilters={spending.onOpenFilters}
        />
      )}
      {view === "budgets" && <BudgetsReport state={state} M={M} onOpenEnvelope={onOpenEnvelope} onPrev={onPrev} onNext={onNext} onBack={back} />}
      {view === "goals" && (
        <GoalsReport state={state} M={M} onOpenEnvelope={onOpenEnvelope} onFillGoals={onFillGoals} onPrev={onPrev} onNext={onNext} onBack={back} />
      )}
      {view === "month" && (
        <MonthReport
          state={state}
          cashflow={cashflow}
          days={dailySpending}
          places={monthPlaces}
          largest={monthLargest}
          monthDay={monthDay}
          onSelectDay={onSelectDay}
          dayDetail={dayDetail}
          onEditTxn={onEditTxn}
          onOpenTxns={onOpenTxns}
          M={M}
          month={month}
          onPrev={onPrev}
          onNext={onNext}
          onBack={back}
        />
      )}
      {view === "trends" && (
        <TrendsReport trends={envelopeTrends} M={M} month={month} onOpenEnvelope={onOpenEnvelope} onPrev={onPrev} onNext={onNext} onBack={back} />
      )}
    </div>
  );
}
