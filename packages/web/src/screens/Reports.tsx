import { useMemo, useState, type ReactNode } from "react";
import {
  computeCashflowSeries,
  computeDailySpending,
  computeEnvelopeTrends,
  computeNetWorthSeries,
  computeSpendingByDimension,
  largestExpenses,
  prevMonth,
  savingsRate,
  spendingBaseline,
  topPlaces,
  type SpendingDimension,
} from "@enveo/shared";
import { useLedgerVersion, type StateResponse } from "../lib/api";
import { store } from "../lib/store";
import { Header } from "../components/chrome";
import { GoalRing, useBand } from "../components/kit";
import { ReportInfoNote } from "../components/ReportInfoNote";
import { Bar, CalendarHeatmap, DeltaTag, ReportShell, SegBar, Sparkline, TrendSpark } from "../components/reportKit";
import { useMask, useTheme } from "../lib/contexts";
import { monthLabel, shortDate } from "../lib/dates";
import { goalProgress } from "../lib/goals";
import { useT, type Message, msg } from "../lib/i18n";
import { budgetsSummary, classifyBudget } from "../lib/reportSummary";
import { ENV_PALETTE, P, TEAL, tint } from "../lib/theme";

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
/**
 * "How to read this" note per report (ReportInfoNote renders `**bold**`). Deliberately has NO
 * entry for "month"/"trends" — the whole ⓘ-note mechanism is retired in Task 13, so the two new
 * tabs never get one; the subscreen render guards on presence rather than assuming every tab has one.
 */
const NOTES: Partial<Record<ReportTab, Message>> = {
  assets: msg("All account balances minus liabilities, month by month. When the line **goes up**, you are building wealth; dips are explained in Cashflow."),
  cashflow: msg("Income minus spending, month by month. Bar **to the right** = you are saving, **to the left** = the month ran a deficit."),
  spending: msg("Where your money actually went in the selected period — grouped by category, envelope, group, or place."),
  budgets: msg("Spending versus the amounts available in envelopes. **Amber** = approaching the limit (≥ 80%), **red** = overspent."),
  goals: msg("How much of each envelope's monthly target you have **funded**. A full bar = the contribution is set aside, regardless of how much of it you have spent."),
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

export function ReportsScreen({ state, month, view, onView, onOpenEnvelope, onMenu, onPrev, onNext }: { state: StateResponse; month: string; view: ReportView; onView: (v: ReportView) => void; onOpenEnvelope: (envId: string, month: string) => void; onMenu: () => void; onPrev: () => void; onNext: () => void }) {
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
  const envelopeTrends = useMemo(() => {
    if (view !== "overview") return [];
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
      {view === "assets" && <AssetsReport netWorth={netWorth} state={state} M={M} month={month} onPrev={onPrev} onNext={onNext} onBack={back} note={NOTES.assets && <ReportInfoNote id="assets" textKey={NOTES.assets} />} />}
      {view === "cashflow" && <CashflowReport cashflow={cashflow} M={M} month={month} onPrev={onPrev} onNext={onNext} onBack={back} note={NOTES.cashflow && <ReportInfoNote id="cashflow" textKey={NOTES.cashflow} />} />}
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
          note={NOTES.spending && <ReportInfoNote id="spending" textKey={NOTES.spending} />}
        />
      )}
      {view === "budgets" && <BudgetsReport state={state} M={M} onOpenEnvelope={onOpenEnvelope} onPrev={onPrev} onNext={onNext} onBack={back} note={NOTES.budgets && <ReportInfoNote id="budgets" textKey={NOTES.budgets} />} />}
      {view === "goals" && <GoalsReport state={state} M={M} onOpenEnvelope={onOpenEnvelope} onPrev={onPrev} onNext={onNext} onBack={back} note={NOTES.goals && <ReportInfoNote id="goals" textKey={NOTES.goals} />} />}
      {view === "month" && (
        <MonthReport cashflow={cashflow} days={dailySpending} places={monthPlaces} largest={monthLargest} M={M} month={month} onPrev={onPrev} onNext={onNext} onBack={back} note={NOTES.month && <ReportInfoNote id="month" textKey={NOTES.month} />} />
      )}
      {/* Envelope-trends subscreen — Task 12 fills this in. */}
      {view === "trends" && <div />}
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
  envelopeTrends: { id: string; name: string; color: string; series: number[]; last: number; baseline: number; deltaPct: number | null }[];
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
      <div style={band ? { background: C.headerBg, paddingBottom: 14 } : { paddingBottom: 14 }}>
        <Header month={month} onMenu={onMenu} onPrev={onPrev} onNext={onNext} onBand={band} />
        <button
          onClick={() => onView("assets")}
          style={{ display: "block", width: "100%", background: "none", border: "none", padding: `10px ${P}px 0`, textAlign: "left", cursor: "pointer", fontFamily: "inherit" }}
        >
          <div style={{ fontSize: 10.5, fontWeight: 750, letterSpacing: "0.17em", textTransform: "uppercase", color: hc(C.headerMute, C.mute) }}>{t("Net worth")}</div>
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

/** Mini-card button shell shared by all six hub cards: quiet label row (title + chevron) + body. */
function MiniCard({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  const C = useTheme();
  return (
    <button
      onClick={onClick}
      style={{ display: "block", width: "100%", background: C.card, border: "none", boxShadow: "0 1px 3px rgba(20,20,28,0.06)", borderRadius: 14, padding: "12px 13px", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 11, fontWeight: 700, color: C.soft, marginBottom: 6 }}>
        <span>{title}</span>
        <span style={{ color: C.mute, fontWeight: 400 }}>›</span>
      </div>
      {children}
    </button>
  );
}

/** Deterministic median (lower-of-two-middle on ties) — a tiny local copy of the private helper
 *  in shared/reports.ts; kept here rather than exported since the hub is its only web-side caller. */
function medianOf(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/** Cashflow mini-card: 12-mo diverging columns (up in C.pos / down in C.neg from a C.line
 *  baseline), current month's net (sign-colored), and the current savings rate. */
function CashflowMini({ cashflow, onView, M }: { cashflow: { month: string; income: number; expense: number; net: number }[]; onView: (v: ReportView) => void; M: Mask }) {
  const C = useTheme();
  const { t } = useT();
  const barW = 7, gap = 2, H = 34, base = H / 2, maxH = 15;
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
  const segments = [...top.map((r, i) => ({ weight: Math.max(0, r.amount), color: colorOf(r, i) })), ...(restAmt > 0 ? [{ weight: restAmt, color: C.line }] : [])];
  // baseline = median of the 3 months BEFORE the current one (cashflow always ends at `month`)
  const baseline = medianOf(cashflow.slice(-4, -1).map((p) => p.expense));
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
  const { t } = useT();
  const bs = budgetsSummary(envelopes);
  const overAmt = envelopes
    .filter((e) => !e.archived && (e.allocated + e.carryIn > 0 || e.spent > 0))
    .reduce((s, e) => {
      const budget = Math.max(1, e.allocated + e.carryIn);
      const pct = (Math.max(0, e.spent) / budget) * 100;
      return pct > 100 ? s + Math.max(0, -e.available) : s;
    }, 0);
  const pill = (label: string, bg: string, color: string, key: string) => (
    <span key={key} style={{ display: "inline-flex", alignItems: "center", fontSize: 11.5, fontWeight: 650, borderRadius: 9, padding: "4px 9px", background: bg, color }}>
      {label}
    </span>
  );
  return (
    <MiniCard title={t("Budgets")} onClick={() => onView("budgets")}>
      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
        {pill(t("{n} over", { n: bs.over }), "var(--danger-14)", C.neg, "over")}
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

/** Month mini-card: a 10-cell intensity strip for the first 10 days of the month (same quartile
 *  colors as CalendarHeatmap, scaled against the WHOLE month's max so it reads consistently with
 *  the Task 11 subscreen), plus the month's average daily spend. */
function MonthMini({ days, onView, M }: { days: { date: string; total: number }[]; onView: (v: ReportView) => void; M: Mask }) {
  const C = useTheme();
  const { t } = useT();
  const first10 = days.slice(0, 10);
  const max = Math.max(...days.map((d) => d.total), 1);
  const colorFor = (total: number): string => {
    if (total <= 0) return C.inset;
    const q = total / max;
    if (q <= 0.25) return "var(--accent-22)";
    if (q <= 0.5) return "var(--accent-40)";
    if (q <= 0.75) return "var(--accent-66)";
    return "var(--accent)";
  };
  const avg = days.length > 0 ? Math.round(days.reduce((s, d) => s + d.total, 0) / days.length) : 0;
  return (
    <MiniCard title={t("Month in a nutshell")} onClick={() => onView("month")}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(10, 1fr)", gap: 2.5 }}>
        {first10.map((d) => (
          <span key={d.date} style={{ aspectRatio: "1", borderRadius: 3, background: colorFor(d.total) }} />
        ))}
      </div>
      <div style={{ fontSize: 11, color: C.mute, marginTop: 8, fontVariantNumeric: "tabular-nums" }}>{t("avg {amount}/day", { amount: M(avg) })}</div>
    </MiniCard>
  );
}

/** Trends mini-card: the top-2 biggest-moving envelopes (already sorted by computeEnvelopeTrends),
 *  a mini TrendSpark (red rising / green falling / muted flat) and an arrow per row. */
function TrendsMini({
  trends,
  onView,
}: {
  trends: { id: string; name: string; color: string; series: number[]; last: number; baseline: number; deltaPct: number | null }[];
  onView: (v: ReportView) => void;
}) {
  const C = useTheme();
  const { t } = useT();
  const top = trends.slice(0, 2);
  return (
    <MiniCard title={t("Envelope trends")} onClick={() => onView("trends")}>
      {top.length === 0 && <div style={{ fontSize: 11.5, color: C.mute }}>{t("Not enough data yet.")}</div>}
      {top.map((tr) => {
        const rising = tr.last > tr.baseline;
        const falling = tr.last < tr.baseline;
        const color = rising ? C.neg : falling ? C.pos : C.mute;
        return (
          <div key={tr.id} style={{ marginBottom: 4 }}>
            <TrendSpark series={tr.series} color={color} w={150} h={16} />
            <div style={{ fontSize: 11, color: C.soft, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {tr.name}{" "}
              {rising && <span style={{ color: C.neg, fontWeight: 650 }}>↑</span>}
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
function AssetsReport({ netWorth, state, M, month, onPrev, onNext, onBack, note }: { netWorth: { month: string; total: number }[]; state: StateResponse; M: Mask; month: string; onPrev: () => void; onNext: () => void; onBack: () => void; note: ReactNode }) {
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
      {note}
      <div style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: "20px 0 4px" }}>{t("Wealth")}</div>
      {savings.length === 0 ? (
        <div style={{ fontSize: 12.5, color: C.mute, padding: "4px 0", lineHeight: 1.6 }}>
          {t("No envelopes are marked as wealth envelopes. Open an envelope → Edit and turn on “Wealth envelope” (e.g. Bonds, Retirement, Savings), and we will count them here.")}
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
                <span style={{ fontSize: 12.5, fontWeight: 600, color: C.text, fontVariantNumeric: "tabular-nums", flexShrink: 0, marginLeft: 8 }}>{M(e.available)}</span>
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
 * 12-mo net total, sign-colored on the band; sub = the savings rate (`shared/savingsRate`, current
 * month vs the 12-mo median — the "your norm" clause), built from ONE message per case rather than
 * concatenated fragments so every locale can reorder the clause. Body: the Income/Expense/Net stat
 * trio, then the existing diverging monthly bars — structure/colors unchanged (already tokenized).
 */
function CashflowReport({ cashflow, M, month, onPrev, onNext, onBack, note }: { cashflow: { month: string; income: number; expense: number; net: number }[]; M: Mask; month: string; onPrev: () => void; onNext: () => void; onBack: () => void; note: ReactNode }) {
  const C = useTheme();
  const { t, lang } = useT();
  const { hc } = useBand();
  const totIncome = cashflow.reduce((s, p) => s + p.income, 0);
  const totExpense = cashflow.reduce((s, p) => s + p.expense, 0);
  const totNet = totIncome - totExpense;
  const maxAbs = Math.max(...cashflow.map((p) => Math.abs(p.net)), 1);
  const sr = savingsRate(cashflow);
  const srPct = sr.current !== null ? Math.round(sr.current * 100) : null;
  const srNorm = sr.median !== null ? Math.round(sr.median * 100) : null;
  return (
    <ReportShell
      title={t(TITLES.cashflow)}
      month={month}
      onPrev={onPrev}
      onNext={onNext}
      onBack={onBack}
      eyebrow={t("Cash flow")}
      hero={
        <span style={{ color: totNet >= 0 ? hc(C.headerPos, C.pos) : hc(C.headerNeg, C.neg) }}>
          {totNet >= 0 ? "+" : "−"}
          {M(Math.abs(totNet))}
        </span>
      }
      sub={
        srPct !== null
          ? srNorm !== null
            ? t("savings rate {pct}% · your norm {norm}%", { pct: srPct, norm: srNorm })
            : t("savings rate {pct}%", { pct: srPct })
          : undefined
      }
    >
      {note}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, marginTop: 4 }}>
        {([[t("Income"), totIncome, C.pos], [t("Expense"), totExpense, C.neg], [t("Net"), totNet, totNet >= 0 ? C.pos : C.neg]] as const).map(([label, val, col]) => (
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
            <span style={{ fontSize: 11, color: C.soft, width: 48, textAlign: "right", flexShrink: 0 }}>{monthLabel(p.month, lang).split(" ")[0]}</span>
            <div style={{ flex: 1, position: "relative", height: 12 }}>
              <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: C.line }} />
              <div style={{ position: "absolute", top: 2, height: 8, borderRadius: 3, background: p.net >= 0 ? C.pos : C.neg, left: p.net >= 0 ? "50%" : `${50 - w}%`, width: `${w}%` }} />
            </div>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: p.net >= 0 ? C.pos : C.neg, width: 80, textAlign: "right", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{p.net >= 0 ? "+" : "−"}{M(Math.abs(p.net))}</span>
          </div>
        );
      })}
    </ReportShell>
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
  note,
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
  note: ReactNode;
}) {
  const C = useTheme();
  const { t, lang } = useT();
  const { hc } = useBand();
  const [expanded, setExpanded] = useState(false);

  const spTotal = spending.reduce((s, r) => s + r.amount, 0);
  const spMax = Math.max(...spending.map((r) => r.amount), 1);
  // baseline = median of the 3 months BEFORE `month` (cashflow always ends at `month`) — same
  // idiom as the hub's SpendingMini card, duplicated here rather than extracted.
  const baseline3 = medianOf(cashflow.slice(-4, -1).map((p) => p.expense));
  const totalDelta = baseline3 > 0 ? (spTotal - baseline3) / baseline3 : null;

  const envColor = new Map(state.envelopes.map((e) => [e.id, e.color]));
  const rowColor = (r: { key: string | null }, i: number): string => (dim === "envelope" && r.key && envColor.get(r.key)) || ENV_PALETTE[i % ENV_PALETTE.length]!;

  const top5 = spending.slice(0, 5);
  const restAmt = Math.max(0, spTotal - top5.reduce((s, r) => s + r.amount, 0));
  // on a Duet band the "rest" segment must still read on navy — a low-alpha tint of the header
  // ink; a plain theme falls back to the ordinary track color.
  const restColor = hc(tint(C.headerInk, 0.25), C.line);
  const segments = [...top5.map((r, i) => ({ weight: Math.max(0, r.amount), color: rowColor(r, i) })), ...(restAmt > 0 ? [{ weight: restAmt, color: restColor }] : [])];

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
      {note}
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
              // on-accent text: Duet's accent IS the navy band color (var(--accent) === C.headerBg
              // there), so C.headerBg itself is unreadable on it — C.headerInk is the token for text
              // painted ON that band (confirmed against a live Duet render, see task report). Other
              // themes keep accent dark/saturated enough in light mode for plain white (the same
              // literal already used by the accent-filled button in IconColorPicker.tsx).
              color: dim === d.id ? hc(C.headerInk, "#fff") : C.soft,
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
              <span style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13.5, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
          style={{ display: "block", width: "100%", background: "none", border: "none", textAlign: "center", padding: "2px 0 8px", fontSize: 12, color: C.mute, cursor: "pointer", fontFamily: "inherit" }}
        >
          {t("+ {n} more · {amount}", { n: rest.length, amount: M(rest.reduce((s, r) => s + r.amount, 0)) })}
        </button>
      )}
    </ReportShell>
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
  note,
}: {
  state: StateResponse;
  M: Mask;
  onOpenEnvelope: (envId: string, month: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onBack: () => void;
  note: ReactNode;
}) {
  const C = useTheme();
  const { t } = useT();
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
      style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 650, borderRadius: 9, padding: "4px 9px", background: hc(tint(C.headerInk, 0.13), C.chip), color: hc(C.headerInk, C.text) }}
    >
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: swatch, flexShrink: 0 }} />
      {label}
    </span>
  );
  const rowBtnStyle = { display: "block", width: "100%", background: "none", border: "none", padding: "0 0 12px", cursor: "pointer", textAlign: "left" as const, fontFamily: "inherit" };
  const rowHeadStyle = { display: "flex", justifyContent: "space-between", alignItems: "baseline" as const, gap: 8, marginBottom: 3 };
  const rowNameStyle = { fontSize: 13, color: C.text, overflow: "hidden" as const, textOverflow: "ellipsis" as const, whiteSpace: "nowrap" as const };

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
            {pill(t("{n} over", { n: overRows.length }), hc(C.headerNeg, C.neg), "over")}
            {/* no dedicated on-band amber token exists (headerWarn) — C.warn already reads fine on the navy band */}
            {pill(t("{n} near limit", { n: nearRows.length }), C.warn, "near")}
            {pill(t("{n} OK", { n: okRows.length }), hc(C.headerPos, C.pos), "ok")}
          </div>
        ) : undefined
      }
    >
      {note}
      {rows.length === 0 && <div style={{ fontSize: 12.5, color: C.mute, padding: "8px 0" }}>{t("No envelopes with a budget or spending this month.")}</div>}

      {overRows.length > 0 && (
        <>
          <div style={{ fontSize: 10.5, fontWeight: 750, letterSpacing: "0.16em", textTransform: "uppercase", color: C.neg, margin: "4px 2px 8px" }}>{t("Overspent")}</div>
          {overRows.map(({ e, pct, left, budget }) => (
            <button key={e.id} onClick={() => onOpenEnvelope(e.id, state.month)} style={rowBtnStyle}>
              <div style={rowHeadStyle}>
                <span style={rowNameStyle}>{e.name}</span>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: C.neg, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                  {Math.round(pct)}% · +{M(-left)}
                </span>
              </div>
              <div style={{ fontSize: 10.5, color: C.soft, marginBottom: 4 }}>{t("spent {spent} of {budget}", { spent: M(Math.max(0, e.spent)), budget: M(budget) })}</div>
              <Bar pct={pct} color={C.neg} />
            </button>
          ))}
        </>
      )}

      {nearRows.length > 0 && (
        <>
          <div style={{ fontSize: 10.5, fontWeight: 750, letterSpacing: "0.16em", textTransform: "uppercase", color: C.warn, margin: "18px 2px 8px" }}>{t("Near limit · ≥ 80%")}</div>
          {nearRows.map(({ e, pct, left }) => (
            <button key={e.id} onClick={() => onOpenEnvelope(e.id, state.month)} style={rowBtnStyle}>
              <div style={rowHeadStyle}>
                <span style={rowNameStyle}>{e.name}</span>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: C.warn, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                  {Math.round(pct)}% · {t("{amount} left", { amount: M(left) })}
                </span>
              </div>
              <Bar pct={pct} color={C.warn} />
            </button>
          ))}
        </>
      )}

      {(usedUpRows.length > 0 || restOkRows.length > 0) && (
        <>
          <div style={{ fontSize: 10.5, fontWeight: 750, letterSpacing: "0.16em", textTransform: "uppercase", color: C.mute, margin: "18px 2px 8px" }}>{t("Within budget")}</div>
          {usedUpRows.map(({ e, pct }) => (
            <button key={e.id} onClick={() => onOpenEnvelope(e.id, state.month)} style={rowBtnStyle}>
              <div style={rowHeadStyle}>
                <span style={rowNameStyle}>{e.name}</span>
                <span style={{ fontSize: 12.5, fontWeight: 700, color: C.soft, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                  {Math.round(pct)}% · {t("used up")}
                </span>
              </div>
              <Bar pct={100} color={C.mute} />
            </button>
          ))}
          {restOkRows.length > 0 &&
            (expanded ? (
              restOkRows.map(({ e, pct, left }) => (
                <button key={e.id} onClick={() => onOpenEnvelope(e.id, state.month)} style={rowBtnStyle}>
                  <div style={rowHeadStyle}>
                    <span style={rowNameStyle}>{e.name}</span>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                      {Math.round(pct)}% · {t("{amount} left", { amount: M(left) })}
                    </span>
                  </div>
                  <Bar pct={pct} color={e.color} />
                </button>
              ))
            ) : (
              <button
                onClick={() => setExpanded(true)}
                style={{ display: "block", width: "100%", background: "none", border: "none", textAlign: "center", padding: "2px 0 8px", fontSize: 12, color: C.mute, cursor: "pointer", fontFamily: "inherit" }}
              >
                {t("+ {n} envelopes within budget (avg {pct}%)", { n: restOkRows.length, pct: restAvgPct })}
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
 * `goalProgress`, zero duplication in the component. Band hero is the aggregate verdict ("All
 * goals funded ✓" in pos colors, or "Funded {pct}%" with an "{amount} to go" sub) — the per-row
 * funded/missing line below is NOT a repeat of that sentence, it is per-envelope. The `rows.length
 * > 0` guard keeps a budget with zero goals from reading as a false "All funded ✓" (nothing to
 * fund is not the same claim as everything funded); it instead shows a neutral 0% and the existing
 * empty-state copy in the body. Each row now leads with a `GoalRing` (kit.tsx) mirroring the hub
 * card, bar via `Bar`.
 */
function GoalsReport({
  state,
  M,
  onOpenEnvelope,
  onPrev,
  onNext,
  onBack,
  note,
}: {
  state: StateResponse;
  M: Mask;
  onOpenEnvelope: (envId: string, month: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onBack: () => void;
  note: ReactNode;
}) {
  const C = useTheme();
  const { t } = useT();
  const { hc } = useBand();
  const rows = state.envelopes
    .filter((e) => !e.archived)
    .flatMap((e) => {
      const gp = goalProgress(e);
      return gp ? [{ e, gp }] : [];
    })
    .sort((a, b) => a.gp.pct - b.gp.pct || a.e.name.localeCompare(b.e.name));
  const fundedSum = rows.reduce((s, { e }) => s + Math.min(Math.max(0, e.allocated), e.monthlyTarget ?? 0), 0);
  const targetSum = rows.reduce((s, { e }) => s + (e.monthlyTarget ?? 0), 0);
  const pctTotal = targetSum > 0 ? Math.round((fundedSum / targetSum) * 100) : 0;
  const missSum = rows.reduce((s, { gp }) => s + gp.missing, 0);
  const allFunded = rows.length > 0 && missSum === 0;
  return (
    <ReportShell
      title={t(TITLES.goals)}
      month={state.month}
      onPrev={onPrev}
      onNext={onNext}
      onBack={onBack}
      eyebrow={t("Goals")}
      hero={allFunded ? <span style={{ color: hc(C.headerPos, C.pos) }}>{t("All goals funded ✓")}</span> : t("Funded {pct}%", { pct: pctTotal })}
      sub={rows.length > 0 && missSum > 0 ? t("{amount} to go", { amount: M(missSum) }) : undefined}
    >
      {note}
      {rows.length === 0 && <div style={{ fontSize: 12.5, color: C.mute, padding: "8px 0" }}>{t("No envelopes with a goal. Set a monthly target when editing an envelope.")}</div>}
      {rows.map(({ e, gp }) => {
        const barColor = gp.funded ? C.pos : "var(--accent)";
        return (
          <button key={e.id} onClick={() => onOpenEnvelope(e.id, state.month)} style={{ display: "block", width: "100%", background: "none", border: "none", padding: "0 0 12px", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 3 }}>
              <span style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <GoalRing pct={gp.pct} size={16} />
                {e.name}
              </span>
              <span style={{ textAlign: "right", flexShrink: 0 }}>
                <span style={{ display: "block", fontSize: 12.5, fontWeight: 700, color: gp.funded ? C.pos : C.text, fontVariantNumeric: "tabular-nums" }}>{Math.round(gp.pct)}%</span>
                <span style={{ display: "block", fontSize: 10.5, color: gp.funded ? C.pos : C.soft, fontVariantNumeric: "tabular-nums" }}>
                  {gp.funded ? t("funded ✓") : t("{amount} to go", { amount: M(gp.missing) })}
                </span>
              </span>
            </div>
            <Bar pct={gp.pct} color={barColor} />
          </button>
        );
      })}
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
 * list sections are hidden entirely (not rendered empty) when there is nothing to show.
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
  note,
}: {
  cashflow: { month: string; income: number; expense: number; net: number }[];
  days: { date: string; total: number }[];
  places: { key: string; name: string; count: number; total: number }[];
  largest: { id: string; label: string; date: string; amount: number }[];
  M: Mask;
  month: string;
  onPrev: () => void;
  onNext: () => void;
  onBack: () => void;
  note: ReactNode;
}) {
  const C = useTheme();
  const { t, lang } = useT();
  const { hc } = useBand();

  const totIncome = cashflow.at(-1)?.income ?? 0;
  const totExpense = cashflow.at(-1)?.expense ?? 0;
  const totNet = totIncome - totExpense;
  const sr = savingsRate(cashflow);
  const srPct = sr.current !== null ? Math.round(sr.current * 100) : null;

  // peak day: first occurrence wins a tie (strict `>` below never overwrites on equal totals)
  let peak = days[0];
  for (const d of days) if (peak === undefined || d.total > peak.total) peak = d;
  const hasSpending = peak !== undefined && peak.total > 0;
  const avg = days.length > 0 ? Math.round(totExpense / days.length) : 0;

  const eyebrowStyle = { fontSize: 10.5, fontWeight: 750, letterSpacing: "0.16em", textTransform: "uppercase" as const, color: C.mute, margin: "18px 2px 8px" };
  const rowStyle = (last: boolean) => ({ display: "flex", justifyContent: "space-between", alignItems: "baseline" as const, padding: "9px 1px", borderBottom: last ? "none" : `1px solid ${C.line}`, fontSize: 13.5 });

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
      {note}
      <div style={eyebrowStyle}>{t("Day by day")}</div>
      <CalendarHeatmap days={days} lang={lang} mask={M} />
      <div style={{ fontSize: 11, color: C.mute, marginTop: 7 }}>
        {hasSpending && peak
          ? t("avg {amount}/day · peak: {date} ({amount2})", { amount: M(avg), date: shortDate(peak.date, lang), amount2: M(peak.total) })
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
          {largest.map((e, i) => (
            <div key={e.id} style={rowStyle(i === largest.length - 1)}>
              <span style={{ color: C.soft, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {e.label} <span style={{ color: C.mute }}>· {shortDate(e.date, lang)}</span>
              </span>
              <span style={{ fontWeight: 650, color: C.text, fontVariantNumeric: "tabular-nums", flexShrink: 0, marginLeft: 8 }}>{M(e.amount)}</span>
            </div>
          ))}
        </>
      )}
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
  const W = 340, H = 118, padX = 6, padY = 12;
  const innerW = W - 2 * padX, innerH = H - 2 * padY;
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
          <circle key={i} cx={px} cy={py} r={i === n - 1 ? 4 : 2.4} style={{ fill: i === n - 1 ? stroke : hole, stroke }} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
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
