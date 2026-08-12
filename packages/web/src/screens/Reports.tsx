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

/**
 * Reports hub (frame A1, "Gabinet" direction): the global Header, then a tappable net-worth
 * band hero (eyebrow, 30px masked amount, ▲/▼ m/m delta, 12-mo sparkline — on `C.headerBg`
 * when the theme paints a Duet band, plain otherwise, exactly like every other screen's header),
 * then a 2-column grid of six mini-cards, one per subscreen, each showing just its essence.
 * Every card is a `<button>` → `onView(id)`.
 */
function ReportsHub({
  state,
  month,
  netWorth,
  cashflow,
  hubSpending,
  dailySpending,
  envelopeTrends,
  onView,
  onMenu,
  onPrev,
  onNext,
}: {
  state: StateResponse;
  month: string;
  netWorth: { month: string; total: number }[];
  cashflow: { month: string; income: number; expense: number; net: number }[];
  hubSpending: { key: string | null; name: string; amount: number; pct: number }[];
  dailySpending: { date: string; total: number }[];
  envelopeTrends: EnvelopeTrend[];
  onView: (v: ReportView) => void;
  onMenu: () => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const C = useTheme();
  const M = useMask();
  const { t } = useT();
  const { band, hc } = useBand();

  const nwLast = netWorth.at(-1)?.total ?? 0;
  const nwDelta = nwLast - (netWorth.at(-2)?.total ?? nwLast);
  const envColor = new Map(state.envelopes.map((e) => [e.id, e.color]));

  // goals: same math as GoalsReport (card hidden entirely when zero envelopes have a goal)
  const goalRows = state.envelopes
    .filter((e) => !e.archived)
    .flatMap((e) => {
      const gp = goalProgress(e);
      return gp ? [{ e, gp }] : [];
    });
  const fundedSum = goalRows.reduce((s, { e }) => s + Math.min(Math.max(0, e.allocated), e.monthlyTarget ?? 0), 0);
  const targetSum = goalRows.reduce((s, { e }) => s + (e.monthlyTarget ?? 0), 0);
  const pctTotal = targetSum > 0 ? Math.round((fundedSum / targetSum) * 100) : 0;
  const missSum = goalRows.reduce((s, { gp }) => s + gp.missing, 0);

  return (
    <div className="gs" style={{ flex: 1, overflowY: "auto", paddingBottom: 6 }}>
      <div data-band={band || undefined} style={band ? { background: C.headerBg, paddingBottom: 14 } : { paddingBottom: 14 }}>
        <Header month={month} onMenu={onMenu} onPrev={onPrev} onNext={onNext} onBand={band} />
        <button
          onClick={() => onView("assets")}
          style={{
            display: "block",
            width: "100%",
            background: "none",
            border: "none",
            padding: `10px ${P}px 0`,
            textAlign: "left",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          <div style={{ fontSize: 10.5, fontWeight: 750, letterSpacing: "0.17em", textTransform: "uppercase", color: hc(C.headerMute, C.mute) }}>
            {t("Net worth")}
          </div>
          <div style={{ fontSize: 30, fontWeight: 750, color: hc(C.headerInk, C.text), fontVariantNumeric: "tabular-nums" }}>{M(nwLast)}</div>
          <div style={{ fontSize: 12, color: hc(C.headerMute, C.soft) }}>
            {nwDelta !== 0 && (
              <span style={{ color: nwDelta > 0 ? hc(C.headerPos, C.pos) : hc(C.headerNeg, C.neg), fontWeight: 650 }}>
                {nwDelta > 0 ? "▲ +" : "▼ "}
                {M(Math.abs(nwDelta))}
              </span>
            )}{" "}
            {t("m/m")} · {t("details")} ›
          </div>
          <Sparkline points={netWorth} stroke={hc(C.headerInk, "var(--accent)")} dotColor={hc(C.headerPos, C.pos)} />
        </button>
      </div>
      <div style={{ padding: `10px ${P}px 0`, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <CashflowMini cashflow={cashflow} onView={onView} M={M} />
        <SpendingMini rows={hubSpending} envColor={envColor} cashflow={cashflow} onView={onView} M={M} />
        <BudgetsMini envelopes={state.envelopes} onView={onView} M={M} />
        {goalRows.length > 0 && <GoalsMini pctTotal={pctTotal} missSum={missSum} onView={onView} M={M} />}
        <MonthMini days={dailySpending} onView={onView} M={M} />
        <TrendsMini trends={envelopeTrends} onView={onView} />
      </div>
    </div>
  );
}

/** Mini-card button shell shared by all six hub cards: quiet label row (title + chevron) + body.
 *
 * The grid (ReportsHub) stretches every card in a row to the tallest sibling's height (grid
 * items default to `align-items: stretch`), so a short-content card (Goals/Month/Trends) ends
 * up taller than its own content needs. A NATIVE `<button>` vertically CENTERS its children in
 * that extra space by default — regardless of `display: block` on the button itself, since the
 * browser's own form-control rendering still applies — so short cards centered their title while
 * taller cards (whose content already filled the row) looked top-aligned by coincidence. Giving
 * the button its own top-aligned flex layout (column, default main-axis `flex-start`) overrides
 * that native centering so every card top-aligns its content, tall or short. */
function MiniCard({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  const C = useTheme();
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        justifyContent: "flex-start",
        width: "100%",
        background: C.card,
        border: "none",
        boxShadow: "0 1px 3px rgba(20,20,28,0.06)",
        borderRadius: 14,
        padding: "12px 13px",
        cursor: "pointer",
        textAlign: "left",
        fontFamily: "inherit",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 11, fontWeight: 700, color: C.soft, marginBottom: 6 }}>
        <span>{title}</span>
        <span style={{ color: C.mute, fontWeight: 400 }}>›</span>
      </div>
      {children}
    </button>
  );
}

/** Cashflow mini-card: 12-mo diverging columns (up in C.pos / down in C.neg from a C.line
 *  baseline), current month's net (sign-colored), and the current savings rate. */
function CashflowMini({
  cashflow,
  onView,
  M,
}: {
  cashflow: { month: string; income: number; expense: number; net: number }[];
  onView: (v: ReportView) => void;
  M: Mask;
}) {
  const C = useTheme();
  const { t } = useT();
  const barW = 7,
    gap = 2,
    H = 34,
    base = H / 2,
    maxH = 15;
  const W = cashflow.length * barW + Math.max(0, cashflow.length - 1) * gap;
  const maxAbs = Math.max(...cashflow.map((p) => Math.abs(p.net)), 1);
  const net = cashflow.at(-1)?.net ?? 0;
  const sr = savingsRate(cashflow);
  const pct = sr.current !== null ? Math.round(sr.current * 100) : "–";
  return (
    <MiniCard title={t("Cash flow")} onClick={() => onView("cashflow")}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} aria-hidden="true" style={{ display: "block" }}>
        <line x1={0} y1={base} x2={W} y2={base} style={{ stroke: C.line }} strokeWidth={1} />
        {cashflow.map((p, i) => {
          const h = Math.max(1, Math.round((Math.abs(p.net) / maxAbs) * maxH));
          const x = i * (barW + gap);
          const y = p.net >= 0 ? base - h : base;
          return <rect key={p.month} x={x} y={y} width={barW} height={h} rx={2} style={{ fill: p.net >= 0 ? C.pos : C.neg }} />;
        })}
      </svg>
      <div style={{ fontSize: 17, fontWeight: 750, color: net >= 0 ? C.pos : C.neg, marginTop: 6, fontVariantNumeric: "tabular-nums" }}>
        {net >= 0 ? "+" : "−"}
        {M(Math.abs(net))}
      </div>
      <div style={{ fontSize: 11, color: C.mute }}>{t("savings rate {pct}%", { pct })}</div>
    </MiniCard>
  );
}

const SPENDING_FALLBACK_COLORS = ["#8f84a8", "#aed6ea", "#ccd9b6", "#f0c84f"];

/** Spending mini-card: SegBar of the top-4 envelopes (own color) + rest in C.line, month total,
 *  and a DeltaTag against the median of the 3 preceding months' cashflow expense. */
function SpendingMini({
  rows,
  envColor,
  cashflow,
  onView,
  M,
}: {
  rows: { key: string | null; name: string; amount: number; pct: number }[];
  envColor: Map<string, string>;
  cashflow: { month: string; income: number; expense: number; net: number }[];
  onView: (v: ReportView) => void;
  M: Mask;
}) {
  const C = useTheme();
  const { t } = useT();
  const top = rows.slice(0, 4);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const restAmt = Math.max(0, total - top.reduce((s, r) => s + r.amount, 0));
  const colorOf = (r: { key: string | null }, i: number) => (r.key && envColor.get(r.key)) || SPENDING_FALLBACK_COLORS[i % SPENDING_FALLBACK_COLORS.length]!;
  const segments = [
    ...top.map((r, i) => ({ weight: Math.max(0, r.amount), color: colorOf(r, i) })),
    ...(restAmt > 0 ? [{ weight: restAmt, color: C.line }] : []),
  ];
  // baseline = median of the 3 months BEFORE the current one (cashflow always ends at `month`)
  const baseline = median(cashflow.slice(-4, -1).map((p) => p.expense));
  const deltaPct = baseline > 0 ? (total - baseline) / baseline : null;
  return (
    <MiniCard title={t("Spending")} onClick={() => onView("spending")}>
      <SegBar segments={segments} />
      <div style={{ fontSize: 17, fontWeight: 750, color: C.text, marginTop: 8, fontVariantNumeric: "tabular-nums" }}>{M(total)}</div>
      <div style={{ fontSize: 11, color: C.mute }}>
        <DeltaTag pct={deltaPct} /> {t("vs 3 mo")}
      </div>
    </MiniCard>
  );
}

/** Budgets mini-card: over/near/OK count pills (triage colors on quiet chip backgrounds), plus
 *  the total overspend amount when any envelope is over. Threshold parity with BudgetsReport via
 *  budgetsSummary (Task 9 refines the rule; this card just consumes it). */
function BudgetsMini({ envelopes, onView, M }: { envelopes: StateResponse["envelopes"]; onView: (v: ReportView) => void; M: Mask }) {
  const C = useTheme();
  const { t, tp } = useT();
  const bs = budgetsSummary(envelopes);
  // Same classifier as budgetsSummary (classifyBudget: over = left < 0, on the RAW unfloored
  // budget) — NOT an inline `pct > 100` check, which misses the zero-budget boundary (raw
  // budget <= 0 + any spend → pct lands at exactly 100, left already negative; adb4c43 fixed
  // this for the pill counters, budgetsOverAmount mirrors the same rule for the € amount).
  const overAmt = budgetsOverAmount(envelopes);
  const pill = (label: string, bg: string, color: string, key: string) => (
    <span
      key={key}
      style={{ display: "inline-flex", alignItems: "center", fontSize: 11.5, fontWeight: 650, borderRadius: 9, padding: "4px 9px", background: bg, color }}
    >
      {label}
    </span>
  );
  return (
    <MiniCard title={t("Budgets")} onClick={() => onView("budgets")}>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
        {pill(tp("{n} over | {n} over", bs.over), "var(--danger-14)", C.neg, "over")}
        {pill(t("{n} near limit", { n: bs.near }), C.chip, C.warn, "near")}
        {pill(t("{n} OK", { n: bs.ok }), C.chip, C.pos, "ok")}
      </div>
      {overAmt > 0 && (
        <div style={{ fontSize: 11, color: C.neg, marginTop: 8, fontVariantNumeric: "tabular-nums" }}>{t("{amount} over budget", { amount: M(overAmt) })}</div>
      )}
    </MiniCard>
  );
}

/** Goals mini-card: GoalRing + aggregate funded % + funded/missing line — hidden by the caller
 *  when no envelope has a goal (today's overview behavior, unchanged). */
function GoalsMini({ pctTotal, missSum, onView, M }: { pctTotal: number; missSum: number; onView: (v: ReportView) => void; M: Mask }) {
  const C = useTheme();
  const { t } = useT();
  const funded = missSum === 0;
  return (
    <MiniCard title={t("Goals")} onClick={() => onView("goals")}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <GoalRing pct={pctTotal} size={30} />
        <div>
          <div style={{ fontSize: 17, fontWeight: 750, color: funded ? C.pos : C.text, fontVariantNumeric: "tabular-nums" }}>{pctTotal}%</div>
          <div style={{ fontSize: 11, color: funded ? C.pos : C.mute }}>{funded ? t("funded ✓") : t("{amount} to go", { amount: M(missSum) })}</div>
        </div>
      </div>
    </MiniCard>
  );
}

/** Month mini-card: a 10-cell intensity strip for the first 10 days of the month (shared
 *  `heatColor` ramp with CalendarHeatmap, scaled against the WHOLE month's max so it reads
 *  consistently with the Task 11 subscreen), plus the month's average daily spend. */
function MonthMini({ days, onView, M }: { days: { date: string; total: number }[]; onView: (v: ReportView) => void; M: Mask }) {
  const C = useTheme();
  const { t } = useT();
  const first10 = days.slice(0, 10);
  const max = Math.max(...days.map((d) => d.total), 1);
  const avg = days.length > 0 ? Math.round(days.reduce((s, d) => s + d.total, 0) / days.length) : 0;
  return (
    <MiniCard title={t("Month in a nutshell")} onClick={() => onView("month")}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(10, 1fr)", gap: 2.5 }}>
        {first10.map((d) => (
          <span key={d.date} style={{ aspectRatio: "1", borderRadius: 3, background: heatColor(d.total, max, C) }} />
        ))}
      </div>
      <div style={{ fontSize: 11, color: C.mute, marginTop: 8, fontVariantNumeric: "tabular-nums" }}>{t("avg {amount}/day", { amount: M(avg) })}</div>
    </MiniCard>
  );
}

/** Trends mini-card: the top-2 biggest-moving envelopes (already sorted by computeEnvelopeTrends),
 *  a mini TrendSpark (red rising / green falling / muted flat) and an arrow per row. */
function TrendsMini({ trends, onView }: { trends: EnvelopeTrend[]; onView: (v: ReportView) => void }) {
  const C = useTheme();
  const { t } = useT();
  const top = trends.slice(0, 2);
  return (
    <MiniCard title={t("Envelope trends")} onClick={() => onView("trends")}>
      {top.length === 0 && <div style={{ fontSize: 11.5, color: C.mute }}>{t("Not enough data yet.")}</div>}
      {top.map((tr) => {
        const color = trendColor(tr, C);
        const rising = color === C.neg;
        const falling = color === C.pos;
        return (
          <div key={tr.id} style={{ marginBottom: 4 }}>
            <TrendSpark series={tr.series} color={color} w={150} h={16} />
            <div style={{ fontSize: 11, color: C.soft, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {tr.name} {rising && <span style={{ color: C.neg, fontWeight: 650 }}>↑</span>}
              {falling && <span style={{ color: C.pos, fontWeight: 650 }}>↓</span>}
            </div>
          </div>
        );
      })}
    </MiniCard>
  );
}
