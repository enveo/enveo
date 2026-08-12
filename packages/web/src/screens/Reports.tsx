import { useMemo, useState, type ReactNode } from "react";
import {
  computeCashflowSeries,
  computeDailySpending,
  computeEnvelopeTrends,
  computeNetWorthSeries,
  computeSpendingByDimension,
  largestExpenses,
  median,
  prevMonth,
  savingsRate,
  spendingBaseline,
  topPlaces,
  type EnvelopeTrend,
  type SpendingDimension,
} from "@enveo/shared";
import { useLedgerVersion, type StateResponse } from "../lib/api";
import { store } from "../lib/store";
import { Header } from "../components/chrome";
import { GoalRing, useBand } from "../components/kit";
import { Bar, CalendarHeatmap, DeltaTag, heatColor, ReportShell, SegBar, Sparkline, TrendSpark } from "../components/reportKit";
import { useMask, useTheme } from "../lib/contexts";
import { monthLabel, shortDate } from "../lib/dates";
import { goalProgress } from "../lib/goals";
import { useT, type Message, msg } from "../lib/i18n";
import { budgetsOverAmount, budgetsSummary, classifyBudget } from "../lib/reportSummary";
import { ENV_PALETTE, P, TEAL, tint, type Theme } from "../lib/theme";

export type ReportTab = "assets" | "cashflow" | "spending" | "budgets" | "goals" | "month" | "trends";
/** Reports view: hub (band hero + mini-card grid) or a full-screen report subscreen. */
export type ReportView = "overview" | ReportTab;
const TITLES: Record<ReportTab, Message> = {
  assets: msg("Wealth"),
  cashflow: msg("Cash flow"),
  spending: msg("Spending"),
  budgets: msg("Budgets"),
  goals: msg("Goals"),
  month: msg("Month in a nutshell"),
  trends: msg("Envelope trends"),
};
const DIMENSIONS: Array<{ id: SpendingDimension; label: Message }> = [
  { id: "category", label: msg("Category") },
  { id: "envelope", label: msg("Envelope") },
  { id: "group", label: msg("Group") },
  { id: "place", label: msg("Place") },
];
const RANGES: Array<{ n: number; label: Message }> = [
  { n: 1, label: msg("1 mo") },
  { n: 3, label: msg("3 mo") },
  { n: 6, label: msg("6 mo") },
  { n: 12, label: msg("12 mo") },
];
type Mask = (n: number) => string;

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

/** Stroke/verdict color for an envelope trend: `C.mute` when there is no baseline to compare
 *  against (`deltaPct` null — nothing spent in the months before the last one) or the series is
 *  flat (`last === baseline`), else `C.neg` on the way up / `C.pos` on the way down — spending
 *  semantics, rising is the "bad" direction. Shared by the hub's TrendsMini and the Trends
 *  subscreen (Task 12) so a row's TrendSpark stroke and its rising/falling arrow always agree —
 *  the original TrendsMini compared `last`/`baseline` alone and could paint C.neg/C.pos even with
 *  no baseline to compare against (baseline 0, deltaPct null); that case now reads as neutral. */
function trendColor(tr: EnvelopeTrend, C: Theme): string {
  if (tr.deltaPct === null || tr.last === tr.baseline) return C.mute;
  return tr.last > tr.baseline ? C.neg : C.pos;
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

/**
 * "Assets" tab (Gabinet grammar, no dedicated mockup frame — follows A2/A3): band hero = net
 * worth + ▲/▼ m/m delta, `NetWorthChart` itself painted IN the band (`onBand`) so on Duet it
 * reads as a cream line on navy rather than the invisible navy-on-navy TEAL would give. Body:
 * the "Wealth" section (envelopes flagged `isSavings`) unchanged in content, bars via `Bar`.
 */
function AssetsReport({
  netWorth,
  state,
  M,
  month,
  onPrev,
  onNext,
  onBack,
}: {
  netWorth: { month: string; total: number }[];
  state: StateResponse;
  M: Mask;
  month: string;
  onPrev: () => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const C = useTheme();
  const { t } = useT();
  const { band } = useBand();
  const nwLast = netWorth.at(-1)?.total ?? 0;
  const nwDelta = nwLast - (netWorth.at(-2)?.total ?? nwLast);
  const savings = state.envelopes.filter((e) => !e.archived && e.isSavings);
  const total = savings.reduce((s, e) => s + e.available, 0);
  const pct = nwLast !== 0 ? Math.round((total / nwLast) * 100) : 0;
  const max = Math.max(...savings.map((e) => Math.abs(e.available)), 1);
  return (
    <ReportShell
      title={t(TITLES.assets)}
      month={month}
      onPrev={onPrev}
      onNext={onNext}
      onBack={onBack}
      eyebrow={t("Net worth")}
      hero={M(nwLast)}
      sub={
        nwDelta !== 0 ? (
          <>
            {nwDelta > 0 ? "▲ +" : "▼ "}
            {M(Math.abs(nwDelta))} {t("m/m")}
          </>
        ) : undefined
      }
      bandChart={netWorth.length > 0 ? <NetWorthChart points={netWorth} mask={M} onBand={band} /> : undefined}
    >
      <div style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: "20px 0 4px" }}>{t("Wealth")}</div>
      {savings.length === 0 ? (
        <div style={{ fontSize: 12.5, color: C.mute, padding: "4px 0", lineHeight: 1.6 }}>
          {t(
            "No envelopes are marked as wealth envelopes. Open an envelope → Edit and turn on “Wealth envelope” (e.g. Bonds, Retirement, Savings), and we will count them here.",
          )}
        </div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
            <span style={{ fontSize: 20, fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums" }}>{M(total)}</span>
            <span style={{ fontSize: 12.5, color: C.soft }}>{t("{pct}% of net worth", { pct })}</span>
          </div>
          {savings.map((e) => (
            <div key={e.id} style={{ marginBottom: 9 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                <span style={{ fontSize: 13, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: C.text, fontVariantNumeric: "tabular-nums", flexShrink: 0, marginLeft: 8 }}>
                  {M(e.available)}
                </span>
              </div>
              <Bar pct={(Math.max(0, e.available) / max) * 100} color={TEAL} />
            </div>
          ))}
        </>
      )}
    </ReportShell>
  );
}

/**
 * "Cashflow" tab (Gabinet grammar, no dedicated mockup frame — follows A2/A3): band hero = the
 * 12-mo net total, sign-colored on the band. Eyebrow reads "Last 12 months" (shared with Trends'
 * window-label idiom) rather than "Cash flow", which just repeated the screen title above it.
 *
 * Task P1 fix: the sub used to show the CURRENT month's savings rate next to a 12-MONTH hero — on
 * real data a single bad month could read −58% under a positive +45,945 zł hero, i.e. two
 * different periods presented as if they agreed. The sub now reports the same 12-mo AGGREGATE
 * rate as the hero (`net/income` over the whole window, so the sign always matches), plus the
 * trailing-11-month median for context (`shared/savingsRate().median`, unchanged) — built from ONE
 * message per case rather than concatenated fragments so every locale can reorder the clause.
 *
 * `bandChart` (`CashflowBandChart`, below) repeats the monthly shape as diverging columns on the
 * band itself. Body: the Income/Expense/Net stat trio, then the existing diverging monthly bars —
 * each row now labeled with a 2-digit year suffix ("sie ’25") since a 12-mo window almost always
 * crosses a year boundary; applied to EVERY row for consistency, and the label column widened
 * 48→82px to fit it — measured live (agent-browser, PL locale): `monthLabel` uses the FULL
 * Intl "long" month name (Polish has no short form here), and "Październik’25" alone needs 79px
 * (`scrollWidth`), so 64px — the initially-planned width — still clipped into the bar column.
 */
function CashflowReport({
  cashflow,
  M,
  month,
  onPrev,
  onNext,
  onBack,
}: {
  cashflow: { month: string; income: number; expense: number; net: number }[];
  M: Mask;
  month: string;
  onPrev: () => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const C = useTheme();
  const { t, lang } = useT();
  const { hc } = useBand();
  const totIncome = cashflow.reduce((s, p) => s + p.income, 0);
  const totExpense = cashflow.reduce((s, p) => s + p.expense, 0);
  const totNet = totIncome - totExpense;
  const maxAbs = Math.max(...cashflow.map((p) => Math.abs(p.net)), 1);
  // 12-mo AGGREGATE rate — same window as the hero, so hero/sub never disagree in sign.
  const aggRate = totIncome > 0 ? totNet / totIncome : null;
  const aggPct = aggRate !== null ? Math.round(aggRate * 100) : null;
  const srMedian = savingsRate(cashflow).median;
  const srNormPct = srMedian !== null ? Math.round(srMedian * 100) : null;
  // Month label with a 2-digit year suffix ("sie ’25") — the year is numeric so it needs no i18n
  // key; captures `lang` from the closure above.
  const rowLabel = (m: string) => `${monthLabel(m, lang).split(" ")[0]}’${m.slice(2, 4)}`;
  return (
    <ReportShell
      title={t(TITLES.cashflow)}
      month={month}
      onPrev={onPrev}
      onNext={onNext}
      onBack={onBack}
      eyebrow={t("Last 12 months")}
      hero={
        <span style={{ color: totNet >= 0 ? hc(C.headerPos, C.pos) : hc(C.headerNeg, C.neg) }}>
          {totNet >= 0 ? "+" : "−"}
          {M(Math.abs(totNet))}
        </span>
      }
      sub={
        aggPct !== null
          ? srNormPct !== null
            ? t("savings rate {pct}% · monthly median {norm}%", { pct: aggPct, norm: srNormPct })
            : t("savings rate {pct}%", { pct: aggPct })
          : undefined
      }
      bandChart={cashflow.length > 0 ? <CashflowBandChart cashflow={cashflow} /> : undefined}
    >
      <div style={{ display: "flex", gap: 8, marginBottom: 14, marginTop: 4 }}>
        {(
          [
            [t("Income"), totIncome, C.pos],
            [t("Expense"), totExpense, C.neg],
            [t("Net"), totNet, totNet >= 0 ? C.pos : C.neg],
          ] as const
        ).map(([label, val, col]) => (
          <div key={label} style={{ flex: 1 }}>
            <div style={{ fontSize: 10.5, color: C.soft }}>{label}</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: col, fontVariantNumeric: "tabular-nums" }}>{M(val)}</div>
          </div>
        ))}
      </div>
      {cashflow.map((p) => {
        const w = (Math.abs(p.net) / maxAbs) * 50;
        return (
          <div key={p.month} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
            <span style={{ fontSize: 11, color: C.soft, width: 82, textAlign: "right", flexShrink: 0 }}>{rowLabel(p.month)}</span>
            <div style={{ flex: 1, position: "relative", height: 12 }}>
              <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: C.line }} />
              <div
                style={{
                  position: "absolute",
                  top: 2,
                  height: 8,
                  borderRadius: 3,
                  background: p.net >= 0 ? C.pos : C.neg,
                  left: p.net >= 0 ? "50%" : `${50 - w}%`,
                  width: `${w}%`,
                }}
              />
            </div>
            <span
              style={{
                fontSize: 11.5,
                fontWeight: 600,
                color: p.net >= 0 ? C.pos : C.neg,
                width: 80,
                textAlign: "right",
                flexShrink: 0,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {p.net >= 0 ? "+" : "−"}
              {M(Math.abs(p.net))}
            </span>
          </div>
        );
      })}
    </ReportShell>
  );
}

/** Cashflow band chart (Task P1): 12-mo diverging columns painted on the band, same idiom as the
 *  hub's `CashflowMini` chart but taller (height ~60 vs 34) and painted with band-aware tokens so
 *  it stays legible on a Duet navy band as well as a plain theme. A net-ZERO month is not "up" or
 *  "down" — it renders a 1px tick sitting ON the baseline in the muted color rather than a fake
 *  colored bar (a zero-height bar would just look like a rendering bug otherwise).
 *
 * v2 fix (design-pass follow-up on the v1 commit): the viewBox used to be sized to the bars' own
 * pixel geometry (barW=6·12 + gap=2·11 ≈ 94 units) rather than the band's actual width. An SVG
 * with `width="100%"` + a FIXED `height` fits its viewBox via the default `preserveAspectRatio=
 * "xMidYMid meet"`, which scales by the SMALLER of the two axis ratios — a ~94-unit-wide viewBox
 * against a ~360px-wide, 56px-tall box binds on the height axis (scale 1) and leaves the bars a
 * tiny centered cluster with ~130px of navy margin on each side. The fix is a FULL-width viewBox
 * (~358, matching the band's available width — the same idiom `NetWorthChart`/`Sparkline` already
 * use) with bar geometry recomputed to fill it (`barW = (W − (n−1)·gap) / n`), NOT
 * `preserveAspectRatio="none"` — that would non-uniformly stretch the rounded caps into ellipses. */
function CashflowBandChart({ cashflow }: { cashflow: { month: string; income: number; expense: number; net: number }[] }) {
  const C = useTheme();
  const { hc } = useBand();
  const W = 358,
    gap = 6,
    H = 60,
    base = H / 2,
    maxH = 24;
  const n = cashflow.length;
  const barW = (W - Math.max(0, n - 1) * gap) / n;
  const maxAbs = Math.max(...cashflow.map((p) => Math.abs(p.net)), 1);
  const posColor = hc(C.headerPos, C.pos);
  const negColor = hc(C.headerNeg, C.neg);
  const baseColor = hc(tint(C.headerInk, 0.25), C.line);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} aria-hidden="true" style={{ display: "block", marginTop: 10 }}>
      <line x1={0} y1={base} x2={W} y2={base} style={{ stroke: baseColor }} strokeWidth={1} />
      {cashflow.map((p, i) => {
        const x = i * (barW + gap);
        if (p.net === 0) return <rect key={p.month} x={x} y={base - 0.5} width={barW} height={1} style={{ fill: baseColor }} />;
        const h = Math.max(3, Math.round((Math.abs(p.net) / maxAbs) * maxH));
        const y = p.net > 0 ? base - h : base;
        return <rect key={p.month} x={x} y={y} width={barW} height={h} rx={2} style={{ fill: p.net > 0 ? posColor : negColor }} />;
      })}
    </svg>
  );
}

/**
 * "Spending" tab (frame A2): band = period total + delta vs the 3-mo median of expense (range
 * 1 only — longer ranges show the period instead) and a `SegBar` preview of the top-5 rows.
 * Body: dimension chips, a range control, then per-row bars in the row's OWN color — envelope
 * color when `dim==="envelope"`, a stable `ENV_PALETTE` rotation by row index otherwise (other
 * dimensions have no color of their own). Rows beyond the top 10 fold behind a "+ N more"
 * toggle (local `useState` — expands in place, same idiom as the hub's account list).
 */
function SpendingReport({
  spending,
  cashflow,
  spBaseline,
  state,
  dim,
  setDim,
  range,
  setRange,
  M,
  month,
  onPrev,
  onNext,
  onBack,
}: {
  spending: { key: string | null; name: string; amount: number; pct: number }[];
  cashflow: { month: string; income: number; expense: number; net: number }[];
  spBaseline: Map<string | null, number>;
  state: StateResponse;
  dim: SpendingDimension;
  setDim: (d: SpendingDimension) => void;
  range: number;
  setRange: (n: number) => void;
  M: Mask;
  month: string;
  onPrev: () => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const C = useTheme();
  const { t, tp, lang } = useT();
  const { hc } = useBand();
  const [expanded, setExpanded] = useState(false);

  const spTotal = spending.reduce((s, r) => s + r.amount, 0);
  const spMax = Math.max(...spending.map((r) => r.amount), 1);
  // baseline = median of the 3 months BEFORE `month` (cashflow always ends at `month`) — same
  // idiom as the hub's SpendingMini card, duplicated here rather than extracted.
  const baseline3 = median(cashflow.slice(-4, -1).map((p) => p.expense));
  const totalDelta = baseline3 > 0 ? (spTotal - baseline3) / baseline3 : null;

  const envColor = new Map(state.envelopes.map((e) => [e.id, e.color]));
  const rowColor = (r: { key: string | null }, i: number): string =>
    (dim === "envelope" && r.key && envColor.get(r.key)) || ENV_PALETTE[i % ENV_PALETTE.length]!;

  const top5 = spending.slice(0, 5);
  const restAmt = Math.max(0, spTotal - top5.reduce((s, r) => s + r.amount, 0));
  // on a Duet band the "rest" segment must still read on navy — a low-alpha tint of the header
  // ink; a plain theme falls back to the ordinary track color.
  const restColor = hc(tint(C.headerInk, 0.25), C.line);
  const segments = [
    ...top5.map((r, i) => ({ weight: Math.max(0, r.amount), color: rowColor(r, i) })),
    ...(restAmt > 0 ? [{ weight: restAmt, color: restColor }] : []),
  ];

  const shown = expanded ? spending : spending.slice(0, 10);
  const rest = spending.slice(10);

  return (
    <ReportShell
      title={t(TITLES.spending)}
      month={month}
      onPrev={onPrev}
      onNext={onNext}
      onBack={onBack}
      eyebrow={t("Total spending")}
      hero={M(spTotal)}
      sub={
        range === 1 ? (
          <>
            <DeltaTag pct={totalDelta} /> {t("vs 3-mo median ({amount})", { amount: M(baseline3) })}
          </>
        ) : (
          t("{n} months to {month}", { n: range, month: monthLabel(month, lang) })
        )
      }
      bandChart={spending.length > 0 ? <SegBar segments={segments} height={9} /> : undefined}
    >
      <div style={{ display: "flex", gap: 6, marginTop: 2, marginBottom: 8, flexWrap: "wrap" }}>
        {DIMENSIONS.map((d) => (
          <button
            key={d.id}
            onClick={() => setDim(d.id)}
            style={{
              padding: "5px 12px",
              borderRadius: 9,
              border: `1px solid ${dim === d.id ? "var(--accent)" : C.line}`,
              background: dim === d.id ? "var(--accent)" : "transparent",
              // on-accent text (C3 contrast audit): white/headerInk measured ~2.1–2.3:1 on the
              // solid accent fill in DARK mode (teal #77c4a2, koral #ff998a, atrament #a5b5d6,
              // duet #8fa2cc are all LIGHT — by design, so they read as AA text on `card`
              // elsewhere in the app). Swapping to `C.card` fixes exactly those 4 dark combos to
              // 4.60–5.57:1 (measured). It does NOT fix light mode: `C.card` on the light accent
              // fill measures only 2.98:1 (teal) / 3.07:1 (koral) — under AA — because those two
              // accents (#4fa583/#f0685c) are mid-tone by design, not tuned to be a "readable on
              // card" light color the way their dark counterparts are; atrament/duet's LIGHT
              // accent is `#1d2a47` so `C.card` clears it easily (14.24 / 13.44:1), coincidentally
              // not by the same design argument. So: 6 of 8 theme×mode combos pass, not "all 8" —
              // the 2 that don't (teal-light, koral-light) are the same pre-existing white/card-
              // on-solid-fill gap flagged app-wide for buttons like "Save"/"Manage"/the FAB (see
              // C3 report Concern #2); out of scope here, not introduced by this change.
              // Duet also got an ink CHANGE (not just a contrast fix): the selected chip used to
              // read `C.headerInk` (#edeff5) here, now reads `C.card` (#fcf8ef) like every other
              // theme — both are ≥12:1 on Duet's accent, so this is a deliberate consistency
              // choice, not a contrast regression.
              color: dim === d.id ? C.card : C.soft,
              fontSize: 12,
              fontWeight: 650,
              cursor: "pointer",
            }}
          >
            {t(d.label)}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", background: C.chip, borderRadius: 9, padding: 2, marginBottom: 12 }}>
        {RANGES.map((r) => (
          <button
            key={r.n}
            onClick={() => setRange(r.n)}
            style={{
              flex: 1,
              padding: "6px 0",
              borderRadius: 7,
              border: "none",
              fontSize: 11.5,
              fontWeight: 650,
              cursor: "pointer",
              background: range === r.n ? C.card : "transparent",
              color: range === r.n ? C.text : C.soft,
              boxShadow: range === r.n ? "0 1px 2px rgba(20,20,28,0.08)" : "none",
            }}
          >
            {t(r.label)}
          </button>
        ))}
      </div>
      {spending.length === 0 && <div style={{ fontSize: 12.5, color: C.mute, padding: "8px 0" }}>{t("No spending in this period.")}</div>}
      {shown.map((r, i) => {
        const color = rowColor(r, i);
        const baseline = spBaseline.get(r.key) ?? 0;
        const delta = baseline > 0 ? (r.amount - baseline) / baseline : null;
        return (
          <div key={r.key ?? "none"} style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 3 }}>
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  fontSize: 13.5,
                  color: C.text,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                <span aria-hidden style={{ width: 8, height: 8, borderRadius: 3, background: color, flexShrink: 0 }} />
                {r.name}
              </span>
              <span style={{ fontSize: 13, fontWeight: 650, color: C.text, fontVariantNumeric: "tabular-nums", flexShrink: 0, marginLeft: 8 }}>
                {M(r.amount)} · {Math.round(r.pct * 100)}%
              </span>
            </div>
            <Bar pct={(r.amount / spMax) * 100} color={color} />
            {range === 1 && (
              <div style={{ textAlign: "right", marginTop: 2, fontSize: 11, color: C.soft }}>
                <DeltaTag pct={delta} /> {t("vs 3 mo")}
              </div>
            )}
          </div>
        );
      })}
      {!expanded && rest.length > 0 && (
        <button
          onClick={() => setExpanded(true)}
          style={{
            display: "block",
            width: "100%",
            background: "none",
            border: "none",
            textAlign: "center",
            padding: "2px 0 8px",
            fontSize: 12,
            color: C.mute,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          {tp("+ {n} more · {amount} | + {n} more · {amount}", rest.length, { amount: M(rest.reduce((s, r) => s + r.amount, 0)) })}
        </button>
      )}
    </ReportShell>
  );
}

/** One envelope row shared by all four BudgetsReport sections (Overspent/Near/used-up/rest-ok):
 *  name + right-aligned status (colored per section), an optional caption line under the head
 *  (only the Overspent section uses it, for "spent X of Y"), then a progress `Bar`. Each section
 *  differs only in status text/color, caption presence and bar color/pct — pulled out here to
 *  kill four copies of the same button/head/name/bar markup. */
function BudgetRow({
  name,
  onClick,
  statusColor,
  status,
  caption,
  barPct,
  barColor,
}: {
  name: string;
  onClick: () => void;
  statusColor: string;
  status: ReactNode;
  caption?: ReactNode;
  barPct: number;
  barColor: string;
}) {
  const C = useTheme();
  return (
    <button
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        background: "none",
        border: "none",
        padding: "0 0 12px",
        cursor: "pointer",
        textAlign: "left" as const,
        fontFamily: "inherit",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" as const, gap: 8, marginBottom: 3 }}>
        <span style={{ fontSize: 13, color: C.text, overflow: "hidden" as const, textOverflow: "ellipsis" as const, whiteSpace: "nowrap" as const }}>
          {name}
        </span>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: statusColor, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{status}</span>
      </div>
      {caption != null && <div style={{ fontSize: 10.5, color: C.soft, marginBottom: 4 }}>{caption}</div>}
      <Bar pct={barPct} color={barColor} />
    </button>
  );
}

/**
 * "Budgets" tab (frame A3, triage): three sections — Overspent / Near limit / Within budget —
 * classified via `classifyBudget` (lib/reportSummary.ts), the SAME rule the hub's Budgets
 * mini-card uses via `budgetsSummary` — parity between hub and subscreen is the point of that
 * helper. The "amber-wall" fix: an envelope spent EXACTLY down to 100% (left === 0) has no room
 * left to overrun and reads as calm ("used up"), not a warning — near requires
 * `pct >= 80 && left > 0`.
 */
function BudgetsReport({
  state,
  M,
  onOpenEnvelope,
  onPrev,
  onNext,
  onBack,
}: {
  state: StateResponse;
  M: Mask;
  onOpenEnvelope: (envId: string, month: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const C = useTheme();
  const { t, tp } = useT();
  const { hc } = useBand();
  const [expanded, setExpanded] = useState(false);

  const rows = state.envelopes
    .filter((e) => !e.archived && (e.allocated + e.carryIn > 0 || e.spent > 0))
    .map((e) => {
      const budget = Math.max(1, e.allocated + e.carryIn);
      const pct = (Math.max(0, e.spent) / budget) * 100;
      const left = e.available;
      return { e, pct, left, budget, status: classifyBudget(pct, left) };
    });
  const byPctDesc = (a: (typeof rows)[number], b: (typeof rows)[number]) => b.pct - a.pct || a.e.name.localeCompare(b.e.name);
  const overRows = rows.filter((r) => r.status === "over").sort(byPctDesc);
  const nearRows = rows.filter((r) => r.status === "near").sort(byPctDesc);
  const okRows = rows.filter((r) => r.status === "ok");
  // within "ok", pct can only be < 80 or exactly 100 (any pct in [80,100) is always "near" —
  // spent < budget there means left > 0 by construction) — so this isolates the used-up rows.
  const usedUpRows = okRows.filter((r) => r.pct >= 100);
  const restOkRows = okRows.filter((r) => r.pct < 100);
  const restAvgPct = restOkRows.length > 0 ? Math.round(restOkRows.reduce((s, r) => s + r.pct, 0) / restOkRows.length) : 0;
  const overspendTotal = overRows.reduce((s, r) => s + -r.left, 0);

  const pill = (label: string, swatch: string, key: string) => (
    <span
      key={key}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 11.5,
        fontWeight: 650,
        borderRadius: 9,
        padding: "4px 9px",
        background: hc(tint(C.headerInk, 0.13), C.chip),
        color: hc(C.headerInk, C.text),
      }}
    >
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: swatch, flexShrink: 0 }} />
      {label}
    </span>
  );
  return (
    <ReportShell
      title={t(TITLES.budgets)}
      month={state.month}
      onPrev={onPrev}
      onNext={onNext}
      onBack={onBack}
      eyebrow={overspendTotal > 0 ? t("Over budget") : t("Envelope budgets")}
      hero={
        overspendTotal > 0 ? (
          <span style={{ color: hc(C.headerNeg, C.neg) }}>−{M(overspendTotal)}</span>
        ) : (
          <span style={{ color: hc(C.headerPos, C.pos) }}>{t("All within budget")}</span>
        )
      }
      sub={overRows.length > 0 ? t("in {n} of {total} envelopes", { n: overRows.length, total: rows.length }) : undefined}
      bandChart={
        rows.length > 0 ? (
          <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
            {pill(tp("{n} over | {n} over", overRows.length), hc(C.headerNeg, C.neg), "over")}
            {/* no dedicated on-band amber token exists (headerWarn) — C.warn already reads fine on the navy band */}
            {pill(t("{n} near limit", { n: nearRows.length }), C.warn, "near")}
            {pill(t("{n} OK", { n: okRows.length }), hc(C.headerPos, C.pos), "ok")}
          </div>
        ) : undefined
      }
    >
      {rows.length === 0 && <div style={{ fontSize: 12.5, color: C.mute, padding: "8px 0" }}>{t("No envelopes with a budget or spending this month.")}</div>}

      {overRows.length > 0 && (
        <>
          <div style={{ fontSize: 10.5, fontWeight: 750, letterSpacing: "0.16em", textTransform: "uppercase", color: C.neg, margin: "4px 2px 8px" }}>
            {t("Overspent")}
          </div>
          {overRows.map(({ e, pct, left, budget }) => (
            <BudgetRow
              key={e.id}
              name={e.name}
              onClick={() => onOpenEnvelope(e.id, state.month)}
              statusColor={C.neg}
              status={`${Math.round(pct)}% · +${M(-left)}`}
              caption={t("spent {spent} of {budget}", { spent: M(Math.max(0, e.spent)), budget: M(budget) })}
              barPct={pct}
              barColor={C.neg}
            />
          ))}
        </>
      )}

      {nearRows.length > 0 && (
        <>
          <div style={{ fontSize: 10.5, fontWeight: 750, letterSpacing: "0.16em", textTransform: "uppercase", color: C.warn, margin: "18px 2px 8px" }}>
            {t("Near limit · ≥ 80%")}
          </div>
          {nearRows.map(({ e, pct, left }) => (
            <BudgetRow
              key={e.id}
              name={e.name}
              onClick={() => onOpenEnvelope(e.id, state.month)}
              statusColor={C.warn}
              status={`${Math.round(pct)}% · ${t("{amount} left", { amount: M(left) })}`}
              barPct={pct}
              barColor={C.warn}
            />
          ))}
        </>
      )}

      {(usedUpRows.length > 0 || restOkRows.length > 0) && (
        <>
          <div style={{ fontSize: 10.5, fontWeight: 750, letterSpacing: "0.16em", textTransform: "uppercase", color: C.mute, margin: "18px 2px 8px" }}>
            {t("Within budget")}
          </div>
          {usedUpRows.map(({ e, pct }) => (
            <BudgetRow
              key={e.id}
              name={e.name}
              onClick={() => onOpenEnvelope(e.id, state.month)}
              statusColor={C.soft}
              status={`${Math.round(pct)}% · ${t("used up")}`}
              barPct={100}
              barColor={C.mute}
            />
          ))}
          {restOkRows.length > 0 &&
            (expanded ? (
              restOkRows.map(({ e, pct, left }) => (
                <BudgetRow
                  key={e.id}
                  name={e.name}
                  onClick={() => onOpenEnvelope(e.id, state.month)}
                  statusColor={C.text}
                  status={`${Math.round(pct)}% · ${t("{amount} left", { amount: M(left) })}`}
                  barPct={pct}
                  barColor={e.color}
                />
              ))
            ) : (
              <button
                onClick={() => setExpanded(true)}
                style={{
                  display: "block",
                  width: "100%",
                  background: "none",
                  border: "none",
                  textAlign: "center",
                  padding: "2px 0 8px",
                  fontSize: 12,
                  color: C.mute,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                {tp("+ {n} envelope within budget (avg {pct}%) | + {n} envelopes within budget (avg {pct}%)", restOkRows.length, { pct: restAvgPct })}
              </button>
            ))}
        </>
      )}
    </ReportShell>
  );
}

/**
 * "Goals" tab (Gabinet grammar, no dedicated mockup frame — follows A2/A3): envelopes with a
 * monthly goal (monthlyTarget > 0), sorted ascending by %, then name — math EXCLUSIVELY via
 * `goalProgress`, zero duplication in the component. Eyebrow reads "Monthly goals" rather than
 * "Goals", which just repeated the screen title above it.
 *
 * Task P1 fix: the hero used to be the whole SENTENCE ("All goals funded ✓") at 30px, which wraps
 * to two clunky lines on the band for anything but the shortest locale. The hero is now the bare
 * aggregate NUMBER (`{pctTotal}%`); the verdict sentence moved to the sub — "All goals funded ✓"
 * in pos colors when every goal is funded, else the existing "{amount} to go". The `rows.length >
 * 0` guard keeps a budget with zero goals from reading as a false "All funded ✓" (nothing to fund
 * is not the same claim as everything funded); it instead shows a neutral 0% hero, no sub, and the
 * existing empty-state copy in the body.
 *
 * Each row leads with a `GoalRing` (kit.tsx) mirroring the hub card — now colored `C.pos` once
 * funded, via the ring's new `color` prop — and gets a new muted sub-line under the envelope name
 * with the bare masked amounts (`funded / target`, no wording: a money pair reads fine without
 * connecting words and stays locale-neutral, unlike the "monthly goal: …" key tiles.tsx uses
 * elsewhere, which carries a label prefix this row doesn't need). Below all rows, a muted footer
 * counts envelopes that have NO goal at all — those are invisible in the list above (goalProgress
 * returns null for them), so without this line a user with mostly goal-less envelopes would have
 * no idea more exist; hidden entirely when there is nothing to fold (rows.length === 0, since the
 * empty-state message already covers that case; noGoalCount === 0).
 */
function GoalsReport({
  state,
  M,
  onOpenEnvelope,
  onFillGoals,
  onPrev,
  onNext,
  onBack,
}: {
  state: StateResponse;
  M: Mask;
  onOpenEnvelope: (envId: string, month: string) => void;
  onFillGoals: () => void;
  onPrev: () => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const C = useTheme();
  const { t, tp } = useT();
  const { hc } = useBand();
  const active = state.envelopes.filter((e) => !e.archived);
  const rows = active
    .flatMap((e) => {
      const gp = goalProgress(e);
      return gp ? [{ e, gp }] : [];
    })
    .sort((a, b) => a.gp.pct - b.gp.pct || a.e.name.localeCompare(b.e.name));
  const noGoalCount = active.length - rows.length;
  const fundedSum = rows.reduce((s, { e }) => s + Math.min(Math.max(0, e.allocated), e.monthlyTarget ?? 0), 0);
  const targetSum = rows.reduce((s, { e }) => s + (e.monthlyTarget ?? 0), 0);
  const pctTotal = targetSum > 0 ? Math.round((fundedSum / targetSum) * 100) : 0;
  const missSum = rows.reduce((s, { gp }) => s + gp.missing, 0);
  const allFunded = rows.length > 0 && missSum === 0;
  // Same entry-visibility predicate as Budget's "Fill by goals" button — a pool to place
  // AND at least one goal still short (missSum > 0 already implies the latter).
  const canFillGoals = state.readyToAssign > 0 && missSum > 0;
  return (
    <ReportShell
      title={t(TITLES.goals)}
      month={state.month}
      onPrev={onPrev}
      onNext={onNext}
      onBack={onBack}
      eyebrow={t("Monthly goals")}
      hero={`${pctTotal}%`}
      sub={
        rows.length === 0 ? undefined : allFunded ? (
          <span style={{ color: hc(C.headerPos, C.pos) }}>{t("All goals funded ✓")}</span>
        ) : (
          <>
            {t("{amount} to go", { amount: M(missSum) })}
            {canFillGoals && (
              <>
                {" · "}
                <button
                  onClick={onFillGoals}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    margin: 0,
                    font: "inherit",
                    color: hc(C.headerInk, TEAL),
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  {t("Fill ›")}
                </button>
              </>
            )}
          </>
        )
      }
    >
      {rows.length === 0 && (
        <div style={{ fontSize: 12.5, color: C.mute, padding: "8px 0" }}>{t("No envelopes with a goal. Set a monthly target when editing an envelope.")}</div>
      )}
      {rows.map(({ e, gp }) => {
        const barColor = gp.funded ? C.pos : "var(--accent)";
        const fundedAmt = Math.min(Math.max(0, e.allocated), e.monthlyTarget ?? 0);
        return (
          <button
            key={e.id}
            onClick={() => onOpenEnvelope(e.id, state.month)}
            style={{
              display: "block",
              width: "100%",
              background: "none",
              border: "none",
              padding: "0 0 12px",
              cursor: "pointer",
              textAlign: "left",
              fontFamily: "inherit",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 3 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    fontSize: 13,
                    color: C.text,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  <GoalRing pct={gp.pct} size={16} color={gp.funded ? C.pos : undefined} />
                  {e.name}
                </div>
                {/* Bare masked amounts, slash-joined — no i18n key: a money pair reads fine with no
                   connecting words, and gluing one on would just force English word order. */}
                <div style={{ fontSize: 10.5, color: C.mute, marginTop: 2 }}>
                  {M(fundedAmt)} / {M(e.monthlyTarget ?? 0)}
                </div>
              </div>
              <span style={{ textAlign: "right", flexShrink: 0 }}>
                <span style={{ display: "block", fontSize: 12.5, fontWeight: 700, color: gp.funded ? C.pos : C.text, fontVariantNumeric: "tabular-nums" }}>
                  {Math.round(gp.pct)}%
                </span>
                <span style={{ display: "block", fontSize: 10.5, color: gp.funded ? C.pos : C.soft, fontVariantNumeric: "tabular-nums" }}>
                  {gp.funded ? t("funded ✓") : t("{amount} to go", { amount: M(gp.missing) })}
                </span>
              </span>
            </div>
            <Bar pct={gp.pct} color={barColor} />
          </button>
        );
      })}
      {rows.length > 0 && noGoalCount > 0 && (
        <div style={{ fontSize: 11, color: C.mute, padding: "6px 0 4px" }}>
          {tp(
            "+ {n} envelope without a goal — set one when editing an envelope. | + {n} envelopes without a goal — set one when editing an envelope.",
            noGoalCount,
          )}
        </div>
      )}
    </ReportShell>
  );
}

/**
 * "Month in a nutshell" tab (frame A4): the whole-month glance-back — band hero is this month's
 * net (sign-colored via `hc`, the same idiom as Cashflow's hero), sub is ONE line built from two
 * WHOLE-sentence variants (income/spending/rate vs. income/spending only) rather than a glued
 * fragment, matching Cashflow's rate-vs-no-rate split — a month with no income has no defined
 * savings rate (`savingsRate` returns `current: null` there), not a rate of 0%. Body: a
 * Monday-start `CalendarHeatmap` of daily spending with an avg/peak caption, then "Most frequent
 * places" (`topPlaces`, visit-count led) and "Largest expenses" (`largestExpenses`, amount led) —
 * both in the statement-row idiom (13.5px, hairline `C.line` separators, last row bare — mirrors
 * mockup `.stmt`; a bespoke eyebrow style rather than `SectionEyebrow` because that component's
 * own horizontal padding doesn't match this body's, see kit.tsx). An empty month (no day with
 * positive spend) swaps the avg/peak caption for a single "No spending this month." line — the
 * heatmap needs no special-casing since every `<= 0` cell already renders `C.inset` — and both
 * list sections are hidden entirely (not rendered empty) when there is nothing to show. Each
 * "Largest expenses" row's muted secondary text prefers `context` (envelope/category, computed —
 * and de-duplicated against `label` — in shared/reports.ts) and falls back to the transaction's
 * own date only when `context` is null, so the slot is never empty.
 */
function MonthReport({
  cashflow,
  days,
  places,
  largest,
  M,
  month,
  onPrev,
  onNext,
  onBack,
}: {
  cashflow: { month: string; income: number; expense: number; net: number }[];
  days: { date: string; total: number }[];
  places: { key: string; name: string; count: number; total: number }[];
  largest: { id: string; label: string; context: string | null; date: string; amount: number }[];
  M: Mask;
  month: string;
  onPrev: () => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const C = useTheme();
  const { t, lang } = useT();
  const { hc } = useBand();

  const totIncome = cashflow.at(-1)?.income ?? 0;
  const totExpense = cashflow.at(-1)?.expense ?? 0;
  const totNet = cashflow.at(-1)?.net ?? 0;
  const sr = savingsRate(cashflow);
  const srPct = sr.current !== null ? Math.round(sr.current * 100) : null;

  // peak day: `reduce` with no seed requires a non-empty array (guaranteed by the length check),
  // so no `undefined`-guard is needed inside the callback; first occurrence wins a tie (strict `>`
  // never overwrites on an equal total).
  const peak = days.length > 0 ? days.reduce((best, d) => (d.total > best.total ? d : best)) : undefined;
  const hasSpending = peak !== undefined && peak.total > 0;
  const avg = days.length > 0 ? Math.round(totExpense / days.length) : 0;

  const eyebrowStyle = { fontSize: 10.5, fontWeight: 750, letterSpacing: "0.16em", textTransform: "uppercase" as const, color: C.mute, margin: "18px 2px 8px" };
  const rowStyle = (last: boolean) => ({
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline" as const,
    padding: "9px 1px",
    borderBottom: last ? "none" : `1px solid ${C.line}`,
    fontSize: 13.5,
  });

  return (
    <ReportShell
      title={t(TITLES.month)}
      month={month}
      onPrev={onPrev}
      onNext={onNext}
      onBack={onBack}
      eyebrow={t("Net for {month}", { month: monthLabel(month, lang) })}
      hero={
        <span style={{ color: totNet >= 0 ? hc(C.headerPos, C.pos) : hc(C.headerNeg, C.neg) }}>
          {totNet >= 0 ? "+" : "−"}
          {M(Math.abs(totNet))}
        </span>
      }
      sub={
        srPct !== null
          ? t("income {income} · spending {expense} · savings rate {pct}%", { income: M(totIncome), expense: M(totExpense), pct: srPct })
          : t("income {income} · spending {expense}", { income: M(totIncome), expense: M(totExpense) })
      }
    >
      <div style={eyebrowStyle}>{t("Day by day")}</div>
      <CalendarHeatmap days={days} lang={lang} mask={M} />
      <div style={{ fontSize: 11, color: C.mute, marginTop: 7 }}>
        {hasSpending && peak
          ? t("avg {avg}/day · peak: {date} ({peak})", { avg: M(avg), date: shortDate(peak.date, lang), peak: M(peak.total) })
          : t("No spending this month.")}
      </div>

      {places.length > 0 && (
        <>
          <div style={eyebrowStyle}>{t("Most frequent places")}</div>
          {places.map((p, i) => (
            <div key={p.key} style={rowStyle(i === places.length - 1)}>
              <span style={{ color: C.soft, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
              <span style={{ fontWeight: 650, color: C.text, fontVariantNumeric: "tabular-nums", flexShrink: 0, marginLeft: 8 }}>
                {t("{count}× · {amount}", { count: p.count, amount: M(p.total) })}
              </span>
            </div>
          ))}
        </>
      )}

      {largest.length > 0 && (
        <>
          <div style={eyebrowStyle}>{t("Largest expenses")}</div>
          {/* Secondary text prefers `context` (shared/reports.ts: envelope name, else category
             name, already suppressed there when it would just repeat `label`) — falling back to
             the transaction's date only when there is no context at all, so the muted slot next
             to the label is never empty. */}
          {largest.map((e, i) => (
            <div key={e.id} style={rowStyle(i === largest.length - 1)}>
              <span style={{ color: C.soft, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {e.label} <span style={{ color: C.mute }}>· {e.context ?? shortDate(e.date, lang)}</span>
              </span>
              <span style={{ fontWeight: 650, color: C.text, fontVariantNumeric: "tabular-nums", flexShrink: 0, marginLeft: 8 }}>{M(e.amount)}</span>
            </div>
          ))}
        </>
      )}
    </ReportShell>
  );
}

/**
 * "Envelope trends" tab (Task 12, no dedicated mockup frame — follows the Gabinet grammar of
 * Tasks 9–11 and the hub's TrendsMini, Task 8). Band hero counts envelopes whose `deltaPct` moved
 * more than ±10% over the 6-month window (rising/falling; a null `deltaPct` — no baseline to
 * compare against — counts as neither); eyebrow is the fixed "Last 6 months" window label (no
 * range control, unlike Spending — the trend series is always the hub's 6-month window). No
 * `bandChart`: the per-row TrendSpark already carries the shape, a band-level chart would just
 * repeat it. Body: ALL trends, no fold — `computeEnvelopeTrends` already sorts by |last−baseline|
 * desc and drops all-zero envelopes, so there is no long tail to hide behind a "+ N more" toggle
 * the way Spending/Budgets do. Each row is a single-line statement (color dot + name, a fixed-size
 * TrendSpark colored via `trendColor`, and a right column mirroring GoalsReport's amount/sub-line
 * shape) that navigates to the envelope like a BudgetsReport row. When `deltaPct` is null there is
 * nothing to compare the current amount against, so the whole sub-line (DeltaTag + "vs median") is
 * omitted rather than left as a dangling "vs median" with no percentage next to it.
 */
function TrendsReport({
  trends,
  M,
  month,
  onOpenEnvelope,
  onPrev,
  onNext,
  onBack,
}: {
  trends: EnvelopeTrend[];
  M: Mask;
  month: string;
  onOpenEnvelope: (envId: string, month: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const C = useTheme();
  const { t } = useT();
  const rising = trends.filter((tr) => tr.deltaPct !== null && tr.deltaPct > 0.1).length;
  const falling = trends.filter((tr) => tr.deltaPct !== null && tr.deltaPct < -0.1).length;

  return (
    <ReportShell
      title={t(TITLES.trends)}
      month={month}
      onPrev={onPrev}
      onNext={onNext}
      onBack={onBack}
      eyebrow={t("Last 6 months")}
      hero={t("{n} rising · {m} falling", { n: rising, m: falling })}
    >
      {trends.length === 0 && (
        <div style={{ fontSize: 12.5, color: C.mute, padding: "8px 0" }}>{t("Not enough history yet — trends appear after two months of spending.")}</div>
      )}
      {trends.map((tr, i) => {
        const color = trendColor(tr, C);
        return (
          <button
            key={tr.id}
            onClick={() => onOpenEnvelope(tr.id, month)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "100%",
              padding: "10px 0",
              background: "none",
              border: "none",
              borderBottom: i === trends.length - 1 ? "none" : `1px solid ${C.line}`,
              cursor: "pointer",
              textAlign: "left",
              fontFamily: "inherit",
            }}
          >
            <span
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                flex: 1,
                fontSize: 13.5,
                color: C.text,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              <span aria-hidden style={{ width: 8, height: 8, borderRadius: 3, background: tr.color, flexShrink: 0 }} />
              {tr.name}
            </span>
            <span style={{ flexShrink: 0 }}>
              <TrendSpark series={tr.series} color={color} w={96} h={24} />
            </span>
            <span style={{ textAlign: "right", flexShrink: 0 }}>
              <span style={{ display: "block", fontSize: 13, fontWeight: 650, color: C.text, fontVariantNumeric: "tabular-nums" }}>{M(tr.last)}</span>
              {tr.deltaPct !== null && (
                <span style={{ display: "block", fontSize: 10.5, color: C.soft }}>
                  <DeltaTag pct={tr.deltaPct} /> {t("vs median")}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </ReportShell>
  );
}

/** Net-worth line chart with the axis clipped to the min–max range. `onBand` (Assets' hero chart,
 *  painted directly on the Duet navy band) swaps the accent stroke/points for `C.headerInk` (TEAL
 *  — i.e. `var(--accent)` — IS the band color there, so it would be invisible navy-on-navy) and the
 *  caption color for `C.headerMute`; plain themes (onBand omitted/false) keep today's accent look. */
function NetWorthChart({ points, mask, onBand }: { points: { month: string; total: number }[]; mask: Mask; onBand?: boolean }) {
  const C = useTheme();
  const { t, lang } = useT();
  const n = points.length;
  if (n === 0) return null;
  const totals = points.map((p) => p.total);
  const min = Math.min(...totals);
  const max = Math.max(...totals);
  const range = max - min || 1;
  const flat = max === min;
  const W = 340,
    H = 118,
    padX = 6,
    padY = 12;
  const innerW = W - 2 * padX,
    innerH = H - 2 * padY;
  const x = (i: number) => padX + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => (flat ? padY + innerH / 2 : padY + (1 - (v - min) / range) * innerH);
  const pts = points.map((p, i) => [x(i), y(p.total)] as const);
  const line = pts.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px.toFixed(1)} ${py.toFixed(1)}`).join(" ");
  const area = `${line} L${x(n - 1).toFixed(1)} ${(H - padY).toFixed(1)} L${x(0).toFixed(1)} ${(H - padY).toFixed(1)} Z`;
  const stroke = onBand ? C.headerInk : TEAL;
  const hole = onBand ? C.headerBg : C.bg;
  const caption = onBand ? C.headerMute : C.mute;
  return (
    <div style={{ marginBottom: 6 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", height: "auto" }} role="img" aria-label={t("Net worth over time")}>
        {/* fill/stroke via style — var(--accent) does not work in SVG presentation attributes */}
        <path d={area} style={{ fill: stroke }} opacity={0.12} />
        <path d={line} fill="none" style={{ stroke }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {pts.map(([px, py], i) => (
          <circle
            key={i}
            cx={px}
            cy={py}
            r={i === n - 1 ? 4 : 2.4}
            style={{ fill: i === n - 1 ? stroke : hole, stroke }}
            strokeWidth={1.6}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 4, fontSize: 10.5, color: caption }}>
        <span>{monthLabel(points[0]!.month, lang).split(" ")[0]}</span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>{t("range {min}–{max}", { min: mask(min), max: mask(max) })}</span>
        <span>{monthLabel(points[n - 1]!.month, lang).split(" ")[0]}</span>
      </div>
    </div>
  );
}
