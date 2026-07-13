import { useMemo, useState, type ReactNode } from "react";
import { computeCashflowSeries, computeNetWorthSeries, computeSpendingByDimension, prevMonth, type SpendingDimension } from "@enveo/shared";
import { useLedgerVersion, type StateResponse } from "../lib/api";
import { store } from "../lib/store";
import { Header } from "../components/chrome";
import { ReportInfoNote } from "../components/ReportInfoNote";
import { SubscriptionsTab } from "../components/SubscriptionsTab";
import { useMask, useTheme } from "../lib/contexts";
import { monthLabel, shortDate, todayISO } from "../lib/dates";
import { goalProgress } from "../lib/goals";
import { useT, type Message, msg } from "../lib/i18n";
import { budgetsSummary, upcomingWindow, type UpcomingWindow } from "../lib/reportSummary";
import { CORAL, INCOME, P, TEAL, type Theme } from "../lib/theme";

export type ReportTab = "assets" | "cashflow" | "spending" | "budgets" | "goals" | "subs";
/** Reports view: shortcut-card overview or a full-screen report subscreen. */
export type ReportView = "overview" | ReportTab;
const TITLES: Record<ReportTab, Message> = {
  assets: msg("Wealth"),
  cashflow: msg("Cash flow"),
  spending: msg("Spending"),
  budgets: msg("Budgets"),
  goals: msg("Goals"),
  subs: msg("Upcoming payments"),
};
/** "How to read this" note per report (ReportInfoNote renders `**bold**`). */
const NOTES: Record<ReportTab, Message> = {
  assets: msg("All account balances minus liabilities, month by month. When the line **goes up**, you are building wealth; dips are explained in Cashflow."),
  cashflow: msg("Income minus spending, month by month. Bar **to the right** = you are saving, **to the left** = the month ran a deficit."),
  spending: msg("Where your money actually went in the selected period — grouped by category, envelope, group, or place."),
  budgets: msg("Spending versus the amounts available in envelopes. **Amber** = approaching the limit (≥ 80%), **red** = overspent."),
  goals: msg("How much of each envelope's monthly target you have **funded**. A full bar = the contribution is set aside, regardless of how much of it you have spent."),
  subs: msg("Planned and recurring payments for the coming weeks. Tap an item to **move its date, pause, or delete** the rule."),
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

  // ── Overview: global Header + 6 shortcut cards with the essentials ──
  if (view === "overview") {
    return (
      <div className="gs" style={{ flex: 1, overflowY: "auto", paddingBottom: 6 }}>
        <Header month={month} onMenu={onMenu} onPrev={onPrev} onNext={onNext} />
        <div style={{ padding: `2px ${P}px 0` }}>
          <OverviewCards state={state} month={month} netWorth={netWorth} cashflow={cashflow} onView={onView} />
        </div>
      </div>
    );
  }

  // ── Subscreen: its own header (back + title + month) and the report content ──
  // Animation is `fi` ONLY (opacity) — `fu`/transform breaks position:fixed
  // of sheets inside (SubscriptionsTab opens sheets).
  const monthly = view !== "subs";
  return (
    <div className="gs" style={{ flex: 1, overflowY: "auto", paddingBottom: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: `12px ${P}px 10px` }}>
        <button aria-label={t("Back")} onClick={() => onView("overview")} style={{ flexShrink: 0, width: 30, height: 30, borderRadius: 15, border: "none", background: "transparent", color: C.text, fontSize: 22, lineHeight: 1, cursor: "pointer", padding: 0, marginLeft: -6, display: "flex", alignItems: "center", justifyContent: "center" }}>‹</button>
        <span style={{ flex: 1, fontSize: 16, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t(TITLES[view])}</span>
        {monthly ? (
          <span style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
            <button onClick={onPrev} style={{ border: "none", background: "transparent", color: C.soft, fontSize: 17, lineHeight: 1, cursor: "pointer", padding: "2px 7px" }}>‹</button>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: C.text, minWidth: 58, textAlign: "center" }}>{monthLabel(month, lang).split(" ")[0]}</span>
            <button onClick={onNext} style={{ border: "none", background: "transparent", color: C.soft, fontSize: 17, lineHeight: 1, cursor: "pointer", padding: "2px 7px" }}>›</button>
          </span>
        ) : (
          <span style={{ fontSize: 12.5, fontWeight: 600, color: C.soft, flexShrink: 0 }}>{t("30 days")}</span>
        )}
      </div>
      <div className="fi" style={{ padding: `0 ${P}px` }}>
        <ReportInfoNote id={view} textKey={NOTES[view]} />
        {view === "assets" && <AssetsReport netWorth={netWorth} state={state} M={M} />}
        {view === "cashflow" && <CashflowReport cashflow={cashflow} M={M} />}
        {view === "spending" && <SpendingReport spending={spending} dim={dim} setDim={setDim} range={range} setRange={setRange} M={M} />}
        {view === "budgets" && <BudgetsReport state={state} M={M} onOpenEnvelope={onOpenEnvelope} />}
        {view === "goals" && <GoalsReport state={state} M={M} onOpenEnvelope={onOpenEnvelope} />}
        {view === "subs" && <SubscriptionsTab />}
      </div>
    </div>
  );
}

const EMPTY_UPCOMING: UpcomingWindow = { payments: [], total: 0, nearest: null };

/**
 * Overview: shortcut cards with the essence of each report (spec 2026-07-11-raporty-b;
 * order per user feedback: net worth, cashflow, SPENDING (colored preview),
 * goals, budgets, upcoming LAST). Tap → subscreen.
 * Math: netWorth/cashflow series from ReportsScreen, budgetsSummary/upcomingWindow
 * from lib/reportSummary (parity with BudgetsReport/SubscriptionsTab), goals like GoalsReport.
 */
function OverviewCards({ state, month, netWorth, cashflow, onView }: { state: StateResponse; month: string; netWorth: { month: string; total: number }[]; cashflow: { month: string; income: number; expense: number; net: number }[]; onView: (v: ReportView) => void }) {
  const C = useTheme();
  const M = useMask();
  const { t, lang } = useT();
  const version = useLedgerVersion();
  const today = todayISO();

  const upcoming = useMemo(() => {
    const l = store.getLedger();
    return l ? upcomingWindow(l, today, 30) : EMPTY_UPCOMING;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, today]);
  // spending preview by ENVELOPES (consistent with the subscreen's default dimension);
  // full list for the bar, top-3 for the legend
  const spendingRows = useMemo(() => {
    const l = store.getLedger();
    return l ? computeSpendingByDimension(l, month, month, "envelope") : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, month]);
  const envColor = new Map(state.envelopes.map((e) => [e.id, e.color]));

  // net worth: last point + m/m delta (like AssetsReport)
  const nwLast = netWorth.at(-1)?.total ?? 0;
  const nwDelta = nwLast - (netWorth.at(-2)?.total ?? nwLast);
  // current month's cashflow = last point of the series
  const cf = cashflow.at(-1);
  const cfNet = cf?.net ?? 0;
  // goals: sum as in GoalsReport (card hidden when zero envelopes have a goal)
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
  // budgets: threshold counters (parity with BudgetsReport via budgetsSummary)
  const bs = budgetsSummary(state.envelopes);
  const bsTotal = bs.over + bs.near + bs.ok;

  const card = (id: ReportTab, title: string, body: ReactNode) => (
    <button key={id} onClick={() => onView(id)} style={{ display: "block", width: "100%", background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: "12px 14px", marginBottom: 12, cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginBottom: 7 }}>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: C.text }}>{title}</span>
        <span style={{ fontSize: 12, color: "var(--accent)", flexShrink: 0 }}>{t("details")} ›</span>
      </div>
      {body}
    </button>
  );

  return (
    <>
      {card(
        "assets",
        t("Net worth"),
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontSize: 18, fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums" }}>{M(nwLast)}</span>
            {nwDelta !== 0 && <span style={{ fontSize: 11.5, fontWeight: 600, color: nwDelta > 0 ? INCOME : CORAL, fontVariantNumeric: "tabular-nums" }}>{nwDelta > 0 ? "▲ +" : "▼ "}{M(Math.abs(nwDelta))}</span>}
          </div>
          <Sparkline points={netWorth} />
        </>,
      )}
      {card(
        "cashflow",
        t("Cash flow — {month}", { month: monthLabel(month, lang).split(" ")[0]! }),
        <div style={{ display: "flex", gap: 8 }}>
          {([[t("Income"), cf?.income ?? 0, INCOME], [t("Expense"), cf?.expense ?? 0, CORAL], [t("Net"), cfNet, cfNet >= 0 ? INCOME : CORAL]] as const).map(([label, val, col]) => (
            <div key={label} style={{ flex: 1 }}>
              <div style={{ fontSize: 10.5, color: C.soft }}>{label}</div>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: col, fontVariantNumeric: "tabular-nums" }}>{M(val)}</div>
            </div>
          ))}
        </div>,
      )}
      {card("spending", t("Spending breakdown"), <SpendingPreview rows={spendingRows} envColor={envColor} C={C} />)}
      {goalRows.length > 0 &&
        card(
          "goals",
          t("Goals"),
          <>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: missSum === 0 ? SAGE : C.soft, fontVariantNumeric: "tabular-nums" }}>
              {missSum === 0 ? t("All goals funded ✓") : t("Funded {pct}% · {amount} to go", { pct: pctTotal, amount: M(missSum) })}
            </div>
            <div style={{ height: 8, background: C.bg, borderRadius: 4, overflow: "hidden", marginTop: 7 }}>
              <div style={{ height: "100%", width: `${pctTotal}%`, background: missSum === 0 ? SAGE : "var(--accent)", borderRadius: 4 }} />
            </div>
          </>,
        )}
      {card(
        "budgets",
        t("Envelope budgets"),
        <>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: C.soft, fontVariantNumeric: "tabular-nums" }}>
            <span style={bs.over > 0 ? { color: "var(--danger)" } : undefined}>{t("{n} over", { n: bs.over })}</span>
            {" · "}
            {t("{n} near limit", { n: bs.near })}
            {" · "}
            {t("{n} OK", { n: bs.ok })}
          </div>
          {bsTotal > 0 && (
            <div style={{ display: "flex", gap: 3, height: 8, marginTop: 7 }}>
              {([[bs.over, "var(--danger)"], [bs.near, AMBER], [bs.ok, SAGE]] as const).map(([n, color], i) =>
                n > 0 ? <span key={i} style={{ flex: n, minWidth: 8, background: color, borderRadius: 4 }} /> : null,
              )}
            </div>
          )}
        </>,
      )}
      {card(
        "subs",
        t("Upcoming payments"),
        <div style={{ fontSize: 12.5, color: C.soft, fontVariantNumeric: "tabular-nums", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {upcoming.nearest
            ? t("30 days · {total} · next: {name}, {date}", { total: M(upcoming.total), name: upcoming.nearest.name, date: shortDate(upcoming.nearest.date, lang) })
            : t("30 days · no planned payments")}
        </div>,
      )}
    </>
  );
}

/** Spending structure preview: a segmented bar in envelope colors + top-3 legend. */
function SpendingPreview({ rows, envColor, C }: { rows: Array<{ key: string | null; name: string; amount: number; pct: number }>; envColor: Map<string, string>; C: Theme }) {
  const { t } = useT();
  if (rows.length === 0) return <div style={{ fontSize: 12.5, color: C.soft }}>{t("No spending in this period.")}</div>;
  const top = rows.slice(0, 4);
  const restPct = Math.max(0, 1 - top.reduce((s, r) => s + r.pct, 0));
  const colorOf = (r: { key: string | null }, i: number) => (r.key && envColor.get(r.key)) || ["#8f84a8", "#aed6ea", "#ccd9b6", "#f0c84f"][i % 4]!;
  return (
    <>
      <div style={{ display: "flex", gap: 3, height: 10, marginBottom: 7 }}>
        {top.map((r, i) => (
          <span key={r.key ?? i} style={{ flex: Math.max(r.pct, 0.02), minWidth: 8, background: colorOf(r, i), borderRadius: 5 }} />
        ))}
        {restPct > 0.01 && <span style={{ flex: restPct, minWidth: 6, background: C.inset, borderRadius: 5 }} />}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "3px 12px" }}>
        {top.slice(0, 3).map((r, i) => (
          <span key={r.key ?? i} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, color: C.soft, fontVariantNumeric: "tabular-nums" }}>
            <span style={{ width: 8, height: 8, borderRadius: 3, background: colorOf(r, i), flexShrink: 0 }} />
            {r.name} <b style={{ color: C.text }}>{Math.round(r.pct * 100)}%</b>
          </span>
        ))}
      </div>
    </>
  );
}

/** Net-worth mini-sparkline on the card (polyline without fill; stroke via style — var(--accent) does not work in SVG attributes). */
function Sparkline({ points }: { points: { month: string; total: number }[] }) {
  const n = points.length;
  if (n < 2) return null;
  const W = 320, H = 44, pad = 3;
  const totals = points.map((p) => p.total);
  const min = Math.min(...totals);
  const max = Math.max(...totals);
  const range = max - min || 1;
  const flat = max === min;
  const pts = points
    .map((p, i) => `${(pad + (i / (n - 1)) * (W - 2 * pad)).toFixed(1)},${(flat ? H / 2 : pad + (1 - (p.total - min) / range) * (H - 2 * pad)).toFixed(1)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={44} aria-hidden style={{ display: "block", marginTop: 8 }}>
      <polyline points={pts} fill="none" style={{ stroke: TEAL }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
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
        {nwDelta !== 0 && <span style={{ fontSize: 12.5, fontWeight: 600, color: nwDelta > 0 ? INCOME : CORAL, fontVariantNumeric: "tabular-nums" }}>{nwDelta > 0 ? "▲ +" : "▼ "}{M(Math.abs(nwDelta))} {t("m/m")}</span>}
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
              <div style={{ height: 8, background: C.bg, borderRadius: 4, overflow: "hidden" }}>
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
        {([[t("Income"), totIncome, INCOME], [t("Expense"), totExpense, CORAL], [t("Net"), totNet, totNet >= 0 ? INCOME : CORAL]] as const).map(([label, val, col]) => (
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
              <div style={{ position: "absolute", top: 2, height: 8, borderRadius: 3, background: p.net >= 0 ? INCOME : CORAL, left: p.net >= 0 ? "50%" : `${50 - w}%`, width: `${w}%` }} />
            </div>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: p.net >= 0 ? INCOME : CORAL, width: 80, textAlign: "right", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{p.net >= 0 ? "+" : "−"}{M(Math.abs(p.net))}</span>
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
          <button key={r.n} onClick={() => setRange(r.n)} style={{ flex: 1, padding: "6px 0", borderRadius: 7, border: "none", fontSize: 11.5, fontWeight: 600, cursor: "pointer", background: range === r.n ? TEAL : "transparent", color: range === r.n ? "#fff" : C.soft }}>{t(r.label)}</button>
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
          <div style={{ height: 8, background: C.bg, borderRadius: 4, overflow: "hidden" }}>
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
const AMBER = "#d97706";
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
        const barColor = pct > 100 ? "var(--danger)" : pct >= 80 ? AMBER : e.color;
        return (
          <button key={e.id} onClick={() => onOpenEnvelope(e.id, state.month)} style={{ display: "block", width: "100%", background: "none", border: "none", padding: "0 0 12px", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 3 }}>
              <span style={{ fontSize: 13, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
              <span style={{ textAlign: "right", flexShrink: 0 }}>
                <span style={{ display: "block", fontSize: 12.5, fontWeight: 700, color: pct > 100 ? "var(--danger)" : pct >= 80 ? AMBER : C.text, fontVariantNumeric: "tabular-nums" }}>{Math.round(pct)}%</span>
                <span style={{ display: "block", fontSize: 10.5, color: left < 0 ? CORAL : C.soft, fontVariantNumeric: "tabular-nums" }}>
                  {left < 0 ? t("over by {amount}", { amount: M(-left) }) : t("{amount} left", { amount: M(left) })}
                </span>
              </span>
            </div>
            <div style={{ height: 8, background: C.bg, borderRadius: 4, overflow: "hidden" }}>
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
const SAGE = "#4fa583";
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
        <div style={{ fontSize: 12.5, fontWeight: 600, color: missSum === 0 ? SAGE : C.soft, marginBottom: 10, fontVariantNumeric: "tabular-nums" }}>
          {missSum === 0 ? t("All goals funded ✓") : t("Funded {pct}% · {amount} to go", { pct: pctTotal, amount: M(missSum) })}
        </div>
      )}
      {rows.map(({ e, gp }) => {
        const barColor = gp.funded ? SAGE : "var(--accent)";
        return (
          <button key={e.id} onClick={() => onOpenEnvelope(e.id, state.month)} style={{ display: "block", width: "100%", background: "none", border: "none", padding: "0 0 12px", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 3 }}>
              <span style={{ fontSize: 13, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
              <span style={{ textAlign: "right", flexShrink: 0 }}>
                <span style={{ display: "block", fontSize: 12.5, fontWeight: 700, color: gp.funded ? SAGE : C.text, fontVariantNumeric: "tabular-nums" }}>{Math.round(gp.pct)}%</span>
                <span style={{ display: "block", fontSize: 10.5, color: gp.funded ? SAGE : C.soft, fontVariantNumeric: "tabular-nums" }}>
                  {gp.funded ? t("funded ✓") : t("{amount} to go", { amount: M(gp.missing) })}
                </span>
              </span>
            </div>
            <div style={{ height: 8, background: C.bg, borderRadius: 4, overflow: "hidden" }}>
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
