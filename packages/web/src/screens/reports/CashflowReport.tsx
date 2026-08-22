import { type CashflowPoint, savingsRate } from "@enveo/shared";
import { useBand } from "../../components/kit";
import { ReportShell } from "../../components/reportKit";
import { useTheme } from "../../lib/contexts";
import { monthLabel, monthShortLabel } from "../../lib/dates";
import { useT } from "../../lib/i18n";
import { type Mask, TITLES } from "./types";

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
 * labelled diverging column chart, then the existing per-row bars — each row now labeled with a
 * 2-digit year suffix ("sie ’25") since a 12-mo window almost always crosses a year boundary;
 * applied to EVERY row for consistency, and the label column widened
 * 48→82px to fit it — measured live (agent-browser, PL locale): `monthLabel` uses the FULL
 * Intl "long" month name (Polish has no short form here), and "Październik’25" alone needs 79px
 * (`scrollWidth`), so 64px — the initially-planned width — still clipped into the bar column.
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
      <div style={{ display: "flex", alignItems: "center", gap: 3, height: 110 }}>
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
