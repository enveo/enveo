import {
  computeCashflowSeries,
  computeDailySpending,
  computeDaySpending,
  computeEnvelopeTrends,
  computeNetWorthSeries,
  computeSpendingByDimension,
  computeSpendingDetail,
  type DaySpending,
  largestExpenses,
  prevMonth,
  type SpendingDetail,
  type SpendingDimension,
  spendingBaseline,
  type Transaction,
  topPlaces,
} from "@enveo/shared";
import { useMemo, useState } from "react";
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
import { TrendsReport } from "./reports/TrendsReport";
import type { ReportView } from "./reports/types";

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
  onOpenTxns: (f: { envId?: string; envIds?: ReadonlySet<string>; catId?: string; placeId?: string }) => void;
}) {
  const M = useMask();
  const version = useLedgerVersion();
   
  const [dim, setDim] = useState<SpendingDimension>("envelope");
  const [range, setRange] = useState(1);

  const fromMonth = useMemo(() => {
    let m = month;
    for (let i = 0; i < range - 1; i++) m = prevMonth(m);
    return m;
  }, [month, range]);

   
  const netWorth = useMemo(() => {
    if (view !== "assets" && view !== "overview") return [];
    const l = store.getLedger();
    return l ? computeNetWorthSeries(l, month, 12) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, month, view]);
  


  const cashflow = useMemo(() => {
    if (view !== "cashflow" && view !== "overview" && view !== "spending" && view !== "month") return [];
    const l = store.getLedger();
    return l ? computeCashflowSeries(l, month, 12) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, month, view]);
  const spending = useMemo(() => {
    if (view !== "spending") return [];
    const l = store.getLedger();
    return l ? computeSpendingByDimension(l, fromMonth, month, dim) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, fromMonth, month, dim, view]);
   
  const spBaseline = useMemo(() => {
    if (view !== "spending") return new Map<string | null, number>();
    const l = store.getLedger();
    return l ? spendingBaseline(l, month, dim, 3) : new Map<string | null, number>();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, month, dim, view]);
  

  const spendDetailFor = useMemo(() => {
    return (key: string | null): SpendingDetail | null => {
      if (view !== "spending" || key === null) return null;
      const l = store.getLedger();
      return l ? computeSpendingDetail(l, fromMonth, month, dim, key) : null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, fromMonth, month, dim, view]);
   
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
        onView={onView}
        onMenu={onMenu}
        onPrev={onPrev}
        onNext={onNext}
      />
    );
  }

  




  const back = () => onView("overview");
  return (
    <div className="gs" style={{ flex: 1, overflowY: "auto", paddingBottom: 6 }}>
      {view === "assets" && <AssetsReport netWorth={netWorth} state={state} M={M} month={month} onPrev={onPrev} onNext={onNext} onBack={back} />}
      {view === "cashflow" && <CashflowReport cashflow={cashflow} M={M} month={month} onPrev={onPrev} onNext={onNext} onBack={back} />}
      {view === "spending" && (
        <SpendingReport
          spending={spending}
          cashflow={cashflow}
          spBaseline={spBaseline}
          spendDetailFor={spendDetailFor}
          state={state}
          dim={dim}
          setDim={setDim}
          range={range}
          setRange={setRange}
          M={M}
          month={month}
          onPrev={onPrev}
          onNext={onNext}
          onBack={back}
          onOpenTxns={onOpenTxns}
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
