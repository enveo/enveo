import type { DailySpendingPoint } from "@enveo/shared";
import type { CSSProperties, ReactNode } from "react";
import { useCompactMask, useTheme } from "../lib/contexts";
import { monthLabel } from "../lib/dates";
import { useT } from "../lib/i18n";
import { P, TEAL, type Theme } from "../lib/theme";
import { useElementWidth } from "../lib/useElementWidth";
import { Header } from "./chrome";
import { useBand } from "./kit";

/**
 * Report component kit — the shared visual language for every report subscreen (Tasks 8–12):
 * a `ReportShell` band header (hero number + optional chart on `C.headerBg` when the theme is
 * Duet), plus small primitives (`Bar`, `SegBar`, `DeltaTag`, `CalendarHeatmap`, `TrendSpark`,
 * `Sparkline`) that read tokens off `useTheme()`/`useBand()` instead of hardcoding colors.
 * Every SVG color goes through `style` — `var(--accent)` etc. do not resolve in presentation
 * attributes. Status colors (pos/warn/neg) never carry meaning alone; callers supply the label.
 */

/** Fields every `ReportShell` render needs regardless of variant. */
type ReportShellCommon = {
  month: string;
  onPrev: () => void;
  onNext: () => void;
  eyebrow: string;
  hero: ReactNode;
  sub?: ReactNode;
  bandChart?: ReactNode;
  children: ReactNode;
};

/** Discriminated on `variant` so each caller's shape is checked at compile time — a subscreen
 *  MUST pass `title`/`onBack` (and cannot pass `onMenu`/`onHeroClick`); a hub caller MUST pass
 *  `onMenu` (and cannot pass `title`/`onBack`). `variant` defaults to `"subscreen"` (optional
 *  literal in that member) so all seven existing subscreen call sites are unaffected. Before
 *  this union, `title`/`onBack` were merely optional on one flat prop type, which would have let
 *  a future subscreen call site compile while omitting `onBack` — a dead back-chevron button at
 *  runtime, with nothing catching it (Task 4 fix round 1). */
type ReportShellProps = ReportShellCommon &
  (
    | { variant?: "subscreen"; title: string; onBack: () => void; onMenu?: never; onHeroClick?: never }
    | { variant: "hub"; onMenu: () => void; onHeroClick?: () => void; title?: never; onBack?: never }
  );

/** Report band: shared by every subscreen AND the hub (Task 4 — the two previously-forked
 *  copies of this grammar are now one). Top row is `variant`-dependent (back+title+month-nav
 *  for a subscreen, the app-chrome `Header` for the hub); everything below — eyebrow/hero/sub,
 *  the optional `bandChart` slot, `hc()` for on-band ink — is identical between variants and
 *  moved verbatim from the inline block in Reports.tsx / the hub's hand-rolled copy. The hub
 *  additionally makes the eyebrow/hero/sub block a full-width button (`onHeroClick`) that opens
 *  the Assets report — same button reset the hub always used. Body `children` render below in a
 *  `className="fi rpt-body"` div — opacity-only animation, never `fu`/transform (a transformed
 *  ancestor breaks `position:fixed` sheets). The body's `paddingTop` matches the band's own
 *  `paddingBottom` above it (14 for a subscreen, matching that variant's top-row bottom padding
 *  of 10 plus the eyebrow block's own spacing; 10 for the hub, matching `Header`'s tighter bottom
 *  padding of 6) so the band→content gap is consistent whichever variant renders — previously a
 *  subscreen's body div had NO top padding at all, so only some subscreens' own baked-in top
 *  margins gave any breathing room, and Goals/Trends sat flush under the band (reported bug).
 *  The `rpt-body` class pairs with a global `!important` rule (chrome.tsx's injected stylesheet)
 *  that zeroes whichever element ends up as the body's actual first DOM child — simpler and more
 *  robust than hand-editing every subscreen's first element (Budgets' first section alone varies
 *  by data: Overspent/Near/Within budget each carry a different top margin). */
export function ReportShell(props: ReportShellProps) {
  const { month, onPrev, onNext, eyebrow, hero, sub, bandChart, children } = props;
  const C = useTheme();
  const { band, hc } = useBand();
  const { t, lang } = useT();
  const heroBlock = (
    <>
      <div style={{ fontSize: 10.5, fontWeight: 750, letterSpacing: "0.17em", textTransform: "uppercase", color: hc(C.headerMute, C.mute) }}>{eyebrow}</div>
      <div style={{ fontSize: 30, fontWeight: 750, color: hc(C.headerInk, C.text), fontVariantNumeric: "tabular-nums" }}>{hero}</div>
      {sub != null && <div style={{ fontSize: 12, color: hc(C.headerMute, C.soft) }}>{sub}</div>}
      {bandChart}
    </>
  );
  return (
    <>
      <div data-band={band || undefined} style={band ? { background: C.headerBg, paddingBottom: 14 } : { paddingBottom: 14 }}>
        {props.variant === "hub" ? (
          <Header month={month} onMenu={props.onMenu} onPrev={onPrev} onNext={onNext} onBand={band} />
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: `12px ${P}px 10px` }}>
            <button
              aria-label={t("Back")}
              onClick={props.onBack}
              style={{
                flexShrink: 0,
                width: 30,
                height: 30,
                borderRadius: 15,
                border: "none",
                background: "transparent",
                color: hc(C.headerInk, C.text),
                fontSize: 22,
                lineHeight: 1,
                cursor: "pointer",
                padding: 0,
                marginLeft: -6,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              ‹
            </button>
            <span
              style={{
                flex: 1,
                fontSize: 16,
                fontWeight: 700,
                color: hc(C.headerInk, C.text),
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {props.title}
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 0, flexShrink: 0 }}>
              {/* 30x30 hit target (matches the back button above) around the same 17px glyph — a bare
                 `padding: "2px 7px"` box measured 21x21, under the touch-target floor (see task-14
                 report); aria-label reuses chrome.tsx's existing "Previous/Next month" keys so this
                 control reads the same as the global header's equivalent. */}
              <button
                aria-label={t("Previous month")}
                onClick={onPrev}
                style={{
                  border: "none",
                  background: "transparent",
                  color: hc(C.headerMute, C.soft),
                  fontSize: 17,
                  lineHeight: 1,
                  cursor: "pointer",
                  padding: 0,
                  width: 30,
                  height: 30,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                ‹
              </button>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: hc(C.headerInk, C.text), minWidth: 58, textAlign: "center" }}>
                {monthLabel(month, lang).split(" ")[0]}
              </span>
              <button
                aria-label={t("Next month")}
                onClick={onNext}
                style={{
                  border: "none",
                  background: "transparent",
                  color: hc(C.headerMute, C.soft),
                  fontSize: 17,
                  lineHeight: 1,
                  cursor: "pointer",
                  padding: 0,
                  width: 30,
                  height: 30,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                ›
              </button>
            </span>
          </div>
        )}
        {props.variant === "hub" && props.onHeroClick ? (
          <button
            onClick={props.onHeroClick}
            style={{
              display: "block",
              width: "100%",
              background: "none",
              border: "none",
              padding: `10px ${P}px 0`,
              textAlign: "left",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {heroBlock}
          </button>
        ) : (
          <div style={{ padding: props.variant === "hub" ? `10px ${P}px 0` : `0 ${P}px` }}>{heroBlock}</div>
        )}
      </div>
      {/* Animation is `fi` ONLY (opacity) — `fu`/transform breaks position:fixed of sheets inside.
         `rpt-body` pairs with the global first-child margin-top reset (chrome.tsx) so this
         paddingTop is the sole band→content gap across every subscreen. The hub keeps its own
         10px top padding (its grid's existing spacing) rather than the subscreen's 14px — see
         task-4 report for why that one won. */}
      <div className="fi rpt-body" style={{ padding: `${props.variant === "hub" ? 10 : 14}px ${P}px 0` }}>
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
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0,0,0,0)",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};

/** Quartile heat ramp shared by `CalendarHeatmap` and the Reports hub's `MonthMini`: one hue
 *  ramped by quartile of `total/max` through the sanctioned alpha-var sequence (`C.inset` at
 *  zero-or-negative → `--accent-22`/`--accent-40`/`--accent-66`/`--accent` for the rest; a
 *  refund-heavy negative day gets the zero look, not the darkest one — its real amount still
 *  reaches the caller's own per-cell label). */
export function heatColor(total: number, max: number, C: Theme): string {
  if (total <= 0) return C.inset;
  const q = total / max;
  if (q <= 0.25) return "var(--accent-22)";
  if (q <= 0.5) return "var(--accent-40)";
  if (q <= 0.75) return "var(--accent-66)";
  return "var(--accent)";
}

/** Calendar heatmap of daily totals — Monday-start grid, colored via `heatColor`. `mask` formats
 *  the amount for the per-cell `aria-label`. No `role="img"` on the wrapper — that would collapse
 *  the subtree and make the per-cell labels unreachable to assistive tech; instead a
 *  visually-hidden caption names the month, the decorative weekday header is `aria-hidden`, and
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
  const monthName = monthLabel(days[0]!.date.slice(0, 7), lang as Parameters<typeof monthLabel>[1]);
  return (
    <div>
      <span style={visuallyHidden}>{t("Daily spending in {month}", { month: monthName })}</span>
      <div aria-hidden="true" style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 3, marginBottom: 4 }}>
        {weekdays.map((w, i) => (
          <div key={i} style={{ fontSize: 9.5, color: C.mute, textAlign: "center" }}>
            {w}
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 3 }}>
        {Array.from({ length: offset }, (_, i) => (
          <div key={`pad${i}`} />
        ))}
        {days.map((d) => (
          <div key={d.date} aria-label={`${d.date} · ${mask(d.total)}`} style={{ aspectRatio: 1, borderRadius: 4, background: heatColor(d.total, max, C) }} />
        ))}
      </div>
    </div>
  );
}

/** Shared normalized-polyline math for `TrendSpark`/`Sparkline`: x evenly spaced across `w`
 *  (`pad` inset each side), y linearly scaled between the series' own min/max onto `h` (a
 *  perfectly flat series draws a level line at `h/2` rather than dividing by a zero range).
 *  Returns RAW (unrounded) coords — callers needing a `points` string apply `.toFixed(1)`
 *  themselves at render time (Sparkline's last-point dot deliberately uses the raw value, not
 *  the rounded one, matching its pre-extraction behavior). Assumes `series.length >= 2`. */
function polylineCoords(series: number[], w: number, h: number, pad: number): (readonly [number, number])[] {
  const n = series.length;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min || 1;
  const flat = max === min;
  // A sub-pixel container (a panel mid-animation, a flex item mid-reflow) can transiently
  // measure ~1px wide; with pad=2/3 that made `w - 2*pad` negative, so x ran backwards from
  // `pad` down to `pad - |negative|` — a reversed, partly negative-x polyline for that one frame.
  // Clamping the inner width to at least 1 keeps that frame from rendering nonsense; it's
  // transient and self-corrects on the next ResizeObserver callback, so this is not a fix for the
  // underlying measurement, only for what gets drawn in between.
  const innerW = Math.max(1, w - 2 * pad);
  return series.map((v, i) => [pad + (i / (n - 1)) * innerW, flat ? h / 2 : pad + (1 - (v - min) / range) * (h - 2 * pad)] as const);
}

/** Bare polyline sparkline over a plain `number[]` — same shape as `Sparkline` but color is a
 *  prop (stroke via `style`, never an attribute) so callers can use it for series other than
 *  net worth (e.g. per-envelope trend rows). Its width is intentionally caller-supplied (`w` prop)
 *  because it renders inside fixed-width row slots beside text, where the size is a layout decision
 *  the caller owns; measuring would be incorrect here. */
export function TrendSpark({ series, color, w = 64, h = 24 }: { series: number[]; color: string; w?: number; h?: number }) {
  const n = series.length;
  if (n < 2) return null;
  const pad = 2;
  const pts = polylineCoords(series, w, h, pad)
    .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden style={{ display: "block" }}>
      <polyline
        points={pts}
        fill="none"
        style={{ stroke: color }}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Net-worth mini-sparkline on the card (polyline without fill; stroke via style — var(--accent) does not work in SVG attributes).
 *  Exported for the Start-screen Net worth widget (components/widgets.tsx) — same visual, no duplication.
 *  `stroke` defaults to TEAL (today's behavior, unchanged for existing callers); pass an on-band color
 *  (e.g. `hc(C.headerInk, "var(--accent)")`) when painted on a Duet navy band, where TEAL would be
 *  invisible (navy on navy). `dotColor` is opt-in — omitted (the default) draws no last-point dot at all. */
export function Sparkline({ points, stroke = TEAL, dotColor }: { points: { month: string; total: number }[]; stroke?: string; dotColor?: string }) {
  const [boxRef, W] = useElementWidth<HTMLDivElement>(320);
  const n = points.length;
  if (n < 2) return null;
  const H = 44,
    pad = 3;
  const coords = polylineCoords(
    points.map((p) => p.total),
    W,
    H,
    pad,
  );
  const pts = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = coords[coords.length - 1]!;
  return (
    <div ref={boxRef} style={{ marginTop: 8 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={44} aria-hidden style={{ display: "block" }}>
        <polyline points={pts} fill="none" style={{ stroke }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {dotColor && <circle cx={last[0]} cy={last[1]} r={3.5} style={{ fill: dotColor }} />}
      </svg>
    </div>
  );
}

/** Gutter reserved for `NetWorthChart`'s value-axis labels. German and Italian have no CLDR
 *  compact ("K"/"tys."/…) form for thousands, so `useCompactMask` falls back to the rounded FULL
 *  number for them ("27.000 €", ~8 characters) instead of an abbreviation ("$27K") — a narrower
 *  gutter would clip those locales' labels even though English/Polish/etc. fit comfortably. */
const AXIS_W = 64;

/**
 * Selects which of a series' max/mid/min values get a gridline, deduping by the FORMATTED
 * label rather than the raw value — the only real logic in `NetWorthChart`, extracted so it can
 * be unit-tested with synthetic `format` functions (see `reportKit.test.ts`) independent of
 * `useCompactMask`'s real rounding. Two-significant-digit compact rounding can make max/mid/min
 * format to the same string (a modest-range series, or discreet mode's `"••••"` for every value
 * alike); three identical labels would read as a broken axis, not "no variance" — so candidates
 * are compared in draw order (max, mid, min) and only the first occurrence of each distinct label
 * is kept, collapsing to the single mid tick when all three collide (mirroring `NetWorthChart`'s
 * own flat-series line, which is already at mid-height for the same reason: nothing distinguishes
 * the three heights, so only one line is honest).
 *
 * Order is deliberately max→mid→min, so a min/mid collision keeps mid and drops min (a top and a
 * middle line, nothing near the series floor) while a max/mid collision keeps both extremes and
 * drops mid — that asymmetry is a direct consequence of "first occurrence wins" and is pinned by
 * tests on purpose, not "fixed": changing the draw order is a real change to the axis and should
 * fail a test, not happen silently in a refactor.
 */
export function gridTicks(min: number, max: number, format: (v: number) => string): { value: number; label: string }[] {
  const mid = (min + max) / 2;
  const candidates = [max, mid, min].map((value) => ({ value, label: format(value) }));
  if (new Set(candidates.map((c) => c.label)).size === 1) return [candidates[1]!];
  return candidates.filter((c, i) => candidates.findIndex((o) => o.label === c.label) === i);
}

/**
 * Net-worth line chart — shared by the Reports hub (band hero, taller `height`) and the Wealth
 * report (body, shorter `height`), replacing what used to be two forked copies of this same
 * grammar. Draws three horizontal gridlines at the series' max/mid/min with their value printed
 * in a right-hand gutter, an area+line beneath/over them, and a dot per point; every dot carries
 * an SVG `<title>` (hover tooltip) with the exact amount, which is the only place this chart shows
 * a precise figure — the gutter itself is compact-rounded. Every amount rendered here — all three
 * gridline labels and every tooltip — goes through `useCompactMask`, never `compactMoney` directly,
 * so this chart degrades under discreet mode exactly like every other amount in the app.
 *
 * `useCompactMask`'s 2-significant-digit rounding can make gridline labels collide (see
 * `gridTicks`, below, for the dedup rule this delegates to and why it is pinned by tests) — this
 * is a label-collision fix, not a precision fix: raising `useCompactMask`'s significant digits
 * would defeat the point of a compact axis.
 *
 * `onBand` swaps the stroke/dot/gridline/caption colors for the Duet on-navy variant — a plain
 * ternary on the prop, mirroring `AssetsReport`'s existing inline chart's signature (real
 * continuity, not a new idiom) and keeping the on-band decision with the caller rather than
 * deriving it from `useBand()`'s `hc()` internally. `TEAL` (`var(--accent)`) IS the Duet band
 * color, so it would be invisible navy-on-navy there.
 *
 * No test for the component itself: this repo's web tests are `lib`-only and render nothing, so
 * a test here would assert layout it cannot see. This component is verified visually against a
 * running app in a later task — do not add a hollow render-only test here to feel covered. Its
 * one piece of real (non-rendering) logic, the gridline selection, is extracted as `gridTicks`
 * above precisely so it CAN be pinned by a real test (`reportKit.test.ts`).
 *
 * The `useElementWidth` call sits above the `points.length < 2` early return on purpose: a hook
 * called after a conditional return is exactly the shape of a bug already shipped once in this
 * codebase (a late-mounting chart never got measured because the early return ran first).
 */
export function NetWorthChart({ points, height, onBand }: { points: { month: string; total: number }[]; height: number; onBand?: boolean }) {
  const C = useTheme();
  const { t, lang } = useT();
  const mask = useCompactMask();
  const [boxRef, W] = useElementWidth<HTMLDivElement>(340);
  const n = points.length;
  if (n < 2) return null;

  const totals = points.map((p) => p.total);
  const min = Math.min(...totals);
  const max = Math.max(...totals);
  const span = max - min || 1;
  const flat = max === min;

  const plotW = Math.max(1, W - AXIS_W);
  const padX = 6,
    padT = 12,
    padB = 10;
  const innerH = height - padT - padB;
  const x = (i: number) => padX + (n <= 1 ? (plotW - 2 * padX) / 2 : (i / (n - 1)) * (plotW - 2 * padX));
  const y = (v: number) => (flat ? padT + innerH / 2 : padT + (1 - (v - min) / span) * innerH);

  // fill/stroke via style — var(--accent) does not resolve in SVG presentation attributes.
  // `onBand` is a per-instance PROP (see the doc comment above for why), not `useBand()`'s `hc()`.
  const stroke = onBand ? C.headerInk : TEAL;
  const dotPos = onBand ? C.headerPos : C.pos;
  const gridline = onBand ? C.headerMute : C.line;
  const caption = onBand ? C.headerMute : C.mute;

  const coords = points.map((p, i) => [x(i), y(p.total)] as const);
  const line = coords.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px.toFixed(1)} ${py.toFixed(1)}`).join(" ");
  const area = `${line} L${x(n - 1).toFixed(1)} ${(height - padB).toFixed(1)} L${x(0).toFixed(1)} ${(height - padB).toFixed(1)} Z`;

  const levels = gridTicks(min, max, mask).map((t) => ({ y: y(t.value), label: t.label }));

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${height}`} width="100%" height={height} role="img" aria-label={t("Net worth over time")} style={{ display: "block" }}>
        {levels.map((lvl, i) => (
          <line key={i} x1={0} y1={lvl.y} x2={plotW} y2={lvl.y} style={{ stroke: gridline }} strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ))}
        <path d={area} style={{ fill: stroke }} opacity={0.09} />
        <path d={line} fill="none" style={{ stroke }} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {coords.map(([px, py], i) => (
          <circle key={i} cx={px} cy={py} r={i === n - 1 ? 4 : 2.5} style={{ fill: i === n - 1 ? dotPos : stroke }}>
            <title>{`${monthLabel(points[i]!.month, lang)} · ${mask(points[i]!.total)}`}</title>
          </circle>
        ))}
      </svg>
      {levels.map((lvl, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            top: lvl.y - 6,
            right: 0,
            width: AXIS_W - 6,
            fontSize: 10,
            textAlign: "right",
            color: caption,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {lvl.label}
        </div>
      ))}
      <div style={{ display: "flex", justifyContent: "space-between", width: plotW, marginTop: 4, fontSize: 10.5, color: caption }}>
        {points.map((p, i) => (
          <span key={i}>{monthLabel(p.month, lang).split(" ")[0]}</span>
        ))}
      </div>
    </div>
  );
}
