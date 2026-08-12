import { type ReactNode, useState } from "react";
import { useBand } from "../../components/kit";
import { Bar, ReportShell } from "../../components/reportKit";
import type { StateResponse } from "../../lib/api";
import { useTheme } from "../../lib/contexts";
import { useT } from "../../lib/i18n";
import { classifyBudget } from "../../lib/reportSummary";
import { tint } from "../../lib/theme";
import { type Mask, TITLES } from "./types";

/** One envelope row shared by all four BudgetsReport sections (Overspent/Near/used-up/rest-ok):
 *  name + right-aligned status (colored per section), an optional caption line under the head
 *  (only the Overspent section uses it, for "spent X of Y"), then a progress `Bar`. Each section
 *  differs only in status text/color, caption presence and bar color/pct — pulled out here to
 *  kill four copies of the same button/head/name/bar markup. */
function BudgetRow({
  name,
  onClick,
  statusColor,
  status,
  caption,
  barPct,
  barColor,
}: {
  name: string;
  onClick: () => void;
  statusColor: string;
  status: ReactNode;
  caption?: ReactNode;
  barPct: number;
  barColor: string;
}) {
  const C = useTheme();
  return (
    <button
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        background: "none",
        border: "none",
        padding: "0 0 12px",
        cursor: "pointer",
        textAlign: "left" as const,
        fontFamily: "inherit",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" as const, gap: 8, marginBottom: 3 }}>
        <span style={{ fontSize: 13, color: C.text, overflow: "hidden" as const, textOverflow: "ellipsis" as const, whiteSpace: "nowrap" as const }}>
          {name}
        </span>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: statusColor, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{status}</span>
      </div>
      {caption != null && <div style={{ fontSize: 10.5, color: C.soft, marginBottom: 4 }}>{caption}</div>}
      <Bar pct={barPct} color={barColor} />
    </button>
  );
}

/**
 * "Budgets" tab (frame A3, triage): three sections — Overspent / Near limit / Within budget —
 * classified via `classifyBudget` (lib/reportSummary.ts), the SAME rule the hub's Budgets
 * mini-card uses via `budgetsSummary` — parity between hub and subscreen is the point of that
 * helper. The "amber-wall" fix: an envelope spent EXACTLY down to 100% (left === 0) has no room
 * left to overrun and reads as calm ("used up"), not a warning — near requires
 * `pct >= 80 && left > 0`.
 */
export function BudgetsReport({
  state,
  M,
  onOpenEnvelope,
  onPrev,
  onNext,
  onBack,
}: {
  state: StateResponse;
  M: Mask;
  onOpenEnvelope: (envId: string, month: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const C = useTheme();
  const { t, tp } = useT();
  const { hc } = useBand();
  const [expanded, setExpanded] = useState(false);

  const rows = state.envelopes
    .filter((e) => !e.archived && (e.allocated + e.carryIn > 0 || e.spent > 0))
    .map((e) => {
      const budget = Math.max(1, e.allocated + e.carryIn);
      const pct = (Math.max(0, e.spent) / budget) * 100;
      const left = e.available;
      return { e, pct, left, budget, status: classifyBudget(pct, left) };
    });
  const byPctDesc = (a: (typeof rows)[number], b: (typeof rows)[number]) => b.pct - a.pct || a.e.name.localeCompare(b.e.name);
  const overRows = rows.filter((r) => r.status === "over").sort(byPctDesc);
  const nearRows = rows.filter((r) => r.status === "near").sort(byPctDesc);
  const okRows = rows.filter((r) => r.status === "ok");
  // within "ok", pct can only be < 80 or exactly 100 (any pct in [80,100) is always "near" —
  // spent < budget there means left > 0 by construction) — so this isolates the used-up rows.
  const usedUpRows = okRows.filter((r) => r.pct >= 100);
  const restOkRows = okRows.filter((r) => r.pct < 100);
  const restAvgPct = restOkRows.length > 0 ? Math.round(restOkRows.reduce((s, r) => s + r.pct, 0) / restOkRows.length) : 0;
  const overspendTotal = overRows.reduce((s, r) => s + -r.left, 0);

  const pill = (label: string, swatch: string, key: string) => (
    <span
      key={key}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 11.5,
        fontWeight: 650,
        borderRadius: 9,
        padding: "4px 9px",
        background: hc(tint(C.headerInk, 0.13), C.chip),
        color: hc(C.headerInk, C.text),
      }}
    >
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: swatch, flexShrink: 0 }} />
      {label}
    </span>
  );
  return (
    <ReportShell
      title={t(TITLES.budgets)}
      month={state.month}
      onPrev={onPrev}
      onNext={onNext}
      onBack={onBack}
      eyebrow={overspendTotal > 0 ? t("Over budget") : t("Envelope budgets")}
      hero={
        overspendTotal > 0 ? (
          <span style={{ color: hc(C.headerNeg, C.neg) }}>−{M(overspendTotal)}</span>
        ) : (
          <span style={{ color: hc(C.headerPos, C.pos) }}>{t("All within budget")}</span>
        )
      }
      sub={overRows.length > 0 ? t("in {n} of {total} envelopes", { n: overRows.length, total: rows.length }) : undefined}
      bandChart={
        rows.length > 0 ? (
          <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
            {pill(tp("{n} over | {n} over", overRows.length), hc(C.headerNeg, C.neg), "over")}
            {/* no dedicated on-band amber token exists (headerWarn) — C.warn already reads fine on the navy band */}
            {pill(t("{n} near limit", { n: nearRows.length }), C.warn, "near")}
            {pill(t("{n} OK", { n: okRows.length }), hc(C.headerPos, C.pos), "ok")}
          </div>
        ) : undefined
      }
    >
      {rows.length === 0 && <div style={{ fontSize: 12.5, color: C.mute, padding: "8px 0" }}>{t("No envelopes with a budget or spending this month.")}</div>}

      {overRows.length > 0 && (
        <>
          <div style={{ fontSize: 10.5, fontWeight: 750, letterSpacing: "0.16em", textTransform: "uppercase", color: C.neg, margin: "4px 2px 8px" }}>
            {t("Overspent")}
          </div>
          {overRows.map(({ e, pct, left, budget }) => (
            <BudgetRow
              key={e.id}
              name={e.name}
              onClick={() => onOpenEnvelope(e.id, state.month)}
              statusColor={C.neg}
              status={`${Math.round(pct)}% · +${M(-left)}`}
              caption={t("spent {spent} of {budget}", { spent: M(Math.max(0, e.spent)), budget: M(budget) })}
              barPct={pct}
              barColor={C.neg}
            />
          ))}
        </>
      )}

      {nearRows.length > 0 && (
        <>
          <div style={{ fontSize: 10.5, fontWeight: 750, letterSpacing: "0.16em", textTransform: "uppercase", color: C.warn, margin: "18px 2px 8px" }}>
            {t("Near limit · ≥ 80%")}
          </div>
          {nearRows.map(({ e, pct, left }) => (
            <BudgetRow
              key={e.id}
              name={e.name}
              onClick={() => onOpenEnvelope(e.id, state.month)}
              statusColor={C.warn}
              status={`${Math.round(pct)}% · ${t("{amount} left", { amount: M(left) })}`}
              barPct={pct}
              barColor={C.warn}
            />
          ))}
        </>
      )}

      {(usedUpRows.length > 0 || restOkRows.length > 0) && (
        <>
          <div style={{ fontSize: 10.5, fontWeight: 750, letterSpacing: "0.16em", textTransform: "uppercase", color: C.mute, margin: "18px 2px 8px" }}>
            {t("Within budget")}
          </div>
          {usedUpRows.map(({ e, pct }) => (
            <BudgetRow
              key={e.id}
              name={e.name}
              onClick={() => onOpenEnvelope(e.id, state.month)}
              statusColor={C.soft}
              status={`${Math.round(pct)}% · ${t("used up")}`}
              barPct={100}
              barColor={C.mute}
            />
          ))}
          {restOkRows.length > 0 &&
            (expanded ? (
              restOkRows.map(({ e, pct, left }) => (
                <BudgetRow
                  key={e.id}
                  name={e.name}
                  onClick={() => onOpenEnvelope(e.id, state.month)}
                  statusColor={C.text}
                  status={`${Math.round(pct)}% · ${t("{amount} left", { amount: M(left) })}`}
                  barPct={pct}
                  barColor={e.color}
                />
              ))
            ) : (
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
                {tp("+ {n} envelope within budget (avg {pct}%) | + {n} envelopes within budget (avg {pct}%)", restOkRows.length, { pct: restAvgPct })}
              </button>
            ))}
        </>
      )}
    </ReportShell>
  );
}
