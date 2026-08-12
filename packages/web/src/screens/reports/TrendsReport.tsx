import type { EnvelopeTrend } from "@enveo/shared";
import { DeltaTag, ReportShell, TrendSpark } from "../../components/reportKit";
import { useTheme } from "../../lib/contexts";
import { useT } from "../../lib/i18n";
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
