import { type DaySpending, savingsRate, type Transaction } from "@enveo/shared";
import { useBand } from "../../components/kit";
import { CalendarHeatmap, DeltaTag, dimNullLabel, ReportShell, SegBar } from "../../components/reportKit";
import type { StateResponse } from "../../lib/api";
import { useTheme } from "../../lib/contexts";
import { monthLabel, shiftDay, shortDate, weekdayShortDate } from "../../lib/dates";
import { useT } from "../../lib/i18n";
import { daysInMonth } from "../../lib/reportSummary";
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
 *
 * The calendar's day panel (an accordion `CalendarHeatmap` renders under the selected week row,
 * this component's own body): day-level `‹ ›` nav clamped to the real month length (not a bare
 * `[1,31]`), the day's total against a comparison to the SAME daily average the caption above
 * already shows (one real value, never a second differently-divided one), a full `SegBar`
 * envelope breakdown (the bar and its own caption must describe the same detail — showing only
 * the dominant envelope while naming three in the caption would disagree with itself), up to four
 * sign-correct transaction rows (`isRefund` reads "+", never a flat "−" that would misreport a
 * refund as a purchase), and an "Open in Transactions ›" link. That link opens the Transactions
 * list on the month already shared between every report screen (`month`/`onOpenTxns` — both
 * driven by the same `App.tsx` state Transactions itself reads) rather than a specific
 * transaction: there is no date-range filter in that list today, so pointing this link at one
 * transaction's edit screen would silently do something other than what it says. Selection
 * itself (`monthDay`/`dayDetail`) lives in `App.tsx`, not local state here — editing a row
 * unmounts this whole screen (`screen: "addExpense"`), which would otherwise lose it.
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
  const { t, tp, lang } = useT();
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

  // ── Day panel: navigation clamped to the real month length (a bare [1,31] would try to open a
  // day 30/31-day months don't have — `daysInMonth` handles Feb correctly, leap or not). Selecting
  // the already-open day closes it (toggle), matching `CalendarHeatmap`'s own cell-click idiom.
  const lastDay = `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
  const firstDay = `${month}-01`;
  const clampToMonth = (d: string) => (d < firstDay ? firstDay : d > lastDay ? lastDay : d);
  const selectDay = (date: string) => onSelectDay(monthDay === date ? null : date);
  const stepDay = (delta: number) => monthDay && onSelectDay(clampToMonth(shiftDay(monthDay, delta)));

  // Comparison to the SAME daily average the month caption below already shows — never a second,
  // differently-divided one (a demo-only coincidence in the mockup; here it must be one real
  // value so the two captions on screen never imply different averages).
  const dayDeltaPct = dayDetail && avg > 0 ? (dayDetail.total - avg) / avg : null;

  // Full envelope breakdown (not just the dominant one — the bar and its caption must describe
  // the same detail). `byEnvelope` is already sorted descending by amount (computeDaySpending's
  // own contract) — never re-sorted here.
  const envColor = new Map(state.envelopes.map((e) => [e.id, e.color]));
  const splitSegments = (dayDetail?.byEnvelope ?? []).map((r) => ({
    weight: Math.max(0, r.amount),
    color: r.envelopeId ? (envColor.get(r.envelopeId) ?? C.mute) : C.mute,
  }));
  const splitCaption = (dayDetail?.byEnvelope ?? [])
    .slice(0, 3)
    .map((r) =>
      t("{name} {pct}%", {
        name: dimNullLabel(r.name, "envelope", t),
        pct: dayDetail && dayDetail.total !== 0 ? Math.round((r.amount / dayDetail.total) * 100) : 0,
      }),
    )
    .join(" · ");
  const splitOverflow = (dayDetail?.byEnvelope.length ?? 0) - 3;

  // Sign-correct rows: `amount` is always a positive magnitude (domain invariant) — a refund's
  // real contribution is negative, so it reads "+", never a flat "−" that would misreport it as
  // a purchase. Same for the header total: a refund-heavy day can leave `total` negative (real
  // money back), which must say so honestly rather than collapsing to "$0.00" alongside the
  // actually-zero case.
  const rowSign = (tx: Transaction): { text: string; color: string } =>
    tx.isRefund ? { text: `+${M(tx.amount)}`, color: C.pos } : { text: `−${M(tx.amount)}`, color: C.text };
  const totalSign =
    dayDetail && dayDetail.total > 0
      ? { text: `−${M(dayDetail.total)}`, color: C.neg }
      : dayDetail && dayDetail.total < 0
        ? { text: `+${M(-dayDetail.total)}`, color: C.pos }
        : { text: M(0), color: C.mute };

  const envById = new Map(state.envelopes.map((e) => [e.id, e]));
  const txnLabel = (tx: Transaction): string =>
    tx.name || tx.note || (tx.envelopeId ? envById.get(tx.envelopeId)?.name : undefined) || (tx.items.length ? t("Split transaction") : t("Transaction"));

  const navBtnStyle = {
    flexShrink: 0,
    width: 30,
    height: 30,
    border: "none",
    background: "transparent",
    color: C.soft,
    fontSize: 17,
    lineHeight: 1,
    cursor: "pointer",
    padding: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  } as const;

  const panel =
    monthDay && dayDetail ? (
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <button aria-label={t("Previous day")} onClick={() => stepDay(-1)} style={navBtnStyle}>
              ‹
            </button>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: C.text }}>{weekdayShortDate(monthDay, lang)}</span>
            <button aria-label={t("Next day")} onClick={() => stepDay(1)} style={navBtnStyle}>
              ›
            </button>
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <span style={{ fontSize: 12.5, fontWeight: 750, color: totalSign.color, fontVariantNumeric: "tabular-nums" }}>{totalSign.text}</span>
            <button aria-label={t("Close")} onClick={() => onSelectDay(null)} style={{ ...navBtnStyle, fontSize: 12 }}>
              ✕
            </button>
          </span>
        </div>

        {dayDetail.count > 0 ? (
          <div style={{ fontSize: 9.5, color: C.mute }}>{tp("{n} transaction | {n} transactions", dayDetail.count)}</div>
        ) : (
          <div style={{ fontSize: 9.5, color: C.mute }}>{t("No spending this day.")}</div>
        )}

        {avg > 0 && (
          <div style={{ fontSize: 9.5, color: C.mute }}>
            <DeltaTag pct={dayDeltaPct} /> {t("vs the {avg} daily average", { avg: M(avg) })}
          </div>
        )}

        {dayDetail.byEnvelope.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <SegBar segments={splitSegments} height={5} />
            <div style={{ fontSize: 9.5, color: C.mute }}>
              {splitCaption}
              {splitOverflow > 0 && ` · ${tp("+ {n} more | + {n} more", splitOverflow)}`}
            </div>
          </div>
        )}

        {dayDetail.txns.length > 0 && (
          <>
            {dayDetail.txns.slice(0, 4).map((tx) => {
              const s = rowSign(tx);
              return (
                <div
                  key={tx.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onEditTxn(tx)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onEditTxn(tx);
                    }
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    padding: "6px 2px",
                    minHeight: 30,
                    fontSize: 11.5,
                    cursor: "pointer",
                  }}
                >
                  <span style={{ color: C.soft, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{txnLabel(tx)}</span>
                  <span style={{ fontWeight: 650, color: s.color, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{s.text}</span>
                </div>
              );
            })}
            {dayDetail.txns.length > 4 && <div style={{ fontSize: 9.5, color: C.mute }}>{tp("+ {n} more | + {n} more", dayDetail.txns.length - 4)}</div>}
            <button
              onClick={() => onOpenTxns({})}
              /* minHeight 30 — the padding-less text button measured ~13px tall, under the 30px
                 tap floor every other affordance on this screen clears. Kept left-aligned text,
                 the box grows invisibly. */
              style={{
                alignSelf: "flex-start",
                display: "flex",
                alignItems: "center",
                minHeight: 30,
                background: "none",
                border: "none",
                padding: 0,
                fontSize: 10.5,
                fontWeight: 650,
                color: "var(--accent)",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {t("Open in Transactions ›")}
            </button>
          </>
        )}
      </div>
    ) : undefined;

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
      <CalendarHeatmap days={days} lang={lang} mask={M} selected={monthDay} onSelectDay={selectDay} panel={panel} />
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
              <span style={{ color: C.soft, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dimNullLabel(p.name, "place", t)}</span>
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
