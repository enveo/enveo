import { median, type SpendingDetail, type SpendingDimension } from "@enveo/shared";
import { useEffect, useState } from "react";
import { Bar, DeltaTag, dimNullLabel, ReportShell, SegBar, useReportBand } from "../../components/reportKit";
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
 * Body: dimension chips, a range control, an optional "without X, Y · Reset" bar, then per-row
 * bars in the row's OWN color — envelope color when `dim==="envelope"`, a stable `ENV_PALETTE`
 * rotation by the row's position in the FULL unfiltered sort order otherwise (other dimensions
 * have no color of their own). Rows beyond the top 10 fold behind a "+ N more" toggle (local
 * `useState` — expands in place, same idiom as the hub's account list).
 *
 * Per-row exclusion (`✕`/`↩`) is a pure presentation filter over `spending`, kept local rather
 * than lifted to `Reports.tsx`: it needs no re-fetch and naturally resets when the user leaves
 * this tab (the parent unmounts this component). It DOES reset on a dimension change, because
 * the key space changes entirely (an envelope id under `envelope`, a category id under
 * `category`, …) — a stale exclusion from the old dimension would otherwise silently re-apply
 * if the user switches back. It stays untouched across a range or month change, where the key
 * space is unchanged and the exclusion remains meaningful. The band hero/delta and the fold's
 * "+ N more" amount recompute from the still-included rows; the fold's row COUNT does not (it
 * counts every hidden row, excluded or not — "how many rows are hidden" is a different question
 * than "how much of my countable spend is hidden").
 *
 * Clicking an included row opens a detail card right below the fold button: a sub-breakdown by
 * the OTHER natural dimension (place, or envelope when `dim` is already place), `n txns · avg ·
 * largest`, and an "Open transactions ›" link (envelope/category/place map directly onto
 * `TransactionFilters`; a group resolves to its member envelope ids). `selectedKey` is
 * re-validated against `includedRows` on every render (`effectiveSelectedKey`) so the card closes
 * itself — with no separate reset code — the moment its row stops being included, whether that's
 * because month/range navigation moved it out of `spending` entirely or because the user just
 * excluded it. Because `selectedKey`'s own "nothing selected" sentinel is the same JS `null` that
 * represents the dimension's "unassigned" bucket, clicking that bucket's row can never actually
 * select it (the toggle always lands back on `null`) — so its card, and with it the "Open
 * transactions" link, structurally never renders; opening an unfiltered transaction list off a
 * "No envelope"/"No place" click would read as a bug, and there is no real "unassigned" predicate
 * in `TransactionFilters` to back a correct one. The link (like the card's own `▲ % vs 3 mo` line)
 * only ever renders at `range === 1`, so it never opens something other than the single month the
 * user just inspected.
 */
export function SpendingReport({
  spending,
  cashflow,
  spBaseline,
  spendDetailFor,
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
  onOpenTxns,
}: {
  spending: { key: string | null; name: string; amount: number; pct: number }[];
  cashflow: { month: string; income: number; expense: number; net: number }[];
  spBaseline: Map<string | null, number>;
  spendDetailFor: (key: string | null) => SpendingDetail | null;
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
  onOpenTxns: (f: { envId?: string; envIds?: ReadonlySet<string>; catId?: string; placeId?: string }) => void;
}) {
  const C = useTheme();
  const { t, tp, lang } = useT();
  const { hc } = useReportBand();
  const [expanded, setExpanded] = useState(false);
  const [excluded, setExcluded] = useState<ReadonlySet<string | null>>(new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  useEffect(() => {
    setExpanded(false);
    setExcluded(new Set());
    setSelectedKey(null);
  }, [dim]);

  // Position in the FULL, unfiltered sort order — built once per render, independent of any
  // filter, so excluding/restoring a row never repaints a DIFFERENT row's color (a filtered
  // subset's index shifts every time a row ahead of it is excluded).
  const rowIndexOf = new Map(spending.map((r, i) => [r.key, i]));
  const envColor = new Map(state.envelopes.map((e) => [e.id, e.color]));
  const rowColor = (key: string | null): string =>
    (dim === "envelope" && key && envColor.get(key)) || ENV_PALETTE[(rowIndexOf.get(key) ?? 0) % ENV_PALETTE.length]!;

  const includedRows = spending.filter((r) => !excluded.has(r.key));
  const spTotal = includedRows.reduce((s, r) => s + r.amount, 0);
  const spTop = Math.max(...includedRows.map((r) => r.amount), 1); // bar denominator re-baselines to the largest REMAINING row
  // baseline = median of the 3 months BEFORE `month` (cashflow always ends at `month`) — same
  // idiom as the hub's SpendingMini card, duplicated here rather than extracted. Deliberately
  // exclusion-UNaware: an honest "adjusted vs normal" comparison, not a claim the baseline is
  // exclusion-adjusted too.
  const baseline3 = median(cashflow.slice(-4, -1).map((p) => p.expense));
  const totalDelta = baseline3 > 0 ? (spTotal - baseline3) / baseline3 : null;

  const included5 = includedRows.slice(0, 5);
  const restAmt = Math.max(0, spTotal - included5.reduce((s, r) => s + r.amount, 0));
  // on a Duet band the "rest" segment must still read on navy — a low-alpha tint of the header
  // ink; a plain theme falls back to the ordinary track color.
  const restColor = hc(tint(C.headerInk, 0.25), C.line);
  const segments = [
    ...included5.map((r) => ({ weight: Math.max(0, r.amount), color: rowColor(r.key) })),
    ...(restAmt > 0 ? [{ weight: restAmt, color: restColor }] : []),
  ];

  const excludedNames = spending.filter((r) => excluded.has(r.key)).map((r) => dimNullLabel(r.name, dim, t));

  // SAME array both times — no index/array mismatch between the shown rows and the folded tail
  // (folding over a filtered array while summing a differently-sized one undercounts the tail
  // once anything ahead of it is excluded).
  const shown = expanded ? spending : spending.slice(0, 10);
  const restRows = spending.slice(shown.length);
  const restCount = restRows.length;
  const restAmount = restRows.filter((r) => !excluded.has(r.key)).reduce((s, r) => s + r.amount, 0);

  // Re-validated on every render against the still-included rows — closes the card with no
  // separate reset code, whether the row moved out of `spending` (month/range navigation) or
  // just got excluded. See the doc comment above for why this can never equal a null (unassigned)
  // key: that bucket's own row can never actually select itself.
  const effectiveSelectedKey = selectedKey !== null && includedRows.some((r) => r.key === selectedKey) ? selectedKey : null;
  const detail = effectiveSelectedKey !== null ? spendDetailFor(effectiveSelectedKey) : null;

  const handleOpenTxns = (key: string) => {
    if (dim === "envelope") onOpenTxns({ envId: key });
    else if (dim === "category") onOpenTxns({ catId: key });
    else if (dim === "place") onOpenTxns({ placeId: key });
    else {
      // group — TransactionFilters has no group predicate, so resolve to member envelope ids.
      // Savings envelopes are excluded on purpose: expenseByDimension leaves them out of every
      // spending total, so the opened list matches what the row's own amount counted.
      const ids = new Set(state.envelopes.filter((e) => e.groupId === key && !e.isSavings).map((e) => e.id));
      onOpenTxns(ids.size > 0 ? { envIds: ids } : {});
    }
  };

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
      {excludedNames.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            background: C.bg,
            border: `1px solid ${C.line}`,
            borderRadius: 10,
            padding: "7px 11px",
            marginBottom: 12,
          }}
        >
          <span style={{ fontSize: 11, color: C.soft, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("Without {names}", { names: excludedNames.join(", ") })}
          </span>
          <button
            onClick={() => setExcluded(new Set())}
            style={{
              flexShrink: 0,
              background: "none",
              border: "none",
              padding: 0,
              fontSize: 11,
              fontWeight: 650,
              color: "var(--accent)",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {t("Reset")}
          </button>
        </div>
      )}
      {spending.length === 0 && <div style={{ fontSize: 12.5, color: C.mute, padding: "8px 0" }}>{t("No spending in this period.")}</div>}
      {shown.map((r) => {
        const isExcluded = excluded.has(r.key);
        const isSelected = effectiveSelectedKey === r.key;
        const color = rowColor(r.key);
        const baseline = spBaseline.get(r.key) ?? 0;
        const delta = baseline > 0 ? (r.amount - baseline) / baseline : null;
        const share = !isExcluded && spTotal > 0 ? `${((r.amount / spTotal) * 100).toFixed(1)}%` : null;
        const barPct = isExcluded ? 0 : (r.amount / spTop) * 100;
        return (
          <div
            key={r.key ?? "none"}
            style={{
              marginBottom: 12,
              marginLeft: isSelected ? -8 : 0,
              marginRight: isSelected ? -8 : 0,
              padding: isSelected ? "6px 8px" : 0,
              borderRadius: isSelected ? 10 : 0,
              border: `1px solid ${isSelected ? "var(--accent)" : "transparent"}`,
              background: isSelected ? "var(--accent-1a)" : "transparent",
              opacity: isExcluded ? 0.45 : 1,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                onClick={() => !isExcluded && r.key !== null && setSelectedKey((k) => (k === r.key ? null : r.key))}
                /* The unassigned (null-key) row deliberately opens no card (see the docstring), so
                   it must not advertise clickability either — a pointer cursor on a press that
                   does nothing reads as breakage. */
                disabled={r.key === null}
                style={{
                  flex: 1,
                  minWidth: 0,
                  textAlign: "left",
                  background: "none",
                  border: "none",
                  padding: 0,
                  cursor: isExcluded || r.key === null ? "default" : "pointer",
                  fontFamily: "inherit",
                }}
              >
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
                      textDecoration: isExcluded ? "line-through" : "none",
                    }}
                  >
                    <span aria-hidden style={{ width: 8, height: 8, borderRadius: 3, background: color, flexShrink: 0 }} />
                    {dimNullLabel(r.name, dim, t)}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 650, color: C.text, fontVariantNumeric: "tabular-nums", flexShrink: 0, marginLeft: 8 }}>
                    {share ? `${M(r.amount)} · ${share}` : M(r.amount)}
                  </span>
                </div>
                <Bar pct={barPct} color={color} />
              </button>
              <button
                onClick={() =>
                  setExcluded((prev) => {
                    const next = new Set(prev);
                    if (next.has(r.key)) next.delete(r.key);
                    else next.add(r.key);
                    return next;
                  })
                }
                title={isExcluded ? t("Include again") : t("Exclude from the total")}
                aria-label={isExcluded ? t("Include again") : t("Exclude from the total")}
                /* Explicit 30x30 hit target (the reportKit month-nav pattern) — the padding-derived
                   box measured 19x24 in a live render, and a mis-tap on a narrow toggle lands on
                   the adjacent full-width row button and opens the card instead of excluding. */
                style={{
                  flexShrink: 0,
                  width: 30,
                  height: 30,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "none",
                  border: "none",
                  fontSize: 10.5,
                  color: C.mute,
                  padding: 0,
                  cursor: "pointer",
                }}
              >
                {isExcluded ? "↩" : "✕"}
              </button>
            </div>
            {range === 1 && !isExcluded && (
              <div style={{ textAlign: "right", marginTop: 2, fontSize: 11, color: C.soft }}>
                <DeltaTag pct={delta} /> {t("vs 3 mo")}
              </div>
            )}
          </div>
        );
      })}
      {!expanded && restCount > 0 && (
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
          {tp("+ {n} more · {amount} | + {n} more · {amount}", restCount, { amount: M(restAmount) })}
        </button>
      )}
      {effectiveSelectedKey !== null &&
        detail &&
        (() => {
          // Non-null by construction: this IIFE only runs inside the `effectiveSelectedKey !==
          // null` branch above, but TS narrowing doesn't cross the closure boundary on its own.
          const key = effectiveSelectedKey!;
          const row = spending.find((r) => r.key === key)!;
          const baseline = spBaseline.get(key) ?? 0;
          const delta = baseline > 0 ? (detail.amount - baseline) / baseline : null;
          const subRows = detail.rows.slice(0, 5);
          const subTop = Math.max(...subRows.map((r) => r.amount), 1);
          const moreCount = detail.rows.length - subRows.length;
          const rowC = rowColor(key);
          return (
            <div
              style={{
                background: C.bg,
                border: `1px solid ${C.line}`,
                borderRadius: 12,
                padding: "11px 12px",
                display: "flex",
                flexDirection: "column",
                gap: 7,
                marginBottom: 12,
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span aria-hidden style={{ width: 9, height: 9, borderRadius: 3, background: rowC, flexShrink: 0 }} />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 12.5,
                    fontWeight: 700,
                    color: C.text,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {dimNullLabel(row.name, dim, t)}
                </span>
                {range === 1 && <DeltaTag pct={delta} />}
                <button
                  onClick={() => setSelectedKey(null)}
                  aria-label={t("Close details")}
                  title={t("Close details")}
                  /* Same 30x30 floor as the row toggle above — the padded box measured 13x13. */
                  style={{
                    flexShrink: 0,
                    width: 30,
                    height: 30,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    background: "none",
                    border: "none",
                    padding: 0,
                    fontSize: 11,
                    color: C.mute,
                    cursor: "pointer",
                  }}
                >
                  ✕
                </button>
              </div>
              <div style={{ fontSize: 10, fontWeight: 750, letterSpacing: "0.14em", textTransform: "uppercase", color: C.mute }}>
                {detail.subDim === "place" ? t("By place") : t("By envelope")}
              </div>
              {subRows.map((r) => (
                <div key={r.key ?? "none"} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11.5, color: C.text }}>
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {dimNullLabel(r.name, detail.subDim, t)}
                    </span>
                    <b style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{M(r.amount)}</b>
                  </div>
                  <Bar pct={(r.amount / subTop) * 100} color={rowC} />
                </div>
              ))}
              {moreCount > 0 && <div style={{ fontSize: 10, color: C.mute }}>{tp("+ {n} more | + {n} more", moreCount)}</div>}
              <div style={{ fontSize: 10, color: C.soft, borderTop: `1px solid ${C.line}`, paddingTop: 6, fontVariantNumeric: "tabular-nums" }}>
                {tp("{n} transaction · avg {avg} · largest {largest} | {n} transactions · avg {avg} · largest {largest}", detail.txnCount, {
                  avg: M(detail.avgAmount),
                  largest: M(detail.largestAmount),
                })}
              </div>
              {range === 1 && (
                <button
                  onClick={() => handleOpenTxns(key)}
                  style={{
                    alignSelf: "flex-start",
                    background: "none",
                    border: "none",
                    padding: 0,
                    fontSize: 10.5,
                    fontWeight: 650,
                    color: "var(--accent)",
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  {t("Open transactions ›")}
                </button>
              )}
            </div>
          );
        })()}
    </ReportShell>
  );
}
