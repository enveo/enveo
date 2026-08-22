import { savingsRate } from "@enveo/shared";
import { useBand } from "../../components/kit";
import { ReportShell } from "../../components/reportKit";
import { useTheme } from "../../lib/contexts";
import { monthLabel } from "../../lib/dates";
import { useT } from "../../lib/i18n";
import { tint } from "../../lib/theme";
import { useElementWidth } from "../../lib/useElementWidth";
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
 * `bandChart` (`CashflowBandChart`, below) repeats the monthly shape as diverging columns on the
 * band itself. Body: the Income/Expense/Net stat trio, then the existing diverging monthly bars —
 * each row now labeled with a 2-digit year suffix ("sie ’25") since a 12-mo window almost always
 * crosses a year boundary; applied to EVERY row for consistency, and the label column widened
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
 * `preserveAspectRatio="none"` — that would non-uniformly stretch the rounded caps into ellipses.
 * A hardcoded `W` only holds at the one viewport it was measured on, though — it re-letterboxes
 * at any other width — so `W` is now measured from the band's own container instead. */
function CashflowBandChart({ cashflow }: { cashflow: { month: string; income: number; expense: number; net: number }[] }) {
  const C = useTheme();
  const { hc } = useBand();
  const gap = 6,
    H = 60,
    base = H / 2,
    maxH = 24;
  const [boxRef, W] = useElementWidth<HTMLDivElement>(358);
  const n = cashflow.length;
  // Guards `barW`'s division by `n`: an empty series would otherwise draw Infinity/NaN geometry.
  // Pre-existing (not introduced by this PR) — the one call site already filters on
  // `cashflow.length > 0`, but the component shouldn't rely solely on that to stay sane.
  if (n === 0) return null;
  const barW = (W - Math.max(0, n - 1) * gap) / n;
  const maxAbs = Math.max(...cashflow.map((p) => Math.abs(p.net)), 1);
  const posColor = hc(C.headerPos, C.pos);
  const negColor = hc(C.headerNeg, C.neg);
  const baseColor = hc(tint(C.headerInk, 0.25), C.line);
  return (
    <div ref={boxRef} style={{ marginTop: 10 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} aria-hidden="true" style={{ display: "block" }}>
        <line x1={0} y1={base} x2={W} y2={base} style={{ stroke: baseColor }} strokeWidth={1} />
        {cashflow.map((p, i) => {
          const x = i * (barW + gap);
          if (p.net === 0) return <rect key={p.month} x={x} y={base - 0.5} width={barW} height={1} style={{ fill: baseColor }} />;
          const h = Math.max(3, Math.round((Math.abs(p.net) / maxAbs) * maxH));
          const y = p.net > 0 ? base - h : base;
          return <rect key={p.month} x={x} y={y} width={barW} height={h} rx={2} style={{ fill: p.net > 0 ? posColor : negColor }} />;
        })}
      </svg>
    </div>
  );
}
