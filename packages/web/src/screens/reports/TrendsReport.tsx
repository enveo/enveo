import type { EnvelopeTrend } from "@enveo/shared";
import { DeltaTag, ReportShell, TrendSpark } from "../../components/reportKit";
import { useTheme } from "../../lib/contexts";
import { useT } from "../../lib/i18n";
import { trendColor } from "./charts";
import { type Mask, TITLES } from "./types";

/**
 * "Envelope trends" tab (Task 12, no dedicated mockup frame — follows the Gabinet grammar of
 * Tasks 9–11 and the hub's TrendsMini, Task 8). Band hero counts envelopes whose `deltaPct` moved
 * more than ±10% over the 6-month window (rising/falling; a null `deltaPct` — no baseline to
 * compare against — counts as neither); eyebrow is the fixed "Last 6 months" window label (no
 * range control, unlike Spending — the trend series is always the hub's 6-month window). No
 * `bandChart`: the per-row TrendSpark already carries the shape, a band-level chart would just
 * repeat it. Body: ALL trends, no fold — `computeEnvelopeTrends` already sorts by |last−baseline|
 * desc and drops all-zero envelopes, so there is no long tail to hide behind a "+ N more" toggle
 * the way Spending/Budgets do. Each row is a single-line statement (color dot + name, a fixed-size
 * TrendSpark colored via `trendColor`, and a right column mirroring GoalsReport's amount/sub-line
 * shape) that navigates to the envelope like a BudgetsReport row. When `deltaPct` is null there is
 * nothing to compare the current amount against, so the whole sub-line (DeltaTag + "vs median") is
 * omitted rather than left as a dangling "vs median" with no percentage next to it.
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
            <span
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                flex: 1,
                fontSize: 13.5,
                color: C.text,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              <span aria-hidden style={{ width: 8, height: 8, borderRadius: 3, background: tr.color, flexShrink: 0 }} />
              {tr.name}
            </span>
            <span style={{ flexShrink: 0 }}>
              <TrendSpark series={tr.series} color={color} w={96} h={24} />
            </span>
            <span style={{ textAlign: "right", flexShrink: 0 }}>
              <span style={{ display: "block", fontSize: 13, fontWeight: 650, color: C.text, fontVariantNumeric: "tabular-nums" }}>{M(tr.last)}</span>
              {tr.deltaPct !== null && (
                <span style={{ display: "block", fontSize: 10.5, color: C.soft }}>
                  <DeltaTag pct={tr.deltaPct} /> {t("vs median")}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </ReportShell>
  );
}
