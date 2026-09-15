import { type DailySpendingPoint, type EnvelopeTrend, type Money, NULL_LABEL, type SpendingDimension } from "@enveo/shared";
import type { CSSProperties, ReactNode } from "react";
import { useContext } from "react";
import { createPortal } from "react-dom";
import { useCompactMask, useTheme } from "../lib/contexts";
import { monthLabel, monthShortLabel } from "../lib/dates";
import { type Lang, type Message, useT } from "../lib/i18n";
import { InWideShell, useWideHost } from "../lib/shellContext";
import { font, P, TEAL, type Theme } from "../lib/theme";
import { useElementWidth } from "../lib/useElementWidth";
import { PHONE_COL } from "../lib/viewMode";
import { trendColor } from "../screens/reports/charts";
import { Header } from "./chrome";
import { useBand } from "./kit";
import { polylineCoords } from "./sparkline";

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

type ReportShellProps = ReportShellCommon &
  (
    | { variant?: "subscreen"; title: string; onBack: () => void; onMenu?: never; onHeroClick?: never }
    | { variant: "hub"; onMenu: () => void; onHeroClick?: () => void; title?: never; onBack?: never }
  );

export function netWorthRangeLabel(
  netWorth: { month: string; total: number }[],
  lang: Lang,
  tp: (message: Message, n: number, params?: Record<string, string | number>) => string,
): string | null {
  if (netWorth.length === 0) return null;
  const start = monthShortLabel(netWorth[0]!.month, lang, true);
  const end = monthShortLabel(netWorth.at(-1)!.month, lang, true);
  return tp("last {n} month · {range} | last {n} months · {range}", netWorth.length, { range: `${start} – ${end}` });
}

export function ReportShell(props: ReportShellProps) {
  const { month, onPrev, onNext, eyebrow, hero, sub, bandChart, children } = props;
  const C = useTheme();
  const { band, hc } = useBand();
  const { t, lang } = useT();
  const wideHost = useWideHost();
  const inWide = wideHost !== null;

  if (props.variant !== "hub" && wideHost?.host === "panel") {
    return (
      <>
        <div style={{ padding: "14px 16px 0", display: "flex", flexDirection: "column", gap: 13 }}>
          {/* Design source (v3:1367-1370): the eyebrow/hero/sub trio is its OWN `gap:2px` div that
             closes right after `sub` — the report-specific visual (SegBar, the net-worth chart,
             the budget-health ring…) is a SIBLING inside this outer `gap:13px` column, not a
             fourth item packed into the trio's tight 2px rhythm (review finding: bandChart was
             landing 2px under `sub` instead of the design's ~13px breathing room). */}
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ fontSize: 10, fontWeight: 750, letterSpacing: "0.17em", textTransform: "uppercase", color: C.mute }}>
              {props.title} · {monthLabel(month, lang)}
            </div>
            <div style={{ fontSize: 30, fontWeight: 750, color: C.text, fontVariantNumeric: "tabular-nums" }}>{hero}</div>
            {sub != null && <div style={{ fontSize: 12, color: C.soft }}>{sub}</div>}
          </div>
          {bandChart}
        </div>
        {}
        <div className="fi rpt-body" style={{ padding: "13px 16px 0" }}>
          {children}
        </div>
      </>
    );
  }

  const eyebrowEl = (
    <div style={{ fontSize: 10.5, fontWeight: 750, letterSpacing: "0.17em", textTransform: "uppercase", color: hc(C.headerMute, C.mute) }}>{eyebrow}</div>
  );
  const heroEl = <div style={{ fontSize: 30, fontWeight: 750, color: hc(C.headerInk, C.text), fontVariantNumeric: "tabular-nums" }}>{hero}</div>;
  const subEl = sub != null ? <div style={{ fontSize: 12, color: hc(C.headerMute, C.soft) }}>{sub}</div> : null;

  const hubDesktopRow = props.variant === "hub" && wideHost?.mode === "desktop";
  const heroBlock = hubDesktopRow ? (
    <div style={{ display: "flex", flexDirection: "row", gap: 16 }}>
      <div style={{ flex: "none", width: 216, display: "flex", flexDirection: "column", gap: 3 }}>
        {eyebrowEl}
        {heroEl}
        {subEl}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>{bandChart}</div>
    </div>
  ) : (
    <>
      {eyebrowEl}
      {heroEl}
      {subEl}
      {bandChart}
    </>
  );
  return (
    <>
      <div data-band={band || undefined} style={band ? { background: C.headerBg, paddingBottom: 14 } : { paddingBottom: 14 }}>
        {props.variant === "hub" ? (
          !inWide && <Header month={month} onMenu={props.onMenu} onPrev={onPrev} onNext={onNext} onBand={band} />
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
              {}
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

export function useReportBand(): { band: boolean; hc: (onBand: string, plain: string) => string } {
  const { band } = useBand();
  const inPanel = useWideHost()?.host === "panel";
  const effectiveBand = band && !inPanel;
  return { band: effectiveBand, hc: (onBand, plain) => (effectiveBand ? onBand : plain) };
}

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
    <div style={{ display: "flex", gap: 2, height, flexShrink: 0, borderRadius: height / 2, overflow: "hidden", background: C.line }}>
      {visible.map((s, i) => (
        <span key={i} style={{ flex: s.weight, minWidth: 2, background: s.color }} />
      ))}
    </div>
  );
}

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

/** One pending action a report screen's undo toast can still reverse — a ready-to-render
 *  `message` (each screen builds its own whole-phrase copy, e.g. "Covered {amount} in {name}"
 *  vs. "Filled {amount} in {name}"; this component only renders the string, it never assembles
 *  one, so a new consumer's wording is never forced through this file) plus whatever the
 *  caller's own `id` needs to be to dismiss/undo it.
 *
 *  Originally screen-local to `BudgetsReport`'s checklist (deliberately, per its own comment,
 *  until "a second consumer needs one"); promoted here when the Goals report became that second
 *  consumer. `BudgetsReport` keeps its own richer pending-undo shape (envelope id, month, the
 *  previous allocation to restore) — only `{ id, message }` is what this component itself needs. */
export interface UndoToast {
  id: string;
  message: string;
}

export function UndoBar<T extends UndoToast>({ pending, onUndo, onDismiss }: { pending: T[]; onUndo: (item: T) => void; onDismiss: (id: string) => void }) {
  const { t } = useT();
  const inWide = useContext(InWideShell);
  if (pending.length === 0) return null;
  return createPortal(
    <div
      style={
        inWide
          ? {
              position: "fixed",
              left: "auto",
              right: 24,
              bottom: 24,
              width: `min(${PHONE_COL}px, 40vw)`,
              zIndex: 80,
              display: "flex",
              flexDirection: "column-reverse",
              gap: 8,
            }
          : {
              position: "fixed",
              left: 12,
              right: 12,
              bottom: "calc(78px + env(safe-area-inset-bottom))",
              maxWidth: PHONE_COL,
              margin: "0 auto",
              zIndex: 80,
              display: "flex",
              flexDirection: "column-reverse",
              gap: 8,
            }
      }
    >
      {pending.map((u) => (
        <div
          key={u.id}
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: TEAL,
            color: "#fff",
            borderRadius: 12,
            padding: "10px 12px",
            boxShadow: "0 6px 20px rgba(0,0,0,0.25)",
            fontFamily: font,
          }}
        >
          <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{u.message}</span>
          {}
          <button
            onClick={() => onUndo(u)}
            style={{
              border: "none",
              background: "#fff",
              color: TEAL,
              borderRadius: 8,
              padding: "0 12px",
              minHeight: 30,
              fontSize: 12.5,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {t("Undo")}
          </button>
          <button
            onClick={() => onDismiss(u.id)}
            aria-label={t("Close")}
            style={{
              border: "none",
              background: "transparent",
              color: "#fff",
              fontSize: 16,
              cursor: "pointer",
              lineHeight: 1,
              padding: 0,
              width: 30,
              height: 30,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

export function dimNullLabel(name: string, dim: SpendingDimension, t: (m: Message) => string): string {
  if (name !== NULL_LABEL[dim]) return name;
  switch (dim) {
    case "category":
      return t("No category");
    case "envelope":
      return t("No envelope");
    case "group":
      return t("No group");
    case "place":
      return t("No place");
  }
}

/** Parse a 'YYYY-MM-DD' date into its UTC weekday, Monday = 0 … Sunday = 6 (no timezone drift —
 *  parsed via `Date.UTC`, never the local-time `Date` constructor). */
function mondayIndex(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return (dow + 6) % 7;
}

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

export interface HeatCell {
  date: string;
  total: Money;
}

export function heatWeeks(days: DailySpendingPoint[]): (HeatCell | null)[][] {
  if (days.length === 0) return [];
  const offset = mondayIndex(days[0]!.date);
  const padded: (HeatCell | null)[] = [...Array(offset).fill(null), ...days];
  while (padded.length % 7 !== 0) padded.push(null);
  const weeks: (HeatCell | null)[][] = [];
  for (let i = 0; i < padded.length; i += 7) weeks.push(padded.slice(i, i + 7));
  return weeks;
}

/** Calendar heatmap of daily totals — Monday-start week rows (`heatWeeks`), colored via
 *  `heatColor`. `mask` formats the amount for the per-cell `aria-label`. No `role="img"` on the
 *  wrapper — that would collapse the subtree and make the per-cell labels unreachable to
 *  assistive tech; instead a visually-hidden caption names the month, the decorative weekday
 *  header is `aria-hidden`, and each day cell carries its own `aria-label`.
 *
 *  `selected`/`onSelectDay`/`panel` (all optional, so the existing `MonthReport` call site keeps
 *  compiling unchanged) turn a day cell into a `role="button"` tab stop — same idiom as
 *  `Transactions.tsx`'s own row (`role="button"`/`tabIndex`/Enter-Space `onKeyDown`, guarded by
 *  `e.target !== e.currentTarget` so a future focusable child inside the cell would not
 *  double-fire) — and render `panel` directly under whichever week row contains `selected`, with
 *  a caret pointing at that column. This component stays presentation-only: it does not know what
 *  a day's total MEANS beyond a number for the heat ramp, and knows nothing about transactions or
 *  envelopes — `panel`'s content is entirely the caller's (`MonthReport`).
 *
 *  Ink contrast is corrected for EVERY cell (selected or not) by the same top-quartile boundary
 *  `heatColor` itself uses (`total/max > 0.75` → white), not only the selected one — an unselected
 *  top-quartile cell paints solid `var(--accent)` and a muted-grey day number would sit at low
 *  contrast on that fill. Selection stays visually distinct via the ring (`boxShadow`) alone. */
export function CalendarHeatmap({
  days,
  lang,
  mask,
  selected,
  onSelectDay,
  panel,
}: {
  days: DailySpendingPoint[];
  lang: string;
  mask: (n: number) => string;

  selected?: string | null;

  onSelectDay?: (date: string) => void;

  panel?: ReactNode;
}) {
  const C = useTheme();
  const { t } = useT();
  if (days.length === 0) return null;
  const max = Math.max(...days.map((d) => d.total), 1);
  const weeks = heatWeeks(days);
  const monday = new Date(Date.UTC(2020, 0, 6));
  const weekdays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    return new Intl.DateTimeFormat(lang, { weekday: "narrow", timeZone: "UTC" }).format(d);
  });
  const monthName = monthLabel(days[0]!.date.slice(0, 7), lang as Parameters<typeof monthLabel>[1]);
  const GAP = 3;
  return (
    <div>
      <span style={visuallyHidden}>{t("Daily spending in {month}", { month: monthName })}</span>
      <div aria-hidden="true" style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: GAP, marginBottom: 4 }}>
        {weekdays.map((w, i) => (
          <div key={i} style={{ fontSize: 9.5, color: C.mute, textAlign: "center" }}>
            {w}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {weeks.map((week, wi) => {
          const selIdx = selected ? week.findIndex((c) => c?.date === selected) : -1;
          return (
            <div key={wi}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: GAP }}>
                {week.map((cell, ci) =>
                  cell ? (
                    <div
                      key={cell.date}
                      role={onSelectDay ? "button" : undefined}
                      tabIndex={onSelectDay ? 0 : undefined}
                      onClick={onSelectDay ? () => onSelectDay(cell.date) : undefined}
                      onKeyDown={
                        onSelectDay
                          ? (e) => {
                              if (e.target !== e.currentTarget) return;
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                onSelectDay(cell.date);
                              }
                            }
                          : undefined
                      }
                      aria-label={`${cell.date} · ${mask(cell.total)}`}
                      style={{
                        aspectRatio: 1,
                        borderRadius: 4,
                        background: heatColor(cell.total, max, C),
                        boxShadow: selected === cell.date ? `0 0 0 2px ${cell.total > 0 && cell.total / max > 0.75 ? "#fff" : C.text}` : "none",
                        cursor: onSelectDay ? "pointer" : "default",
                        display: "flex",
                        alignItems: "flex-end",
                        justifyContent: "flex-end",
                        padding: 2,
                        fontSize: 8,
                        color: cell.total > 0 && cell.total / max > 0.75 ? "#fff" : C.mute,
                      }}
                    >
                      {Number(cell.date.slice(8, 10))}
                    </div>
                  ) : (
                    <div key={`pad${ci}`} aria-hidden="true" />
                  ),
                )}
              </div>
              {selIdx >= 0 && panel && (
                <div style={{ position: "relative", marginTop: 10, marginBottom: 5 }}>
                  <span
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      top: -6,
                      left: `calc((100% - ${6 * GAP}px) / 7 * ${selIdx + 0.5} + ${selIdx * GAP}px)`,
                      width: 12,
                      height: 12,
                      background: C.bg,
                      borderLeft: `1px solid ${C.line}`,
                      borderTop: `1px solid ${C.line}`,
                      transform: "translateX(-50%) rotate(45deg)",
                      display: "block",
                    }}
                  />
                  <div style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 12, padding: "11px 12px" }}>{panel}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function TrendSpark({
  series,
  color,
  w = 64,
  h = 24,
  median,
  medianColor,
  dot = false,
}: {
  series: number[];
  color: string;
  w?: number;
  h?: number;
  median?: number;
  medianColor?: string;
  dot?: boolean;
}) {
  const n = series.length;
  if (n < 2) return null;
  const pad = 2;
  const coords = polylineCoords(series, w, h, pad);
  const pts = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = coords[coords.length - 1]!;
  // Same min/max/range/flat handling `polylineCoords` computes internally — duplicated here
  // (cheap for a 6-element array) rather than changing that function's return shape for every
  // caller. `flat` must be checked the same way polylineCoords checks it (`max === min`), not
  // derived from `median` itself, so the median line lands at the same `h/2` the flat polyline
  // does instead of at `h - pad`.
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min || 1;
  const flat = max === min;
  const medianY = median === undefined ? null : flat ? h / 2 : pad + (1 - (median - min) / range) * (h - 2 * pad);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden style={{ display: "block" }}>
      {medianY !== null && (
        <line x1={0} y1={medianY} x2={w} y2={medianY} style={{ stroke: medianColor ?? color }} strokeWidth={1} vectorEffect="non-scaling-stroke" />
      )}
      <polyline
        points={pts}
        fill="none"
        style={{ stroke: color }}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      {dot && <circle cx={last[0]} cy={last[1]} r={2.5} style={{ fill: color }} />}
    </svg>
  );
}

/** `"+$12.40"` / `"−$12.40"` — a signed money delta through the caller's discreet-mode mask.
 *  Shared by `TrendRow` and the Trends report's biggest-mover banner so the two never disagree on
 *  the minus glyph (U+2212, not a hyphen) or on masking the magnitude. */
export function signedDelta(M: (minor: number) => string, delta: number): string {
  return `${delta >= 0 ? "+" : "−"}${M(Math.abs(delta))}`;
}

export function TrendRow({ tr, M, onClick, last = false }: { tr: EnvelopeTrend; M: (minor: number) => string; onClick: () => void; last?: boolean }) {
  const C = useTheme();
  const { t } = useT();
  const color = trendColor(tr, C);
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        padding: "10px 0",
        background: "none",
        border: "none",
        borderBottom: last ? "none" : `1px solid ${C.line}`,
        cursor: "pointer",
        textAlign: "left",
        fontFamily: "inherit",
      }}
    >
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: 3, background: tr.color, flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
        <span style={{ fontSize: 13, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tr.name}</span>
        <span style={{ fontSize: 10.5, color: C.mute, fontVariantNumeric: "tabular-nums", textWrap: "balance" }}>
          {t("{now} · median {median}", { now: M(tr.last), median: M(tr.baseline) })}
        </span>
      </span>
      <span style={{ flexShrink: 0 }}>
        <TrendSpark series={tr.series} color={color} median={tr.baseline} medianColor={C.line} dot w={72} h={26} />
      </span>
      <span style={{ textAlign: "right", flexShrink: 0 }}>
        <span style={{ display: "block", fontSize: 13, fontWeight: 700, color, fontVariantNumeric: "tabular-nums" }}>
          {signedDelta(M, tr.last - tr.baseline)}
        </span>
        {tr.deltaPct !== null && (
          <span style={{ display: "block", fontSize: 10.5, color: C.soft }}>
            <DeltaTag pct={tr.deltaPct} /> {t("vs median")}
          </span>
        )}
      </span>
    </button>
  );
}

/** Gutter reserved for `NetWorthChart`'s value-axis labels. German and Italian have no CLDR
 *  compact ("K"/"tys."/…) form for thousands, so `useCompactMask` falls back to the rounded FULL
 *  number for them ("27.000 €") instead of an abbreviation ("$27K") — a narrower gutter would
 *  clip those locales' labels even though English/Polish/etc. fit comfortably.
 *
 *  76 is measured, not guessed, and it is sized for a BOUNDED worst case. Most of the ~31
 *  supported currencies have no symbol in most locales, so they render as a three-letter CODE;
 *  pair that with a negative six-figure balance and de/it produce "-999.000 CZK" — 12 characters,
 *  69px at this font, against the 58px a 64px gutter left. Measured in a browser with de + CZK:
 *  the labels overflowed their box and the lowest one's text reached 5px into the plot, close
 *  enough to collide with the final dot. Twelve characters IS the ceiling, because de switches to
 *  "1,2 Mio. CZK" above 999.999 — so this does not need to grow again for larger portfolios.
 *
 *  The gutter and the month row below the plot share the container's width, but their worst cases
 *  land in DIFFERENT locales and never stack: de/it need the wide gutter while their month
 *  abbreviations are short, and French (`janv.`, `sept.`) needs the wide month row while its
 *  amounts compact fine. Both were re-measured at this value in the 362px band. */
const AXIS_W = 76;

/**
 * Selects which of a series' max/mid/min values get a gridline, deduping by the FORMATTED
 * label rather than the raw value — the only real logic in `NetWorthChart`, extracted so it can
 * be unit-tested with synthetic `format` functions (see `reportKit.test.ts`) independent of
 * `useCompactMask`'s real rounding. Two-significant-digit compact rounding can make max/mid/min
 * format to the same string (a modest-range series, or discreet mode's `"••••"` for every value
 * alike); three identical labels would read as a broken axis, not "no variance" — so candidates
 * are deduped first-occurrence-wins, collapsing to the single mid tick when all three collide
 * (mirroring `NetWorthChart`'s own flat-series line, which is already at mid-height for the same
 * reason: nothing distinguishes the three heights, so only one line is honest).
 *
 * Extremes beat mid: candidates are compared in `[max, min, mid]` order, so BOTH the top and the
 * floor line win any collision against the middle one — a mid/extreme collision always drops mid,
 * never an extreme. The series' actual highest and lowest points stay on the axis (the plotted
 * line never dips below its own lowest gridline or rises above its highest), and the tick with
 * the least information — the interpolated midpoint — is the one sacrificed. Ticks are then
 * sorted by value descending so draw order (top to bottom) is unchanged regardless of the
 * candidate order used for dedup.
 *
 * The one case that order does NOT cover: if max and min formatted to the same label while mid
 * formatted to a different one, min would be dropped rather than mid. That needs a `format` that
 * is not monotonic, since mid lies between the two — `useCompactMask` rounds, so it cannot
 * produce it, and the flat series (max === min) is already handled by the all-collide branch
 * above. Stated rather than guarded, so nobody reads the rule above as stronger than it is.
 */
export function gridTicks(min: number, max: number, format: (v: number) => string): { value: number; label: string }[] {
  const mid = (min + max) / 2;
  const candidates = [max, min, mid].map((value) => ({ value, label: format(value) }));
  if (new Set(candidates.map((c) => c.label)).size === 1) return [candidates[2]!];
  return candidates.filter((c, i) => candidates.findIndex((o) => o.label === c.label) === i).sort((a, b) => b.value - a.value);
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
 * The month row beneath the plot uses `monthShortLabel` (short, no year) — a browser pass measured
 * twelve `monthLabel().split(" ")[0]` FULL month names ("September", "Dezember", …) overflowing
 * their row's `scrollWidth` at every viewport tested, phone included. The per-dot `<title>`
 * tooltip stays on the full `monthLabel` — it is read on hover, not squeezed into a fixed row.
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
            // A negative or six-digit value in a locale with no CLDR compact form for
            // thousands (German, Italian — useCompactMask falls back to the rounded full
            // number there) combined with a code-rendered currency can outrun AXIS_W - 6.
            // A single line spilling a few px into the light area fill reads better than a
            // two-line label detached from the gridline it names — keep this nowrap.
            whiteSpace: "nowrap",
          }}
        >
          {lvl.label}
        </div>
      ))}
      <div style={{ display: "flex", justifyContent: "space-between", width: plotW, marginTop: 4, fontSize: 10.5, color: caption }}>
        {points.map((p, i) => (
          <span key={i}>{monthShortLabel(p.month, lang)}</span>
        ))}
      </div>
    </div>
  );
}
