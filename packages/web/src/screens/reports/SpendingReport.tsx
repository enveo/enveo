import { median, type SpendingDimension } from "@enveo/shared";
import { useState } from "react";
import { useBand } from "../../components/kit";
import { Bar, DeltaTag, ReportShell, SegBar } from "../../components/reportKit";
import type { StateResponse } from "../../lib/api";
import { useTheme } from "../../lib/contexts";
import { monthLabel } from "../../lib/dates";
import { type Message, msg, useT } from "../../lib/i18n";
import { ENV_PALETTE, tint } from "../../lib/theme";
import { type Mask, TITLES } from "./types";

const DIMENSIONS: Array<{ id: SpendingDimension; label: Message }> = [
  { id: "category", label: msg("Category") },
  { id: "envelope", label: msg("Envelope") },
  { id: "group", label: msg("Group") },
  { id: "place", label: msg("Place") },
];
const RANGES: Array<{ n: number; label: Message }> = [
  { n: 1, label: msg("1 mo") },
  { n: 3, label: msg("3 mo") },
  { n: 6, label: msg("6 mo") },
  { n: 12, label: msg("12 mo") },
];

/**
 * "Spending" tab (frame A2): band = period total + delta vs the 3-mo median of expense (range
 * 1 only — longer ranges show the period instead) and a `SegBar` preview of the top-5 rows.
 * Body: dimension chips, a range control, then per-row bars in the row's OWN color — envelope
 * color when `dim==="envelope"`, a stable `ENV_PALETTE` rotation by row index otherwise (other
 * dimensions have no color of their own). Rows beyond the top 10 fold behind a "+ N more"
 * toggle (local `useState` — expands in place, same idiom as the hub's account list).
 */
export function SpendingReport({
  spending,
  cashflow,
  spBaseline,
  state,
  dim,
  setDim,
  range,
  setRange,
  M,
  month,
  onPrev,
  onNext,
  onBack,
}: {
  spending: { key: string | null; name: string; amount: number; pct: number }[];
  cashflow: { month: string; income: number; expense: number; net: number }[];
  spBaseline: Map<string | null, number>;
  state: StateResponse;
  dim: SpendingDimension;
  setDim: (d: SpendingDimension) => void;
  range: number;
  setRange: (n: number) => void;
  M: Mask;
  month: string;
  onPrev: () => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const C = useTheme();
  const { t, tp, lang } = useT();
  const { hc } = useBand();
  const [expanded, setExpanded] = useState(false);

  const spTotal = spending.reduce((s, r) => s + r.amount, 0);
  const spMax = Math.max(...spending.map((r) => r.amount), 1);
  // baseline = median of the 3 months BEFORE `month` (cashflow always ends at `month`) — same
  // idiom as the hub's SpendingMini card, duplicated here rather than extracted.
  const baseline3 = median(cashflow.slice(-4, -1).map((p) => p.expense));
  const totalDelta = baseline3 > 0 ? (spTotal - baseline3) / baseline3 : null;

  const envColor = new Map(state.envelopes.map((e) => [e.id, e.color]));
  const rowColor = (r: { key: string | null }, i: number): string =>
    (dim === "envelope" && r.key && envColor.get(r.key)) || ENV_PALETTE[i % ENV_PALETTE.length]!;

  const top5 = spending.slice(0, 5);
  const restAmt = Math.max(0, spTotal - top5.reduce((s, r) => s + r.amount, 0));
  // on a Duet band the "rest" segment must still read on navy — a low-alpha tint of the header
  // ink; a plain theme falls back to the ordinary track color.
  const restColor = hc(tint(C.headerInk, 0.25), C.line);
  const segments = [
    ...top5.map((r, i) => ({ weight: Math.max(0, r.amount), color: rowColor(r, i) })),
    ...(restAmt > 0 ? [{ weight: restAmt, color: restColor }] : []),
  ];

  const shown = expanded ? spending : spending.slice(0, 10);
  const rest = spending.slice(10);

  return (
    <ReportShell
      title={t(TITLES.spending)}
      month={month}
      onPrev={onPrev}
      onNext={onNext}
      onBack={onBack}
      eyebrow={t("Total spending")}
      hero={M(spTotal)}
      sub={
        range === 1 ? (
          <>
            <DeltaTag pct={totalDelta} /> {t("vs 3-mo median ({amount})", { amount: M(baseline3) })}
          </>
        ) : (
          t("{n} months to {month}", { n: range, month: monthLabel(month, lang) })
        )
      }
      bandChart={spending.length > 0 ? <SegBar segments={segments} height={9} /> : undefined}
    >
      <div style={{ display: "flex", gap: 6, marginTop: 2, marginBottom: 8, flexWrap: "wrap" }}>
        {DIMENSIONS.map((d) => (
          <button
            key={d.id}
            onClick={() => setDim(d.id)}
            style={{
              padding: "5px 12px",
              borderRadius: 9,
              border: `1px solid ${dim === d.id ? "var(--accent)" : C.line}`,
              background: dim === d.id ? "var(--accent)" : "transparent",
              // on-accent text (C3 contrast audit): white/headerInk measured ~2.1–2.3:1 on the
              // solid accent fill in DARK mode (teal #77c4a2, koral #ff998a, atrament #a5b5d6,
              // duet #8fa2cc are all LIGHT — by design, so they read as AA text on `card`
              // elsewhere in the app). Swapping to `C.card` fixes exactly those 4 dark combos to
              // 4.60–5.57:1 (measured). It does NOT fix light mode: `C.card` on the light accent
              // fill measures only 2.98:1 (teal) / 3.07:1 (koral) — under AA — because those two
              // accents (#4fa583/#f0685c) are mid-tone by design, not tuned to be a "readable on
              // card" light color the way their dark counterparts are; atrament/duet's LIGHT
              // accent is `#1d2a47` so `C.card` clears it easily (14.24 / 13.44:1), coincidentally
              // not by the same design argument. So: 6 of 8 theme×mode combos pass, not "all 8" —
              // the 2 that don't (teal-light, koral-light) are the same pre-existing white/card-
              // on-solid-fill gap flagged app-wide for buttons like "Save"/"Manage"/the FAB (see
              // C3 report Concern #2); out of scope here, not introduced by this change.
              // Duet also got an ink CHANGE (not just a contrast fix): the selected chip used to
              // read `C.headerInk` (#edeff5) here, now reads `C.card` (#fcf8ef) like every other
              // theme — both are ≥12:1 on Duet's accent, so this is a deliberate consistency
              // choice, not a contrast regression.
              color: dim === d.id ? C.card : C.soft,
              fontSize: 12,
              fontWeight: 650,
              cursor: "pointer",
            }}
          >
            {t(d.label)}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", background: C.chip, borderRadius: 9, padding: 2, marginBottom: 12 }}>
        {RANGES.map((r) => (
          <button
            key={r.n}
            onClick={() => setRange(r.n)}
            style={{
              flex: 1,
              padding: "6px 0",
              borderRadius: 7,
              border: "none",
              fontSize: 11.5,
              fontWeight: 650,
              cursor: "pointer",
              background: range === r.n ? C.card : "transparent",
              color: range === r.n ? C.text : C.soft,
              boxShadow: range === r.n ? "0 1px 2px rgba(20,20,28,0.08)" : "none",
            }}
          >
            {t(r.label)}
          </button>
        ))}
      </div>
      {spending.length === 0 && <div style={{ fontSize: 12.5, color: C.mute, padding: "8px 0" }}>{t("No spending in this period.")}</div>}
      {shown.map((r, i) => {
        const color = rowColor(r, i);
        const baseline = spBaseline.get(r.key) ?? 0;
        const delta = baseline > 0 ? (r.amount - baseline) / baseline : null;
        return (
          <div key={r.key ?? "none"} style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 3 }}>
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  fontSize: 13.5,
                  color: C.text,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                <span aria-hidden style={{ width: 8, height: 8, borderRadius: 3, background: color, flexShrink: 0 }} />
                {r.name}
              </span>
              <span style={{ fontSize: 13, fontWeight: 650, color: C.text, fontVariantNumeric: "tabular-nums", flexShrink: 0, marginLeft: 8 }}>
                {M(r.amount)} · {Math.round(r.pct * 100)}%
              </span>
            </div>
            <Bar pct={(r.amount / spMax) * 100} color={color} />
            {range === 1 && (
              <div style={{ textAlign: "right", marginTop: 2, fontSize: 11, color: C.soft }}>
                <DeltaTag pct={delta} /> {t("vs 3 mo")}
              </div>
            )}
          </div>
        );
      })}
      {!expanded && rest.length > 0 && (
        <button
          onClick={() => setExpanded(true)}
          style={{
            display: "block",
            width: "100%",
            background: "none",
            border: "none",
            textAlign: "center",
            padding: "2px 0 8px",
            fontSize: 12,
            color: C.mute,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          {tp("+ {n} more · {amount} | + {n} more · {amount}", rest.length, { amount: M(rest.reduce((s, r) => s + r.amount, 0)) })}
        </button>
      )}
    </ReportShell>
  );
}
