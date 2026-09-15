import type { EnvelopeTrend } from "@enveo/shared";
import { ReportShell, signedDelta, TrendRow } from "../../components/reportKit";
import { useTheme } from "../../lib/contexts";
import { useT } from "../../lib/i18n";
import { trendBannerMover } from "../../lib/reportSummary";
import { trendColor } from "./charts";
import { type Mask, TITLES } from "./types";

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
