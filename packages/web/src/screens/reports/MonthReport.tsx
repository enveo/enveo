import { type DaySpending, savingsRate, type Transaction } from "@enveo/shared";
import { useBand } from "../../components/kit";
import { CalendarHeatmap, ReportShell } from "../../components/reportKit";
import type { StateResponse } from "../../lib/api";
import { useTheme } from "../../lib/contexts";
import { monthLabel, shortDate } from "../../lib/dates";
import { useT } from "../../lib/i18n";
import { type Mask, TITLES } from "./types";

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
export function MonthReport({
  state,
  cashflow,
  days,
  places,
  largest,
  monthDay,
  onSelectDay,
  dayDetail,
  onEditTxn,
  onOpenTxns,
  M,
  month,
  onPrev,
  onNext,
  onBack,
}: {
  state: StateResponse;
  cashflow: { month: string; income: number; expense: number; net: number }[];
  days: { date: string; total: number }[];
  places: { key: string; name: string; count: number; total: number }[];
  largest: { id: string; label: string; context: string | null; date: string; amount: number }[];
  // Day panel (accordion under the selected week row) — selection state lives in App.tsx
  // (mirrors `reportsView`) because opening a transaction to edit unmounts this whole screen.
  // Unused in THIS task: the panel body (Task 3 of this slice) reads them.
  monthDay: string | null;
  onSelectDay: (date: string | null) => void;
  dayDetail: DaySpending | null;
  onEditTxn: (t: Transaction) => void;
  onOpenTxns: (f: { envId?: string; envIds?: ReadonlySet<string>; catId?: string; placeId?: string }) => void;
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
