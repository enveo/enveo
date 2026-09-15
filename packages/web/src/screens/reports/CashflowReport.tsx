import { type CashflowPoint, savingsRate } from "@enveo/shared";
import { useLayoutEffect, useRef, useState } from "react";
import { ReportShell, useReportBand } from "../../components/reportKit";
import { useTheme } from "../../lib/contexts";
import { monthLabel, monthShortLabel } from "../../lib/dates";
import { useT } from "../../lib/i18n";
import type { Theme } from "../../lib/theme";
import { useElementWidth } from "../../lib/useElementWidth";
import { type Mask, TITLES } from "./types";

const headCellStyle = (C: Theme): React.CSSProperties => ({
  padding: "9px 0 7px",
  borderBottom: `1px solid ${C.line}`,
  fontSize: 9.5,
  fontWeight: 750,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: C.mute,
});

const bodyCellStyle = (C: Theme): React.CSSProperties => ({
  padding: "8px 0",
  borderBottom: `1px solid ${C.line}`,
  fontSize: 12.5,
  fontVariantNumeric: "tabular-nums",
  verticalAlign: "baseline",
});

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
  const { hc } = useReportBand();
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

function CashflowColumns({ cashflow, M }: { cashflow: CashflowPoint[]; M: Mask }) {
  const C = useTheme();
  const { t, lang } = useT();
  const GAP = 3;
  const [rowRef, rowW] = useElementWidth<HTMLDivElement>(0);
  const labelRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [step, setStep] = useState(1);
  const n = cashflow.length;

  useLayoutEffect(() => {
    if (n === 0) return;
    const colW = (rowW - Math.max(0, n - 1) * GAP) / n;
    let widest = 0;
    for (const el of labelRefs.current) {
      if (!el) continue;
      const range = document.createRange();
      range.selectNodeContents(el);
      const w = range.getBoundingClientRect().width;
      if (w > widest) widest = w;
    }
    const next = labelStep(widest, colW);
    setStep((prev) => (prev === next ? prev : next));
  });

  const maxAbs = Math.max(...cashflow.map((p) => Math.abs(p.net)), 1);
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: "11px 12px" }}>
      {/* aria-hidden on the columns row only, NOT the outer div: the scale caption below is a
       *  sibling inside this same bordered box and is real information that must stay reachable.
       *  The columns themselves carry their income/expense/net breakdown only in a `title`
       *  tooltip, which is unreachable by keyboard or screen reader — the In/Out/Left over table
       *  below now publishes the same per-month figures in accessible DOM, so this row becomes a
       *  purely visual summary of data available elsewhere. */}
      <div ref={rowRef} aria-hidden="true" style={{ display: "flex", alignItems: "center", gap: GAP, height: 110 }}>
        {cashflow.map((p, i) => {
          const h = Math.max(3, Math.round((Math.abs(p.net) / maxAbs) * 52));
          const showLabel = (n - 1 - i) % step === 0;
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
              <div
                ref={(el) => {
                  labelRefs.current[i] = el;
                }}
                style={{ fontSize: 8.5, color: C.mute, textAlign: "center", paddingTop: 3, visibility: showLabel ? "visible" : "hidden" }}
              >
                {monthShortLabel(p.month, lang)}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 10, color: C.mute }}>{t("net per month · scale ±{max}", { max: M(maxAbs) })}</div>
    </div>
  );
}

/**
 * How many columns to skip between visible month labels, so the widest rendered label (measured
 * in the viewer's real font) never sits closer than `+2`px to its neighbour's shown label.
 *
 * Pure and total: called from a layout effect with real (possibly not-yet-settled) measurements,
 * so it must never divide by zero or return a 0 step (which would hide every label, including the
 * newest month `CashflowColumns` always wants labelled). An unmeasured or collapsed `colW`, or a
 * not-yet-measured `widest`, falls back to showing every label (`1`) rather than guessing — the
 * layout effect re-measures and corrects before paint once real numbers are available.
 */
export function labelStep(widest: number, colW: number): number {
  if (!Number.isFinite(colW) || colW <= 0) return 1;
  if (!Number.isFinite(widest) || widest <= 0) return 1;
  return Math.max(1, Math.ceil((widest + 2) / colW));
}
