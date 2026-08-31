import type { EnvelopeTrend } from "@enveo/shared";
import { ReportShell, signedDelta, TrendRow } from "../../components/reportKit";
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
 * Each row is `TrendRow` (reportKit) — two lines per side: the left column pairs the envelope name
 * with a `"{now} · median {median}"` sub-line (this month's spend against the same baseline the
 * delta is computed from); the right column makes the signed **delta** (`last − baseline`) the
 * primary figure, with `DeltaTag` + "vs median" as its secondary line. That row used to be inline
 * here; owner round 7 item 29 put the SAME grammar on the wide home board's trends tile, so it
 * moved to reportKit and both hosts now render one component instead of two copies that drift.
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
              amount: signedDelta(M, banner.last - banner.baseline),
            })}
          </span>
        </div>
      )}
      {trends.map((tr, i) => (
        <TrendRow key={tr.id} tr={tr} M={M} last={i === trends.length - 1} onClick={() => onOpenEnvelope(tr.id, month)} />
      ))}
      {trends.length > 0 && <div style={{ fontSize: 10, color: C.mute, paddingTop: 4 }}>{t("The flat line in each spark marks that envelope's median.")}</div>}
    </ReportShell>
  );
}
