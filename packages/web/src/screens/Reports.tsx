import {
  computeCashflowSeries,
  computeDailySpending,
  computeEnvelopeTrends,
  computeNetWorthSeries,
  computeSpendingByDimension,
  type EnvelopeTrend,
  largestExpenses,
  median,
  prevMonth,
  type SpendingDimension,
  savingsRate,
  spendingBaseline,
  topPlaces,
} from "@enveo/shared";
import { type ReactNode, useMemo, useState } from "react";
import { Header } from "../components/chrome";
import { GoalRing, useBand } from "../components/kit";
import { Bar, CalendarHeatmap, DeltaTag, heatColor, ReportShell, SegBar, Sparkline, TrendSpark } from "../components/reportKit";
import { type StateResponse, useLedgerVersion } from "../lib/api";
import { useMask, useTheme } from "../lib/contexts";
import { monthLabel, shortDate } from "../lib/dates";
import { goalProgress } from "../lib/goals";
import { type Message, msg, useT } from "../lib/i18n";
import { budgetsOverAmount, budgetsSummary, classifyBudget } from "../lib/reportSummary";
import { store } from "../lib/store";
import { ENV_PALETTE, P, TEAL, type Theme, tint } from "../lib/theme";

import { AssetsReport } from "./reports/AssetsReport";
import { BudgetsReport } from "./reports/BudgetsReport";
import { CashflowReport } from "./reports/CashflowReport";
import { trendColor } from "./reports/charts";
import { GoalsReport } from "./reports/GoalsReport";
import { MonthReport } from "./reports/MonthReport";
import { ReportsHub } from "./reports/ReportsHub";
import { SpendingReport } from "./reports/SpendingReport";
import { TrendsReport } from "./reports/TrendsReport";
import { type Mask, type ReportTab, type ReportView, TITLES } from "./reports/types";

export type { ReportTab, ReportView } from "./reports/types";

export function ReportsScreen({
  state,
  month,
  view,
  onView,
  onOpenEnvelope,
  onFillGoals,
  onMenu,
  onPrev,
  onNext,
}: {
  state: StateResponse;
  month: string;
  view: ReportView;
  onView: (v: ReportView) => void;
  onOpenEnvelope: (envId: string, month: string) => void;
  onFillGoals: () => void;
  onMenu: () => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const M = useMask();
  const version = useLedgerVersion();
  // "Envelope" by default — in an envelope app it's the natural breakdown (categories are often empty)
  const [dim, setDim] = useState<SpendingDimension>("envelope");
  const [range, setRange] = useState(1);

  const fromMonth = useMemo(() => {
    let m = month;
    for (let i = 0; i < range - 1; i++) m = prevMonth(m);
    return m;
  }, [month, range]);

  // series computed ONLY where needed: a subscreen or an overview card
  const netWorth = useMemo(() => {
    if (view !== "assets" && view !== "overview") return [];
    const l = store.getLedger();
    return l ? computeNetWorthSeries(l, month, 12) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, month, view]);
  // also needed by "spending" (period-total delta vs the 3-mo median of expense) and "month"
  // (hero net + savings rate, current-month point — the 12-mo window costs nothing extra and lets
  // it share this same memo rather than compute a redundant 1-point series)
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
  // per-row baseline (median of the 3 months BEFORE `month`, same dimension) — row delta tags, range===1 only
  const spBaseline = useMemo(() => {
    if (view !== "spending") return new Map<string | null, number>();
    const l = store.getLedger();
    return l ? spendingBaseline(l, month, dim, 3) : new Map<string | null, number>();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, month, dim, view]);
  // hub-only series: current month's envelope breakdown, this month's daily totals, 6-mo envelope trends
  const hubSpending = useMemo(() => {
    if (view !== "overview") return [];
    const l = store.getLedger();
    return l ? computeSpendingByDimension(l, month, month, "envelope") : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, month, view]);
  // also needed by "month" (the day-by-day heatmap — same month, same computation)
  const dailySpending = useMemo(() => {
    if (view !== "overview" && view !== "month") return [];
    const l = store.getLedger();
    return l ? computeDailySpending(l, month) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, month, view]);
  // also the sole source for the "trends" subscreen — same 6-mo window as the hub card, so no
  // separate memo is needed there (Task 12).
  const envelopeTrends = useMemo(() => {
    if (view !== "overview" && view !== "trends") return [];
    const l = store.getLedger();
    return l ? computeEnvelopeTrends(l, month, 6) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, month, view]);
  // "month" subscreen only: this month's top places (visit-count led) and largest individual
  // expenses — both single-month windows (fromMonth === toMonth === month for topPlaces).
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

  // ── Hub: global Header + net-worth band hero + a 2-col grid of six mini-cards ──
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

  // ── Subscreen: each *Report component renders its own `ReportShell` — band eyebrow/hero/sub/
  // chart are per-report, computed from what each screen already has; every one of the five now
  // fully owns its band content (Spending/Budgets: Task 9; Assets/Cashflow/Goals: Task 10).
  // `ReportShell`'s body carries the `fi` (opacity-only) animation — `fu`/transform would break
  // position:fixed sheets rendered inside.
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
        />
      )}
      {view === "budgets" && <BudgetsReport state={state} M={M} onOpenEnvelope={onOpenEnvelope} onPrev={onPrev} onNext={onNext} onBack={back} />}
      {view === "goals" && (
        <GoalsReport state={state} M={M} onOpenEnvelope={onOpenEnvelope} onFillGoals={onFillGoals} onPrev={onPrev} onNext={onNext} onBack={back} />
      )}
      {view === "month" && (
        <MonthReport
          cashflow={cashflow}
          days={dailySpending}
          places={monthPlaces}
          largest={monthLargest}
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
