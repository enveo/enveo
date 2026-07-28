import type { CSSProperties, ReactNode } from "react";
import type { DailySpendingPoint } from "@enveo/shared";
import { useBand } from "./kit";
import { useTheme } from "../lib/contexts";
import { monthLabel } from "../lib/dates";
import { useT } from "../lib/i18n";
import { P, TEAL } from "../lib/theme";

/**
 * Report component kit — the shared visual language for every report subscreen (Tasks 8–12):
 * a `ReportShell` band header (hero number + optional chart on `C.headerBg` when the theme is
 * Duet), plus small primitives (`Bar`, `SegBar`, `DeltaTag`, `CalendarHeatmap`, `TrendSpark`,
 * `Sparkline`) that read tokens off `useTheme()`/`useBand()` instead of hardcoding colors.
 * Every SVG color goes through `style` — `var(--accent)` etc. do not resolve in presentation
 * attributes. Status colors (pos/warn/neg) never carry meaning alone; callers supply the label.
 */

/** Subscreen band: back+title+month-nav row, then eyebrow/hero/sub and an optional chart slot,
 *  all on `C.headerBg` when the theme paints a Duet band (idiom moved verbatim from the inline
 *  block in Reports.tsx). Body `children` render below in a `className="fi"` div — opacity-only
 *  animation, never `fu`/transform (a transformed ancestor breaks `position:fixed` sheets). */
export function ReportShell({ title, month, onPrev, onNext, onBack, eyebrow, hero, sub, bandChart, children }: {
  title: string; month: string; onPrev: () => void; onNext: () => void; onBack: () => void;
  eyebrow: string; hero: ReactNode; sub?: ReactNode; bandChart?: ReactNode; children: ReactNode;
}) {
  const C = useTheme();
  const { band, hc } = useBand();
  const { t, lang } = useT();
  return (
    <>
      <div style={band ? { background: C.headerBg, paddingBottom: 14 } : { paddingBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: `12px ${P}px 10px` }}>
          <button aria-label={t("Back")} onClick={onBack} style={{ flexShrink: 0, width: 30, height: 30, borderRadius: 15, border: "none", background: "transparent", color: hc(C.headerInk, C.text), fontSize: 22, lineHeight: 1, cursor: "pointer", padding: 0, marginLeft: -6, display: "flex", alignItems: "center", justifyContent: "center" }}>‹</button>
          <span style={{ flex: 1, fontSize: 16, fontWeight: 700, color: hc(C.headerInk, C.text), overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
          <span style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
            <button onClick={onPrev} style={{ border: "none", background: "transparent", color: hc(C.headerMute, C.soft), fontSize: 17, lineHeight: 1, cursor: "pointer", padding: "2px 7px" }}>‹</button>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: hc(C.headerInk, C.text), minWidth: 58, textAlign: "center" }}>{monthLabel(month, lang).split(" ")[0]}</span>
            <button onClick={onNext} style={{ border: "none", background: "transparent", color: hc(C.headerMute, C.soft), fontSize: 17, lineHeight: 1, cursor: "pointer", padding: "2px 7px" }}>›</button>
          </span>
        </div>
        <div style={{ padding: `0 ${P}px` }}>
          <div style={{ fontSize: 10.5, fontWeight: 750, letterSpacing: "0.17em", textTransform: "uppercase", color: hc(C.headerMute, C.mute) }}>{eyebrow}</div>
          <div style={{ fontSize: 30, fontWeight: 750, color: hc(C.headerInk, C.text), fontVariantNumeric: "tabular-nums" }}>{hero}</div>
          {sub != null && <div style={{ fontSize: 12, color: hc(C.headerMute, C.soft) }}>{sub}</div>}
          {bandChart}
        </div>
      </div>
      {/* Animation is `fi` ONLY (opacity) — `fu`/transform breaks position:fixed of sheets inside. */}
      <div className="fi" style={{ padding: `0 ${P}px` }}>
        {children}
      </div>
    </>
  );
}

/** Single-value progress bar: track `C.line`, fill clamped 0–100%, fully rounded (radius h/2). */
export function Bar({ pct, color, height = 8 }: { pct: number; color: string; height?: number }) {
  const C = useTheme();
  const clamped = Math.min(100, Math.max(0, pct));
  return (
    <div style={{ height, background: C.line, borderRadius: height / 2, overflow: "hidden" }}>
      <div style={{ height: "100%", width: `${clamped}%`, background: color, borderRadius: height / 2 }} />
    </div>
  );
}

/** Multi-segment stacked bar (spending/budget composition) — flex segments sized by `weight`,
 *  with a 2px surface gap between adjacent color segments so neighbors never bleed together. */
export function SegBar({ segments, height = 8 }: { segments: Array<{ weight: number; color: string }>; height?: number }) {
  const C = useTheme();
  const visible = segments.filter((s) => s.weight > 0);
  return (
    <div style={{ display: "flex", gap: 2, height, borderRadius: height / 2, overflow: "hidden", background: C.line }}>
      {visible.map((s, i) => (
        <span key={i} style={{ flex: s.weight, minWidth: 2, background: s.color }} />
      ))}
    </div>
  );
}

/** Delta arrow + percent — locale-neutral, no surrounding copy ("vs 3 mo" etc. is the caller's
 *  job). `pct` is a fraction; `|pct| < 0.005` renders "→ 0%" in `C.soft`. `downIsGood` (default
 *  true — spending semantics) colors ↓ `C.pos` / ↑ `C.neg`; set false to invert (e.g. income,
 *  net worth, savings rate — up is the good direction there). `pct === null` renders nothing. */
export function DeltaTag({ pct, downIsGood = true }: { pct: number | null; downIsGood?: boolean }) {
  const C = useTheme();
  if (pct === null) return null;
  const abs = Math.abs(pct);
  const n = Math.round(abs * 100);
  if (abs < 0.005) return <span style={{ color: C.soft, fontVariantNumeric: "tabular-nums" }}>{`→ ${n}%`}</span>;
  const up = pct > 0;
  const good = up ? !downIsGood : downIsGood;
  const color = good ? C.pos : C.neg;
  return <span style={{ color, fontVariantNumeric: "tabular-nums" }}>{`${up ? "↑" : "↓"} ${n}%`}</span>;
}

/** Parse a 'YYYY-MM-DD' date into its UTC weekday, Monday = 0 … Sunday = 6 (no timezone drift —
 *  parsed via `Date.UTC`, never the local-time `Date` constructor). */
function mondayIndex(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
  return (dow + 6) % 7; // 0=Mon..6=Sun
}

/** Visually hides an element from sighted view while keeping it in the accessibility tree —
 *  the standard 1px-clip technique (no utility class for this exists yet in the codebase). */
const visuallyHidden: CSSProperties = {
  position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden",
  clip: "rect(0,0,0,0)", clipPath: "inset(50%)", whiteSpace: "nowrap", border: 0,
};

/** Calendar heatmap of daily totals — Monday-start grid, one hue ramped by quartile of
 *  `total/max` through the sanctioned alpha-var sequence (`C.inset` at zero-or-negative →
 *  `--accent-22`/`--accent-40`/`--accent-66`/`--accent` for the rest; a refund-heavy negative day
 *  gets the zero look, not the darkest one — its real amount still reaches the per-cell label).
 *  `mask` formats the amount for the per-cell `aria-label`. No `role="img"` on the wrapper — that
 *  would collapse the subtree and make the per-cell labels unreachable to assistive tech; instead
 *  a visually-hidden caption names the month, the decorative weekday header is `aria-hidden`, and
 *  each day cell carries its own `aria-label` (no `tabIndex` — labels are for AT traversal, not
 *  tab stops). */
export function CalendarHeatmap({ days, lang, mask }: { days: DailySpendingPoint[]; lang: string; mask: (n: number) => string }) {
  const C = useTheme();
  const { t } = useT();
  if (days.length === 0) return null;
  const max = Math.max(...days.map((d) => d.total), 1);
  const offset = mondayIndex(days[0]!.date);
  const monday = new Date(Date.UTC(2020, 0, 6)); // a known Monday
  const weekdays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    return new Intl.DateTimeFormat(lang, { weekday: "narrow", timeZone: "UTC" }).format(d);
  });
  const colorFor = (total: number): string => {
    if (total <= 0) return C.inset;
    const q = total / max;
    if (q <= 0.25) return "var(--accent-22)";
    if (q <= 0.5) return "var(--accent-40)";
    if (q <= 0.75) return "var(--accent-66)";
    return "var(--accent)";
  };
  const monthName = monthLabel(days[0]!.date.slice(0, 7), lang as Parameters<typeof monthLabel>[1]);
  return (
    <div>
      <span style={visuallyHidden}>{t("Daily spending in {month}", { month: monthName })}</span>
      <div aria-hidden="true" style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 3, marginBottom: 4 }}>
        {weekdays.map((w, i) => (
          <div key={i} style={{ fontSize: 9.5, color: C.mute, textAlign: "center" }}>{w}</div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 3 }}>
        {Array.from({ length: offset }, (_, i) => <div key={`pad${i}`} />)}
        {days.map((d) => (
          <div
            key={d.date}
            aria-label={`${d.date} · ${mask(d.total)}`}
            style={{ aspectRatio: 1, borderRadius: 4, background: colorFor(d.total) }}
          />
        ))}
      </div>
    </div>
  );
}

/** Bare polyline sparkline over a plain `number[]` — same shape as `Sparkline` but color is a
 *  prop (stroke via `style`, never an attribute) so callers can use it for series other than
 *  net worth (e.g. per-envelope trend rows). */
export function TrendSpark({ series, color, w = 64, h = 24 }: { series: number[]; color: string; w?: number; h?: number }) {
  const n = series.length;
  if (n < 2) return null;
  const pad = 2;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min || 1;
  const flat = max === min;
  const pts = series
    .map((v, i) => `${(pad + (i / (n - 1)) * (w - 2 * pad)).toFixed(1)},${(flat ? h / 2 : pad + (1 - (v - min) / range) * (h - 2 * pad)).toFixed(1)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden style={{ display: "block" }}>
      <polyline points={pts} fill="none" style={{ stroke: color }} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Net-worth mini-sparkline on the card (polyline without fill; stroke via style — var(--accent) does not work in SVG attributes).
 *  Exported for the Start-screen Net worth widget (components/widgets.tsx) — same visual, no duplication. */
export function Sparkline({ points }: { points: { month: string; total: number }[] }) {
  const n = points.length;
  if (n < 2) return null;
  const W = 320, H = 44, pad = 3;
  const totals = points.map((p) => p.total);
  const min = Math.min(...totals);
  const max = Math.max(...totals);
  const range = max - min || 1;
  const flat = max === min;
  const pts = points
    .map((p, i) => `${(pad + (i / (n - 1)) * (W - 2 * pad)).toFixed(1)},${(flat ? H / 2 : pad + (1 - (p.total - min) / range) * (H - 2 * pad)).toFixed(1)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={44} aria-hidden style={{ display: "block", marginTop: 8 }}>
      <polyline points={pts} fill="none" style={{ stroke: TEAL }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
