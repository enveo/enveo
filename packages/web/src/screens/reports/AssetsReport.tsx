import { useBand } from "../../components/kit";
import { Bar, ReportShell } from "../../components/reportKit";
import type { StateResponse } from "../../lib/api";
import { useTheme } from "../../lib/contexts";
import { monthLabel } from "../../lib/dates";
import { useT } from "../../lib/i18n";
import { TEAL } from "../../lib/theme";
import { type Mask, TITLES } from "./types";

/**
 * "Assets" tab (Gabinet grammar, no dedicated mockup frame — follows A2/A3): band hero = net
 * worth + ▲/▼ m/m delta, `NetWorthChart` itself painted IN the band (`onBand`) so on Duet it
 * reads as a cream line on navy rather than the invisible navy-on-navy TEAL would give. Body:
 * the "Wealth" section (envelopes flagged `isSavings`) unchanged in content, bars via `Bar`.
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
      bandChart={netWorth.length > 0 ? <NetWorthChart points={netWorth} mask={M} onBand={band} /> : undefined}
    >
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

/** Net-worth line chart with the axis clipped to the min–max range. `onBand` (Assets' hero chart,
 *  painted directly on the Duet navy band) swaps the accent stroke/points for `C.headerInk` (TEAL
 *  — i.e. `var(--accent)` — IS the band color there, so it would be invisible navy-on-navy) and the
 *  caption color for `C.headerMute`; plain themes (onBand omitted/false) keep today's accent look. */
function NetWorthChart({ points, mask, onBand }: { points: { month: string; total: number }[]; mask: Mask; onBand?: boolean }) {
  const C = useTheme();
  const { t, lang } = useT();
  const n = points.length;
  if (n === 0) return null;
  const totals = points.map((p) => p.total);
  const min = Math.min(...totals);
  const max = Math.max(...totals);
  const range = max - min || 1;
  const flat = max === min;
  const W = 340,
    H = 118,
    padX = 6,
    padY = 12;
  const innerW = W - 2 * padX,
    innerH = H - 2 * padY;
  const x = (i: number) => padX + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => (flat ? padY + innerH / 2 : padY + (1 - (v - min) / range) * innerH);
  const pts = points.map((p, i) => [x(i), y(p.total)] as const);
  const line = pts.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px.toFixed(1)} ${py.toFixed(1)}`).join(" ");
  const area = `${line} L${x(n - 1).toFixed(1)} ${(H - padY).toFixed(1)} L${x(0).toFixed(1)} ${(H - padY).toFixed(1)} Z`;
  const stroke = onBand ? C.headerInk : TEAL;
  const hole = onBand ? C.headerBg : C.bg;
  const caption = onBand ? C.headerMute : C.mute;
  return (
    <div style={{ marginBottom: 6 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", height: "auto" }} role="img" aria-label={t("Net worth over time")}>
        {/* fill/stroke via style — var(--accent) does not work in SVG presentation attributes */}
        <path d={area} style={{ fill: stroke }} opacity={0.12} />
        <path d={line} fill="none" style={{ stroke }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {pts.map(([px, py], i) => (
          <circle
            key={i}
            cx={px}
            cy={py}
            r={i === n - 1 ? 4 : 2.4}
            style={{ fill: i === n - 1 ? stroke : hole, stroke }}
            strokeWidth={1.6}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 4, fontSize: 10.5, color: caption }}>
        <span>{monthLabel(points[0]!.month, lang).split(" ")[0]}</span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>{t("range {min}–{max}", { min: mask(min), max: mask(max) })}</span>
        <span>{monthLabel(points[n - 1]!.month, lang).split(" ")[0]}</span>
      </div>
    </div>
  );
}
