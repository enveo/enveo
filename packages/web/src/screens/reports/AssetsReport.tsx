import { useBand } from "../../components/kit";
import { Bar, NetWorthChart, ReportShell } from "../../components/reportKit";
import type { StateResponse } from "../../lib/api";
import { useTheme } from "../../lib/contexts";
import { useT } from "../../lib/i18n";
import { TEAL } from "../../lib/theme";
import { type Mask, TITLES } from "./types";

/**
 * "Assets" tab (Gabinet grammar, no dedicated mockup frame — follows A2/A3): band hero = net
 * worth + ▲/▼ m/m delta, the shared `NetWorthChart` (`components/reportKit.tsx`) itself painted
 * IN the band (`onBand`) so on Duet it reads as a cream line on navy rather than the invisible
 * navy-on-navy TEAL would give. Body: the min–max range caption (moved out of the chart itself,
 * which no longer renders it — see below), then the "Wealth" section (envelopes flagged
 * `isSavings`) unchanged in content, bars via `Bar`.
 */
export function AssetsReport({
  netWorth,
  state,
  M,
  month,
  onPrev,
  onNext,
  onBack,
}: {
  netWorth: { month: string; total: number }[];
  state: StateResponse;
  M: Mask;
  month: string;
  onPrev: () => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const C = useTheme();
  const { t } = useT();
  const { band } = useBand();
  const nwLast = netWorth.at(-1)?.total ?? 0;
  const nwDelta = nwLast - (netWorth.at(-2)?.total ?? nwLast);
  const savings = state.envelopes.filter((e) => !e.archived && e.isSavings);
  const total = savings.reduce((s, e) => s + e.available, 0);
  const pct = nwLast !== 0 ? Math.round((total / nwLast) * 100) : 0;
  const max = Math.max(...savings.map((e) => Math.abs(e.available)), 1);
  const nwTotals = netWorth.map((p) => p.total);
  return (
    <ReportShell
      title={t(TITLES.assets)}
      month={month}
      onPrev={onPrev}
      onNext={onNext}
      onBack={onBack}
      eyebrow={t("Net worth")}
      hero={M(nwLast)}
      sub={
        nwDelta !== 0 ? (
          <>
            {nwDelta > 0 ? "▲ +" : "▼ "}
            {M(Math.abs(nwDelta))} {t("m/m")}
          </>
        ) : undefined
      }
      bandChart={netWorth.length > 1 ? <NetWorthChart points={netWorth} height={118} onBand={band} /> : undefined}
    >
      {netWorth.length > 1 && (
        <div style={{ fontSize: 10.5, color: C.mute, textAlign: "center", marginBottom: 12, fontVariantNumeric: "tabular-nums" }}>
          {t("range {min}–{max}", { min: M(Math.min(...nwTotals)), max: M(Math.max(...nwTotals)) })}
        </div>
      )}
      <div style={{ fontSize: 15, fontWeight: 700, color: C.text, margin: "20px 0 4px" }}>{t("Wealth")}</div>
      {savings.length === 0 ? (
        <div style={{ fontSize: 12.5, color: C.mute, padding: "4px 0", lineHeight: 1.6 }}>
          {t(
            "No envelopes are marked as wealth envelopes. Open an envelope → Edit and turn on “Wealth envelope” (e.g. Bonds, Retirement, Savings), and we will count them here.",
          )}
        </div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
            <span style={{ fontSize: 20, fontWeight: 700, color: C.text, fontVariantNumeric: "tabular-nums" }}>{M(total)}</span>
            <span style={{ fontSize: 12.5, color: C.soft }}>{t("{pct}% of net worth", { pct })}</span>
          </div>
          {savings.map((e) => (
            <div key={e.id} style={{ marginBottom: 9 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                <span style={{ fontSize: 13, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: C.text, fontVariantNumeric: "tabular-nums", flexShrink: 0, marginLeft: 8 }}>
                  {M(e.available)}
                </span>
              </div>
              <Bar pct={(Math.max(0, e.available) / max) * 100} color={TEAL} />
            </div>
          ))}
        </>
      )}
    </ReportShell>
  );
}
