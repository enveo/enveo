import { type EnvelopeTrend, median, savingsRate } from "@enveo/shared";
import type { ReactNode } from "react";
import { GoalRing, useBand } from "../../components/kit";
import { DeltaTag, heatColor, NetWorthChart, ReportShell, SegBar, TrendSpark } from "../../components/reportKit";
import type { StateResponse } from "../../lib/api";
import { useMask, useTheme } from "../../lib/contexts";
import { goalProgress } from "../../lib/goals";
import { useT } from "../../lib/i18n";
import { budgetsOverAmount, budgetsSummary } from "../../lib/reportSummary";
import { useWideHost } from "../../lib/shellContext";
import { useElementWidth } from "../../lib/useElementWidth";
import { trendColor } from "./charts";
import type { Mask, ReportTab, ReportView } from "./types";

const SPENDING_FALLBACK_COLORS = ["#8f84a8", "#aed6ea", "#ccd9b6", "#f0c84f"];

/**
 * Reports hub (frame A1, "Gabinet" direction): the global Header, then a tappable net-worth
 * band hero (eyebrow, 30px masked amount, ▲/▼ m/m delta, 12-mo sparkline — on `C.headerBg`
 * when the theme paints a Duet band, plain otherwise, exactly like every other screen's header),
 * then a 2-column grid of six mini-cards, one per subscreen, each showing just its essence.
 * Every card is a `<button>` → `onView(id)`.
 */
export function ReportsHub({
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
  selected,
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
  /** Wide only: the report tab currently open in the side panel, so its card can be picked out
   *  from the grid — the hub itself always stays on screen there (Reports.tsx forces `view`
   *  to "overview" in the primary pane regardless of what is open beside it), so without this the
   *  open report would have no visible trace in the hub at all. `undefined` on phone (no panel to
   *  reflect) and on wide with nothing open yet. */
  selected?: ReportTab;
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
      <ReportShell
        variant="hub"
        month={month}
        onPrev={onPrev}
        onNext={onNext}
        onMenu={onMenu}
        onHeroClick={() => onView("assets")}
        eyebrow={t("Net worth")}
        hero={M(nwLast)}
        sub={
          <>
            {nwDelta !== 0 && (
              <span style={{ color: nwDelta > 0 ? hc(C.headerPos, C.pos) : hc(C.headerNeg, C.neg), fontWeight: 650 }}>
                {nwDelta > 0 ? "▲ +" : "▼ "}
                {M(Math.abs(nwDelta))}
              </span>
            )}{" "}
            {t("m/m")} · {t("details")} ›
          </>
        }
        bandChart={<NetWorthChart points={netWorth} height={130} onBand={band} />}
      >
        {/* Fixed 2-up at every width (mockup inconsistency 4, pr4-context.md §0b/§12 — CLOSED,
            do not relitigate): the mock's fold column drops to a single simplified card per row,
            but that is a property of ITS stripped-down cards, not of this layout — these minis
            are fluid (`useElementWidth` throughout) and already read fine well under a phone's
            own width. At the wide breakpoints this shell actually ships (task 4's `geometry.ts`),
            the 804px desktop primary gives each card ≈385px and the 484px fold primary ≈229px —
            both comfortably above the ~190px this grid already renders at on a phone, so nothing
            here needs the fold's 1-column fallback the mock draws. */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <CashflowMini cashflow={cashflow} onView={onView} M={M} selected={selected === "cashflow"} />
          <SpendingMini rows={hubSpending} envColor={envColor} cashflow={cashflow} onView={onView} M={M} selected={selected === "spending"} />
          <BudgetsMini envelopes={state.envelopes} onView={onView} M={M} selected={selected === "budgets"} />
          {goalRows.length > 0 && <GoalsMini pctTotal={pctTotal} missSum={missSum} onView={onView} M={M} selected={selected === "goals"} />}
          <MonthMini days={dailySpending} onView={onView} M={M} selected={selected === "month"} />
          <TrendsMini trends={envelopeTrends} onView={onView} selected={selected === "trends"} />
        </div>
      </ReportShell>
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
 * that native centering so every card top-aligns its content, tall or short.
 *
 * Border/shadow (design parity wave D task 1): the design gives every card a 1px border (`T.line`
 * quiet, `T.accent` for the open report) and elevates its shadow on selection (measured off the
 * source of truth, `reportCards`'s own `border`/`shadow` derivation) — gated to WIDE only so
 * phone's cards stay pixel-identical to before this prop existed (`selected` is always `undefined`
 * there, same as always). */
function MiniCard({ title, onClick, selected, children }: { title: string; onClick: () => void; selected?: boolean; children: ReactNode }) {
  const C = useTheme();
  const inWide = useWideHost() !== null;
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
        // `var(--accent)` does not resolve in an SVG presentation attribute, but this IS a plain
        // HTML `style` object (not an attribute) — the CSS var resolves here same as any other
        // inline style.
        border: inWide ? `1px solid ${selected ? "var(--accent)" : C.line}` : selected ? "1.5px solid var(--accent)" : "none",
        boxShadow: inWide && selected ? "0 2px 8px rgba(20,20,28,0.10)" : "0 1px 3px rgba(20,20,28,0.06)",
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
  selected,
}: {
  cashflow: { month: string; income: number; expense: number; net: number }[];
  onView: (v: ReportView) => void;
  M: Mask;
  selected?: boolean;
}) {
  const C = useTheme();
  const { t } = useT();
  const gap = 2,
    H = 34,
    base = H / 2,
    maxH = 15;
  // Fallback is the card's REAL width, not the old hardcoded viewBox: this mini sits in a
  // two-column hub grid on a ~390px viewport ((362 − 10) / 2 ≈ 176) less MiniCard's 13px side
  // padding, so ~150. It is only ever shown for the frame(s) before the ResizeObserver reports,
  // but a fallback that undershoots by a third reintroduces a milder version of the pillarboxing
  // this component was just fixed for.
  const [boxRef, W] = useElementWidth<HTMLDivElement>(150);
  const n = cashflow.length;
  // Guards `barW`'s division by `n`: an empty series would otherwise draw Infinity/NaN geometry.
  // Pre-existing (not introduced by this PR) — the same guard as `CashflowBandChart`.
  if (n === 0) return null;
  const barW = (W - Math.max(0, n - 1) * gap) / n;
  const maxAbs = Math.max(...cashflow.map((p) => Math.abs(p.net)), 1);
  const net = cashflow.at(-1)?.net ?? 0;
  const sr = savingsRate(cashflow);
  const pct = sr.current !== null ? Math.round(sr.current * 100) : "–";
  return (
    <MiniCard title={t("Cash flow")} onClick={() => onView("cashflow")} selected={selected}>
      <div ref={boxRef}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} aria-hidden="true" style={{ display: "block" }}>
          <line x1={0} y1={base} x2={W} y2={base} style={{ stroke: C.line }} strokeWidth={1} />
          {cashflow.map((p, i) => {
            const h = Math.max(1, Math.round((Math.abs(p.net) / maxAbs) * maxH));
            const x = i * (barW + gap);
            const y = p.net >= 0 ? base - h : base;
            return <rect key={p.month} x={x} y={y} width={barW} height={h} rx={2} style={{ fill: p.net >= 0 ? C.pos : C.neg }} />;
          })}
        </svg>
      </div>
      <div style={{ fontSize: 17, fontWeight: 750, color: net >= 0 ? C.pos : C.neg, marginTop: 6, fontVariantNumeric: "tabular-nums" }}>
        {net >= 0 ? "+" : "−"}
        {M(Math.abs(net))}
      </div>
      <div style={{ fontSize: 11, color: C.mute }}>{t("savings rate {pct}%", { pct })}</div>
    </MiniCard>
  );
}

/** Spending mini-card: SegBar of the top-4 envelopes (own color) + rest in C.line, month total,
 *  and a DeltaTag against the median of the 3 preceding months' cashflow expense. */
function SpendingMini({
  rows,
  envColor,
  cashflow,
  onView,
  M,
  selected,
}: {
  rows: { key: string | null; name: string; amount: number; pct: number }[];
  envColor: Map<string, string>;
  cashflow: { month: string; income: number; expense: number; net: number }[];
  onView: (v: ReportView) => void;
  M: Mask;
  selected?: boolean;
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
    <MiniCard title={t("Spending")} onClick={() => onView("spending")} selected={selected}>
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
function BudgetsMini({
  envelopes,
  onView,
  M,
  selected,
}: {
  envelopes: StateResponse["envelopes"];
  onView: (v: ReportView) => void;
  M: Mask;
  selected?: boolean;
}) {
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
    <MiniCard title={t("Budgets")} onClick={() => onView("budgets")} selected={selected}>
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
function GoalsMini({
  pctTotal,
  missSum,
  onView,
  M,
  selected,
}: {
  pctTotal: number;
  missSum: number;
  onView: (v: ReportView) => void;
  M: Mask;
  selected?: boolean;
}) {
  const C = useTheme();
  const { t } = useT();
  const funded = missSum === 0;
  return (
    <MiniCard title={t("Goals")} onClick={() => onView("goals")} selected={selected}>
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
function MonthMini({ days, onView, M, selected }: { days: { date: string; total: number }[]; onView: (v: ReportView) => void; M: Mask; selected?: boolean }) {
  const C = useTheme();
  const { t } = useT();
  const first10 = days.slice(0, 10);
  const max = Math.max(...days.map((d) => d.total), 1);
  const avg = days.length > 0 ? Math.round(days.reduce((s, d) => s + d.total, 0) / days.length) : 0;
  return (
    <MiniCard title={t("Month in a nutshell")} onClick={() => onView("month")} selected={selected}>
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
 *  a mini TrendSpark (red rising / green falling / muted flat) and an arrow per row.
 *
 *  TrendSpark waiver (pr4-context.md §6, recorded): `TrendSpark`'s `w` is normally caller-fixed —
 *  it draws inside a row shared with text, where measuring the row itself would be wrong (see its
 *  own doc comment in reportKit.tsx). On a wide pane this card is much wider than a phone's ~150,
 *  so instead of leaving the spark phone-width-fixed forever, the ref measures an inner row div
 *  passed as `MiniCard`'s `children` — a normal flex child of the button's `alignItems: "stretch"`
 *  column, so it already fills the button's own padded content box with no padding math needed
 *  (`useElementWidth`'s usual "no padding between the ref and the chart" invariant holds as-is).
 *  The ref must stay on a div INSIDE the button, not one wrapping `MiniCard` itself: a wrapping
 *  div would become the grid's direct child instead of the button, and a plain block div does not
 *  propagate the grid's `align-items: stretch` to a child, leaving the visible card short of the
 *  row height whenever a sibling in the same row is taller. `Math.max(120, …)` keeps a
 *  collapsed/unmeasured frame from ever drawing narrower than the phone's own historical 150. */
function TrendsMini({ trends, onView, selected }: { trends: EnvelopeTrend[]; onView: (v: ReportView) => void; selected?: boolean }) {
  const C = useTheme();
  const { t } = useT();
  const top = trends.slice(0, 2);
  const [rowRef, rowW] = useElementWidth<HTMLDivElement>(150);
  const sparkW = Math.max(120, rowW);
  return (
    <MiniCard title={t("Envelope trends")} onClick={() => onView("trends")} selected={selected}>
      <div ref={rowRef}>
        {top.length === 0 && <div style={{ fontSize: 11.5, color: C.mute }}>{t("Not enough data yet.")}</div>}
        {top.map((tr) => {
          const color = trendColor(tr, C);
          const rising = color === C.neg;
          const falling = color === C.pos;
          return (
            <div key={tr.id} style={{ marginBottom: 4 }}>
              <TrendSpark series={tr.series} color={color} w={sparkW} h={16} />
              <div style={{ fontSize: 11, color: C.soft, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {tr.name} {rising && <span style={{ color: C.neg, fontWeight: 650 }}>↑</span>}
                {falling && <span style={{ color: C.pos, fontWeight: 650 }}>↓</span>}
              </div>
            </div>
          );
        })}
      </div>
    </MiniCard>
  );
}
