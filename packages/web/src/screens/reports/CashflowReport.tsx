import { type CashflowPoint, savingsRate } from "@enveo/shared";
import { useBand } from "../../components/kit";
import { ReportShell } from "../../components/reportKit";
import { useTheme } from "../../lib/contexts";
import { monthLabel, monthShortLabel } from "../../lib/dates";
import { useT } from "../../lib/i18n";
import type { Theme } from "../../lib/theme";
import { type Mask, TITLES } from "./types";

/** Header cell base style for the In/Out/Left over table (per-column `textAlign`/`paddingLeft`
 *  layered on by the caller). */
const headCellStyle = (C: Theme): React.CSSProperties => ({
  padding: "9px 0 7px",
  borderBottom: `1px solid ${C.line}`,
  fontSize: 9.5,
  fontWeight: 750,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: C.mute,
});

/** Body cell base style for the same table (per-column `textAlign`/`paddingLeft`/color/weight
 *  layered on by the caller). */
const bodyCellStyle = (C: Theme): React.CSSProperties => ({
  padding: "8px 0",
  borderBottom: `1px solid ${C.line}`,
  fontSize: 12.5,
  fontVariantNumeric: "tabular-nums",
  verticalAlign: "baseline",
});

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
 * No `bandChart`: the body chart (`CashflowColumns`, below) now carries the monthly shape, so a
 * band-level chart would just repeat it — same reasoning `TrendsReport.tsx:14` gives for having
 * none. The band keeps eyebrow/hero/sub only. Body: the Income/Expense/Net stat trio, then the
 * labelled diverging column chart (now `aria-hidden` — its per-column tooltip is unreachable by
 * keyboard/screen reader), then the In/Out/Left over table (newest month first) that is the
 * actual accessible source of the monthly split, then the current month's (differently-scoped,
 * explicitly labelled) savings rate.
 */
export function CashflowReport({
  cashflow,
  M,
  month,
  onPrev,
  onNext,
  onBack,
}: {
  cashflow: CashflowPoint[];
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
  // 12-mo AGGREGATE rate — same window as the hero, so hero/sub never disagree in sign.
  const aggRate = totIncome > 0 ? totNet / totIncome : null;
  const aggPct = aggRate !== null ? Math.round(aggRate * 100) : null;
  const srMedian = savingsRate(cashflow).median;
  const srNormPct = srMedian !== null ? Math.round(srMedian * 100) : null;
  const currentPct = (() => {
    const cur = savingsRate(cashflow).current;
    return cur !== null ? Math.round(cur * 100) : null;
  })();
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
      {cashflow.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <CashflowColumns cashflow={cashflow} M={M} />
        </div>
      )}
      {/* Per-month In/Out/Left over table — a real <table>, not a grid of divs: with
       *  `CashflowColumns` now `aria-hidden` (its per-column tooltip is unreachable by keyboard
       *  or screen reader), this table is the only accessible source of the monthly income/expense
       *  split. Plain grid `<div>`s carry no row/column semantics, so a screen reader would read
       *  twelve rows of bare numbers with no header association; `<th scope="col">` gives every
       *  amount cell its column name for free. `table-layout: fixed` + an explicit-width first
       *  `<col>` (44px) with three unset ones reproduces the design's "44px 1fr 1fr 1fr" grid
       *  columns (unset table columns split remaining space evenly per CSS2.1 17.5.2.1). 44px was
       *  measured against `monthShortLabel`'s longest form across all ten shipped locales — French
       *  "mars"/"janv." (12.5px, weight 650) render at ~35/33.5px, comfortably inside 44px with the
       *  8px column gap as extra margin. */}
      <div style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: "2px 12px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: 44 }} />
            <col />
            <col />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th style={{ ...headCellStyle(C), textAlign: "left" }} scope="col" />
              <th style={{ ...headCellStyle(C), textAlign: "right", paddingLeft: 8 }} scope="col">
                {t("In")}
              </th>
              <th style={{ ...headCellStyle(C), textAlign: "right", paddingLeft: 8 }} scope="col">
                {t("Out")}
              </th>
              <th style={{ ...headCellStyle(C), textAlign: "right", paddingLeft: 8 }} scope="col">
                {t("Left over")}
              </th>
            </tr>
          </thead>
          <tbody>
            {[...cashflow].reverse().map((p) => (
              <tr key={p.month}>
                <td style={{ ...bodyCellStyle(C), fontWeight: 650, color: C.text }}>{monthShortLabel(p.month, lang)}</td>
                <td style={{ ...bodyCellStyle(C), textAlign: "right", paddingLeft: 8, color: C.soft }}>{M(p.income)}</td>
                <td style={{ ...bodyCellStyle(C), textAlign: "right", paddingLeft: 8, color: C.soft }}>{M(p.expense)}</td>
                <td
                  style={{
                    ...bodyCellStyle(C),
                    textAlign: "right",
                    paddingLeft: 8,
                    fontWeight: 700,
                    color: p.net >= 0 ? C.pos : C.neg,
                  }}
                >
                  {p.net >= 0 ? "+" : "−"}
                  {M(Math.abs(p.net))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <span style={{ display: "block", fontSize: 10, color: C.mute, padding: "7px 0 8px" }}>
          {t("Left over = income minus spending that month. Last 12 months, newest first.")}
        </span>
      </div>
      {currentPct !== null && <div style={{ fontSize: 12.5, color: C.soft, marginTop: 10 }}>{t("Savings rate this month: {pct}%", { pct: currentPct })}</div>}
    </ReportShell>
  );
}

/** Cashflow body chart (Task 3c-2): a labelled diverging-column chart replacing the old band
 *  chart, so the monthly shape now lives IN the body instead of repeated on the band (see the
 *  module docstring). Twelve `flex: 1` columns split into an up half and a down half around a
 *  shared 1px baseline, so a positive net grows up and a negative one grows down — same up/down
 *  idiom as the hub's `CashflowMini`, but a 110px labelled chart rather than a 34px glanceable
 *  card, so the two are deliberately separate components rather than shared code.
 *
 * A net-ZERO month renders NO bar (the `p.net > 0`/`p.net < 0` guards below) so the baseline shows
 * through, rather than a zero-height colored bar — `CashflowBandChart` (the component this
 * replaces) made the same call for the same reason: a zero-height bar reads as a rendering bug.
 *
 * Column labels use `monthShortLabel`, the locale-correct `Intl` short form, NOT a 3-character
 * slice of `monthLabel` — CLDR's short-month rule is not "first N characters" in every locale, so
 * slicing would be right by accident in some languages and wrong in others. The `title` tooltip
 * carries the full month name (`monthLabel`) plus income, expense and net, all through `M` so
 * discreet mode masks them like every other amount on this screen. */
function CashflowColumns({ cashflow, M }: { cashflow: CashflowPoint[]; M: Mask }) {
  const C = useTheme();
  const { t, lang } = useT();
  const maxAbs = Math.max(...cashflow.map((p) => Math.abs(p.net)), 1);
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: "11px 12px" }}>
      {/* aria-hidden on the columns row only, NOT the outer div: the scale caption below is a
       *  sibling inside this same bordered box and is real information that must stay reachable.
       *  The columns themselves carry their income/expense/net breakdown only in a `title`
       *  tooltip, which is unreachable by keyboard or screen reader — the In/Out/Left over table
       *  below now publishes the same per-month figures in accessible DOM, so this row becomes a
       *  purely visual summary of data available elsewhere. */}
      <div aria-hidden="true" style={{ display: "flex", alignItems: "center", gap: 3, height: 110 }}>
        {cashflow.map((p) => {
          const h = Math.max(3, Math.round((Math.abs(p.net) / maxAbs) * 52));
          return (
            <div
              key={p.month}
              style={{ flex: 1, minWidth: 0, height: "100%", display: "flex", flexDirection: "column", alignItems: "stretch" }}
              title={`${monthLabel(p.month, lang)} · ↑ ${M(p.income)} · ↓ ${M(p.expense)} · ${p.net >= 0 ? "+" : "−"}${M(Math.abs(p.net))}`}
            >
              <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
                {p.net > 0 && <div style={{ height: h, borderRadius: "3px 3px 0 0", background: C.pos, margin: "0 2px" }} />}
              </div>
              <div style={{ height: 1, background: C.line }} />
              <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "flex-start" }}>
                {p.net < 0 && <div style={{ height: h, borderRadius: "0 0 3px 3px", background: C.neg, margin: "0 2px" }} />}
              </div>
              <div style={{ fontSize: 8.5, color: C.mute, textAlign: "center", paddingTop: 3 }}>{monthShortLabel(p.month, lang)}</div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 10, color: C.mute }}>{t("net per month · scale ±{max}", { max: M(maxAbs) })}</div>
    </div>
  );
}
