import { useMemo, useState, type ReactNode } from "react";
import {
  computeCashflowSeries,
  computeDailySpending,
  computeEnvelopeTrends,
  computeNetWorthSeries,
  computeSpendingByDimension,
  prevMonth,
  savingsRate,
  type SpendingDimension,
} from "@enveo/shared";
import { useLedgerVersion, type StateResponse } from "../lib/api";
import { store } from "../lib/store";
import { Header } from "../components/chrome";
import { GoalRing, useBand } from "../components/kit";
import { ReportInfoNote } from "../components/ReportInfoNote";
import { DeltaTag, SegBar, Sparkline, TrendSpark } from "../components/reportKit";
import { useMask, useTheme } from "../lib/contexts";
import { monthLabel } from "../lib/dates";
import { goalProgress } from "../lib/goals";
import { useT, type Message, msg } from "../lib/i18n";
import { budgetsSummary } from "../lib/reportSummary";
import { P, TEAL } from "../lib/theme";

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
  const C = useTheme();
  const M = useMask();
  const { t, lang } = useT();
  const { band, hc } = useBand();
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
  const cashflow = useMemo(() => {
    if (view !== "cashflow" && view !== "overview") return [];
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
  // hub-only series: current month's envelope breakdown, this month's daily totals, 6-mo envelope trends
  const hubSpending = useMemo(() => {
    if (view !== "overview") return [];
    const l = store.getLedger();
    return l ? computeSpendingByDimension(l, month, month, "envelope") : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, month, view]);
  const dailySpending = useMemo(() => {
    if (view !== "overview") return [];
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

  // ── Subscreen: its own header (back + title + month) and the report content ──
  // Animation is `fi` ONLY (opacity) — `fu`/transform breaks position:fixed of sheets inside.
  return (
    <div className="gs" style={{ flex: 1, overflowY: "auto", paddingBottom: 6 }}>
      <div style={band ? { background: C.headerBg, paddingBottom: 2 } : undefined}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: `12px ${P}px 10px` }}>
          <button aria-label={t("Back")} onClick={() => onView("overview")} style={{ flexShrink: 0, width: 30, height: 30, borderRadius: 15, border: "none", background: "transparent", color: hc(C.headerInk, C.text), fontSize: 22, lineHeight: 1, cursor: "pointer", padding: 0, marginLeft: -6, display: "flex", alignItems: "center", justifyContent: "center" }}>‹</button>
          <span style={{ flex: 1, fontSize: 16, fontWeight: 700, color: hc(C.headerInk, C.text), overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t(TITLES[view])}</span>
          <span style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
            <button onClick={onPrev} style={{ border: "none", background: "transparent", color: hc(C.headerMute, C.soft), fontSize: 17, lineHeight: 1, cursor: "pointer", padding: "2px 7px" }}>‹</button>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: hc(C.headerInk, C.text), minWidth: 58, textAlign: "center" }}>{monthLabel(month, lang).split(" ")[0]}</span>
            <button onClick={onNext} style={{ border: "none", background: "transparent", color: hc(C.headerMute, C.soft), fontSize: 17, lineHeight: 1, cursor: "pointer", padding: "2px 7px" }}>›</button>
          </span>
        </div>
      </div>
      <div className="fi" style={{ padding: `0 ${P}px` }}>
        {NOTES[view] && <ReportInfoNote id={view} textKey={NOTES[view]!} />}
        {view === "assets" && <AssetsReport netWorth={netWorth} state={state} M={M} />}
        {view === "cashflow" && <CashflowReport cashflow={cashflow} M={M} />}
        {view === "spending" && <SpendingReport spending={spending} dim={dim} setDim={setDim} range={range} setRange={setRange} M={M} />}
        {view === "budgets" && <BudgetsReport state={state} M={M} onOpenEnvelope={onOpenEnvelope} />}
        {view === "goals" && <GoalsReport state={state} M={M} onOpenEnvelope={onOpenEnvelope} />}
        {/* Month-in-a-nutshell subscreen — Task 11 fills this in. */}
        {view === "month" && <div />}
        {/* Envelope-trends subscreen — Task 12 fills this in. */}
        {view === "trends" && <div />}
      </div>
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

/** Net worth + assets (envelopes flagged as savings) in a single view. */
function AssetsReport({ netWorth, state, M }: { netWorth: { month: string; total: number }[]; state: StateResponse; M: Mask }) {
  const C = useTheme();
  const { t } = useT();
  const nwLast = netWorth.at(-1)?.total ?? 0;
  const nwDelta = nwLast - (netWorth.at(-2)?.total ?? nwLast);
  const savings = state.envelopes.filter((e) => !e.archived && e.isSavings);
  const total = savings.reduce((s, e) => s + e.available, 0);
  const pct = nwLast !== 0 ? Math.round((total / nwLast) * 100) : 0;
  const max = Math.max(...savings.map((e) => Math.abs(e.available)), 1);
  return (
    <>
      <div style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: "2px 0 4px" }}>{t("Net worth")}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 22, fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums" }}>{M(nwLast)}</span>
        {nwDelta !== 0 && <span style={{ fontSize: 12.5, fontWeight: 600, color: nwDelta > 0 ? C.pos : C.neg, fontVariantNumeric: "tabular-nums" }}>{nwDelta > 0 ? "▲ +" : "▼ "}{M(Math.abs(nwDelta))} {t("m/m")}</span>}
      </div>
      <NetWorthChart points={netWorth} mask={M} />

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
              <div style={{ height: 8, background: C.line, borderRadius: 4, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${(Math.max(0, e.available) / max) * 100}%`, background: TEAL, borderRadius: 4 }} />
              </div>
            </div>
          ))}
        </>
      )}
    </>
  );
}

function CashflowReport({ cashflow, M }: { cashflow: { month: string; income: number; expense: number; net: number }[]; M: Mask }) {
  const C = useTheme();
  const { t, lang } = useT();
  const totIncome = cashflow.reduce((s, p) => s + p.income, 0);
  const totExpense = cashflow.reduce((s, p) => s + p.expense, 0);
  const totNet = totIncome - totExpense;
  const maxAbs = Math.max(...cashflow.map((p) => Math.abs(p.net)), 1);
  return (
    <>
      <div style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: "2px 0 8px" }}>{t("Cash flow (12 mo)")}</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
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
    </>
  );
}

function SpendingReport({ spending, dim, setDim, range, setRange, M }: { spending: { key: string | null; name: string; amount: number; pct: number }[]; dim: SpendingDimension; setDim: (d: SpendingDimension) => void; range: number; setRange: (n: number) => void; M: Mask }) {
  const C = useTheme();
  const { t } = useT();
  const spMax = Math.max(...spending.map((r) => r.amount), 1);
  const spTotal = spending.reduce((s, r) => s + r.amount, 0);
  return (
    <>
      <div style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: "2px 0 8px" }}>{t("Spending by dimension")}</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
        {DIMENSIONS.map((d) => (
          <button key={d.id} onClick={() => setDim(d.id)} style={{ padding: "5px 11px", borderRadius: 9, border: `1px solid ${dim === d.id ? TEAL : C.line}`, background: dim === d.id ? "var(--accent-1a)" : "transparent", color: dim === d.id ? TEAL : C.soft, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>{t(d.label)}</button>
        ))}
      </div>
      <div style={{ display: "flex", background: C.bg, borderRadius: 9, padding: 2, border: `1px solid ${C.line}`, marginBottom: 12 }}>
        {RANGES.map((r) => (
          <button key={r.n} onClick={() => setRange(r.n)} style={{ flex: 1, padding: "6px 0", borderRadius: 7, border: `1px solid ${range === r.n ? TEAL : "transparent"}`, fontSize: 11.5, fontWeight: 600, cursor: "pointer", background: range === r.n ? "var(--accent-1a)" : "transparent", color: range === r.n ? TEAL : C.soft }}>{t(r.label)}</button>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 12.5 }}>
        <span style={{ color: C.soft }}>{t("Total spending")}</span>
        <span style={{ fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums" }}>{M(spTotal)}</span>
      </div>
      {spending.length === 0 && <div style={{ fontSize: 12.5, color: C.mute, padding: "8px 0" }}>{t("No spending in this period.")}</div>}
      {spending.map((r) => (
        <div key={r.key ?? "none"} style={{ marginBottom: 9 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
            <span style={{ fontSize: 13, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: C.text, fontVariantNumeric: "tabular-nums", flexShrink: 0, marginLeft: 8 }}>{M(r.amount)} · {Math.round(r.pct * 100)}%</span>
          </div>
          <div style={{ height: 8, background: C.line, borderRadius: 4, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${(r.amount / spMax) * 100}%`, background: TEAL, borderRadius: 4 }} />
          </div>
        </div>
      ))}
    </>
  );
}

/**
 * "Budgets" tab (spec §4, evolution of "Overruns"): every envelope with an allocation
 * (allocated+carryIn > 0) or spending in the month; spent/budget bar with thresholds
 * >100% red / 80–100% amber / the rest in the envelope color; sorted descending by %.
 */
function BudgetsReport({ state, M, onOpenEnvelope }: { state: StateResponse; M: Mask; onOpenEnvelope: (envId: string, month: string) => void }) {
  const C = useTheme();
  const { t, lang } = useT();
  const rows = state.envelopes
    .filter((e) => !e.archived && (e.allocated + e.carryIn > 0 || e.spent > 0))
    .map((e) => {
      const budget = Math.max(1, e.allocated + e.carryIn);
      const pct = (Math.max(0, e.spent) / budget) * 100;
      return { e, pct, left: e.available };
    })
    .sort((a, b) => b.pct - a.pct || a.e.name.localeCompare(b.e.name));
  return (
    <>
      <div style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: "2px 0 2px" }}>{t("Envelope budgets — {month}", { month: monthLabel(state.month, lang) })}</div>
      <div style={{ fontSize: 11.5, color: C.mute, marginBottom: 10 }}>{t("This month's spending vs. the envelope budget (allocation + carry-over).")}</div>
      {rows.length === 0 && <div style={{ fontSize: 12.5, color: C.mute, padding: "8px 0" }}>{t("No envelopes with a budget or spending this month.")}</div>}
      {rows.map(({ e, pct, left }) => {
        const barColor = pct > 100 ? C.neg : pct >= 80 ? C.warn : e.color;
        return (
          <button key={e.id} onClick={() => onOpenEnvelope(e.id, state.month)} style={{ display: "block", width: "100%", background: "none", border: "none", padding: "0 0 12px", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 3 }}>
              <span style={{ fontSize: 13, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
              <span style={{ textAlign: "right", flexShrink: 0 }}>
                <span style={{ display: "block", fontSize: 12.5, fontWeight: 700, color: pct > 100 ? C.neg : pct >= 80 ? C.warn : C.text, fontVariantNumeric: "tabular-nums" }}>{Math.round(pct)}%</span>
                <span style={{ display: "block", fontSize: 10.5, color: left < 0 ? C.neg : C.soft, fontVariantNumeric: "tabular-nums" }}>
                  {left < 0 ? t("over by {amount}", { amount: M(-left) }) : t("{amount} left", { amount: M(left) })}
                </span>
              </span>
            </div>
            <div style={{ height: 8, background: C.line, borderRadius: 4, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${Math.min(100, pct)}%`, background: barColor, borderRadius: 4 }} />
            </div>
          </button>
        );
      })}
    </>
  );
}

/**
 * "Goals" tab (spec §4): envelopes with a monthly goal (monthlyTarget > 0),
 * bar = funding (allocated) relative to the goal; sorted ascending by %, then name.
 * Math EXCLUSIVELY via goalProgress — zero duplication in the component.
 */
function GoalsReport({ state, M, onOpenEnvelope }: { state: StateResponse; M: Mask; onOpenEnvelope: (envId: string, month: string) => void }) {
  const C = useTheme();
  const { t, lang } = useT();
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
  return (
    <>
      <div style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: "2px 0 2px" }}>{t("Envelope goals — {month}", { month: monthLabel(state.month, lang) })}</div>
      <div style={{ fontSize: 11.5, color: C.mute, marginBottom: 10 }}>{t("Funding vs monthly targets")}</div>
      {rows.length === 0 && <div style={{ fontSize: 12.5, color: C.mute, padding: "8px 0" }}>{t("No envelopes with a goal. Set a monthly target when editing an envelope.")}</div>}
      {rows.length > 0 && (
        <div style={{ fontSize: 12.5, fontWeight: 600, color: missSum === 0 ? C.pos : C.soft, marginBottom: 10, fontVariantNumeric: "tabular-nums" }}>
          {missSum === 0 ? t("All goals funded ✓") : t("Funded {pct}% · {amount} to go", { pct: pctTotal, amount: M(missSum) })}
        </div>
      )}
      {rows.map(({ e, gp }) => {
        const barColor = gp.funded ? C.pos : "var(--accent)";
        return (
          <button key={e.id} onClick={() => onOpenEnvelope(e.id, state.month)} style={{ display: "block", width: "100%", background: "none", border: "none", padding: "0 0 12px", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 3 }}>
              <span style={{ fontSize: 13, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
              <span style={{ textAlign: "right", flexShrink: 0 }}>
                <span style={{ display: "block", fontSize: 12.5, fontWeight: 700, color: gp.funded ? C.pos : C.text, fontVariantNumeric: "tabular-nums" }}>{Math.round(gp.pct)}%</span>
                <span style={{ display: "block", fontSize: 10.5, color: gp.funded ? C.pos : C.soft, fontVariantNumeric: "tabular-nums" }}>
                  {gp.funded ? t("funded ✓") : t("{amount} to go", { amount: M(gp.missing) })}
                </span>
              </span>
            </div>
            <div style={{ height: 8, background: C.line, borderRadius: 4, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${gp.pct}%`, background: barColor, borderRadius: 4 }} />
            </div>
          </button>
        );
      })}
    </>
  );
}

/** Net-worth line chart with the axis clipped to the min–max range. */
function NetWorthChart({ points, mask }: { points: { month: string; total: number }[]; mask: Mask }) {
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
  return (
    <div style={{ marginBottom: 6 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", height: "auto" }} role="img" aria-label={t("Net worth over time")}>
        {/* fill/stroke via style — var(--accent) does not work in SVG presentation attributes */}
        <path d={area} style={{ fill: TEAL }} opacity={0.12} />
        <path d={line} fill="none" style={{ stroke: TEAL }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {pts.map(([px, py], i) => (
          <circle key={i} cx={px} cy={py} r={i === n - 1 ? 4 : 2.4} style={{ fill: i === n - 1 ? TEAL : C.bg, stroke: TEAL }} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 4, fontSize: 10.5, color: C.mute }}>
        <span>{monthLabel(points[0]!.month, lang).split(" ")[0]}</span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>{t("range {min}–{max}", { min: mask(min), max: mask(max) })}</span>
        <span>{monthLabel(points[n - 1]!.month, lang).split(" ")[0]}</span>
      </div>
    </div>
  );
}
