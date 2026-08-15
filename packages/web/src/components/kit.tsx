import type { CSSProperties, ReactNode } from "react";
import { useTheme } from "../lib/contexts";
import { INPUT_FOCUS_CLASS } from "../lib/focusPresentation";
import { useT } from "../lib/i18n";
import { Ico } from "../lib/icons";
import { highlightRanges } from "../lib/search";
import { font, P } from "../lib/theme";
import type { SpendMeter } from "../lib/uiState";

/** Band (Duet header language) detection + color chooser — replaces ad-hoc `band ? x : y` ternaries. */
export function useBand(): { band: boolean; hc: (onBand: string, plain: string) => string } {
  const C = useTheme();
  const band = C.headerStyle === "band";
  return { band, hc: (onBand, plain) => (band ? onBand : plain) };
}

/** Uppercase section label with an optional right-aligned element (sum, link). */
export function SectionEyebrow({ label, right }: { label: string; right?: ReactNode }) {
  const C = useTheme();
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: `10px ${P + 4}px 5px` }}>
      <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.17em", textTransform: "uppercase", color: C.mute }}>{label}</span>
      {right != null && <span style={{ fontSize: 11, fontWeight: 600, color: C.soft, fontVariantNumeric: "tabular-nums" }}>{right}</span>}
    </div>
  );
}

/** Neutral content card — the only surface rows live on (replaces colored tiles). */
export function CardBox({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  const C = useTheme();
  return (
    <div style={{ background: C.card, borderRadius: 14, margin: `0 ${P}px`, padding: "2px 14px", boxShadow: "0 1px 3px rgba(20,20,28,0.06)", ...style }}>
      {children}
    </div>
  );
}

/** Spending meter line — ALWAYS means "spent of assigned" (spec §3.2). */
export function SpendLine({ meter }: { meter: SpendMeter }) {
  const C = useTheme();
  const fillColor = meter.state === "over" ? C.neg : meter.state === "warn" ? C.warn : C.mute;
  return (
    <span style={{ flex: 1, height: 3, borderRadius: 2, background: C.line, overflow: "hidden", display: "block" }}>
      <span style={{ display: "block", height: "100%", width: `${Math.round(meter.fill * 100)}%`, borderRadius: 2, background: fillColor }} />
    </span>
  );
}

/** Search row shared by every envelope/account picker sheet (Add's envelope/account/destination
 *  sheets, the split editor's per-item picker, Transactions' filter sheet, the widget "picked"
 *  checklists) — same idiom as Transactions.tsx's own search bar, just borderless-on-chip instead
 *  of docked under the header. Deliberately NOT autofocused: on mobile that would pop the keyboard
 *  over the list the instant the sheet opens — the user taps in when they actually want to type. */
export function PickerSearch({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const C = useTheme();
  const { t } = useT();
  return (
    <div
      className={INPUT_FOCUS_CLASS}
      style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", marginBottom: 10, background: C.chip, borderRadius: 11 }}
    >
      <Ico d="M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3" size={15} color={C.mute} sw={1.8} />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? t("Search…")}
        style={{ flex: 1, minWidth: 0, background: "none", border: "none", fontSize: 13.5, color: C.text, fontFamily: font }}
      />
      {value && (
        <button
          onClick={() => onChange("")}
          aria-label={t("Clear search")}
          style={{ background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex" }}
        >
          <Ico d="M6 6l12 12M18 6L6 18" size={13} color={C.mute} sw={2} />
        </button>
      )}
    </div>
  );
}

/** Renders `highlightRanges` segments — the matched span gets a subtle accent weight/tint, no
 *  background block (keeps the list visually quiet while still drawing the eye). */
export function HighlightedText({ text, query }: { text: string; query: string }) {
  const segments = highlightRanges(text, query);
  return (
    <>
      {segments.map((seg, i) =>
        seg.hit ? (
          <span key={i} style={{ fontWeight: 750, color: "var(--accent)" }}>
            {seg.text}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

/** Monthly-goal ring (spec §3.3) — accent-colored by default; pass `color` to override (e.g.
 *  `C.pos` for a fully-funded ring, GoalsReport rows). Full circle = goal met. */
export function GoalRing({ pct, size = 14, color = "var(--accent)" }: { pct: number; size?: number; color?: string }) {
  const C = useTheme();
  const r = (size - 3) / 2;
  const c = 2 * Math.PI * r;
  const arc = (Math.min(100, Math.max(0, pct)) / 100) * c;
  const mid = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" style={{ flexShrink: 0 }}>
      <circle cx={mid} cy={mid} r={r} style={{ fill: "none", stroke: C.line, strokeWidth: 3 }} />
      <circle
        cx={mid}
        cy={mid}
        r={r}
        style={{ fill: "none", stroke: color, strokeWidth: 3, strokeLinecap: "round", strokeDasharray: `${arc} ${c}` }}
        transform={`rotate(-90 ${mid} ${mid})`}
      />
    </svg>
  );
}
