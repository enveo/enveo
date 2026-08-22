import type { EnvelopeTrend } from "@enveo/shared";
import { DeltaTag, ReportShell, TrendSpark } from "../../components/reportKit";
import { useTheme } from "../../lib/contexts";
import { useT } from "../../lib/i18n";
import { trendBannerMover } from "../../lib/reportSummary";
import { trendColor } from "./charts";
import { type Mask, TITLES } from "./types";

/**
 * "Envelope trends" tab (Task 12, no dedicated mockup frame — follows the Gabinet grammar of
 * Tasks 9–11 and the hub's TrendsMini, Task 8; biggest-mover banner + two-line row added in the
 * 2026-08-22 redesign). Band hero counts envelopes whose `deltaPct` moved more than ±10% over the
 * 6-month window (rising/falling; a null `deltaPct` — no baseline to compare against — counts as
 * neither); eyebrow is the fixed "Last 6 months" window label (no range control, unlike Spending —
 * the trend series is always the hub's 6-month window). No `bandChart`: the per-row TrendSpark
 * already carries the shape, a band-level chart would just repeat it. Body: ALL trends, no fold —
 * `computeEnvelopeTrends` already sorts by |last−baseline| desc and drops all-zero envelopes, so
 * there is no long tail to hide behind a "+ N more" toggle the way Spending/Budgets do.
 *
 * Above the rows, an optional banner names the single biggest mover of the month
 * (`trendBannerMover` in `lib/reportSummary.ts` — read its docstring for why the gate is on
 * magnitude, not sign, and why it never falls through to a runner-up). The banner's tint is
 * direction-aware: danger when the move is bad (spending up, same `trendColor`/`C.neg` reading
 * every row already uses), neutral `C.chip`/`C.line` otherwise — painting a decrease (good news)
 * in the danger tint would be wrong just because it happens to be the biggest number.
 *
 * Each row is two lines per side: the left column pairs the envelope name with a
 * `"{now} · median {median}"` sub-line (this month's spend against the same baseline the delta
 * is computed from); the right column makes the signed **delta** (`last − baseline`) the primary
 * figure, with the existing `DeltaTag` + "vs median" as its secondary line. `tr.last`/`tr.baseline`
 * are never null, so both lines of every row always render, including a dormant envelope whose
 * median is 0 ("… · median $0.00" is honest information, not an error case). When `deltaPct` is
 * null there is nothing to compare the delta against, so only that second line (DeltaTag + "vs
 * median") is omitted — never the whole row.
 */
export function TrendsReport({
  trends,
  M,
  month,
  onOpenEnvelope,
  onPrev,
  onNext,
  onBack,
}: {
  trends: EnvelopeTrend[];
  M: Mask;
  month: string;
  onOpenEnvelope: (envId: string, month: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const C = useTheme();
  const { t } = useT();
  const rising = trends.filter((tr) => tr.deltaPct !== null && tr.deltaPct > 0.1).length;
  const falling = trends.filter((tr) => tr.deltaPct !== null && tr.deltaPct < -0.1).length;
  const banner = trendBannerMover(trends);
  const bannerColor = banner ? trendColor(banner, C) : C.text;
  const bannerBad = banner ? bannerColor === C.neg : false;
  const signed = (delta: number) => `${delta >= 0 ? "+" : "−"}${M(Math.abs(delta))}`;

  return (
    <ReportShell
      title={t(TITLES.trends)}
      month={month}
      onPrev={onPrev}
      onNext={onNext}
      onBack={onBack}
      eyebrow={t("Last 6 months")}
      hero={t("{n} rising · {m} falling", { n: rising, m: falling })}
    >
      {trends.length === 0 && (
        <div style={{ fontSize: 12.5, color: C.mute, padding: "8px 0" }}>{t("Not enough history yet — trends appear after two months of spending.")}</div>
      )}
      {banner && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            background: bannerBad ? "var(--danger-14)" : C.chip,
            border: `1px solid ${bannerBad ? "var(--danger-40)" : C.line}`,
            borderRadius: 10,
            padding: "8px 11px",
            marginBottom: 4,
          }}
        >
          <span style={{ fontSize: 11.5, color: C.text }}>
            {t("{name} moved the most this month — {amount} vs median", {
              name: banner.name,
              amount: signed(banner.last - banner.baseline),
            })}
          </span>
        </div>
      )}
      {trends.map((tr, i) => {
        const color = trendColor(tr, C);
        return (
          <button
            key={tr.id}
            onClick={() => onOpenEnvelope(tr.id, month)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              width: "100%",
              padding: "10px 0",
              background: "none",
              border: "none",
              borderBottom: i === trends.length - 1 ? "none" : `1px solid ${C.line}`,
              cursor: "pointer",
              textAlign: "left",
              fontFamily: "inherit",
            }}
          >
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: 3, background: tr.color, flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
              <span style={{ fontSize: 13, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tr.name}</span>
              <span
                style={{
                  fontSize: 10.5,
                  color: C.mute,
                  fontVariantNumeric: "tabular-nums",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {t("{now} · median {median}", { now: M(tr.last), median: M(tr.baseline) })}
              </span>
            </span>
            <span style={{ flexShrink: 0 }}>
              <TrendSpark series={tr.series} color={color} median={tr.baseline} medianColor={C.line} dot w={72} h={26} />
            </span>
            <span style={{ textAlign: "right", flexShrink: 0 }}>
              <span style={{ display: "block", fontSize: 13, fontWeight: 700, color, fontVariantNumeric: "tabular-nums" }}>
                {signed(tr.last - tr.baseline)}
              </span>
              {tr.deltaPct !== null && (
                <span style={{ display: "block", fontSize: 10.5, color: C.soft }}>
                  <DeltaTag pct={tr.deltaPct} /> {t("vs median")}
                </span>
              )}
            </span>
          </button>
        );
      })}
      {trends.length > 0 && <div style={{ fontSize: 10, color: C.mute, paddingTop: 4 }}>{t("The flat line in each spark marks that envelope's median.")}</div>}
    </ReportShell>
  );
}
