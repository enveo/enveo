import { GoalRing, useBand } from "../../components/kit";
import { Bar, ReportShell } from "../../components/reportKit";
import type { StateResponse } from "../../lib/api";
import { useTheme } from "../../lib/contexts";
import { goalProgress } from "../../lib/goals";
import { useT } from "../../lib/i18n";
import { TEAL } from "../../lib/theme";
import { type Mask, TITLES } from "./types";

/**
 * "Goals" tab (Gabinet grammar, no dedicated mockup frame — follows A2/A3): envelopes with a
 * monthly goal (monthlyTarget > 0), sorted ascending by %, then name — math EXCLUSIVELY via
 * `goalProgress`, zero duplication in the component. Eyebrow reads "Monthly goals" rather than
 * "Goals", which just repeated the screen title above it.
 *
 * Task P1 fix: the hero used to be the whole SENTENCE ("All goals funded ✓") at 30px, which wraps
 * to two clunky lines on the band for anything but the shortest locale. The hero is now the bare
 * aggregate NUMBER (`{pctTotal}%`); the verdict sentence moved to the sub — "All goals funded ✓"
 * in pos colors when every goal is funded, else the existing "{amount} to go". The `rows.length >
 * 0` guard keeps a budget with zero goals from reading as a false "All funded ✓" (nothing to fund
 * is not the same claim as everything funded); it instead shows a neutral 0% hero, no sub, and the
 * existing empty-state copy in the body.
 *
 * Each row leads with a `GoalRing` (kit.tsx) mirroring the hub card — now colored `C.pos` once
 * funded, via the ring's new `color` prop — and gets a new muted sub-line under the envelope name
 * with the bare masked amounts (`funded / target`, no wording: a money pair reads fine without
 * connecting words and stays locale-neutral, unlike the "monthly goal: …" key tiles.tsx uses
 * elsewhere, which carries a label prefix this row doesn't need). Below all rows, a muted footer
 * counts envelopes that have NO goal at all — those are invisible in the list above (goalProgress
 * returns null for them), so without this line a user with mostly goal-less envelopes would have
 * no idea more exist; hidden entirely when there is nothing to fold (rows.length === 0, since the
 * empty-state message already covers that case; noGoalCount === 0).
 */
export function GoalsReport({
  state,
  M,
  onOpenEnvelope,
  onFillGoals,
  onPrev,
  onNext,
  onBack,
}: {
  state: StateResponse;
  M: Mask;
  onOpenEnvelope: (envId: string, month: string) => void;
  onFillGoals: () => void;
  onPrev: () => void;
  onNext: () => void;
  onBack: () => void;
}) {
  const C = useTheme();
  const { t, tp } = useT();
  const { hc } = useBand();
  const active = state.envelopes.filter((e) => !e.archived);
  const rows = active
    .flatMap((e) => {
      const gp = goalProgress(e);
      return gp ? [{ e, gp }] : [];
    })
    .sort((a, b) => a.gp.pct - b.gp.pct || a.e.name.localeCompare(b.e.name));
  const noGoalCount = active.length - rows.length;
  const fundedSum = rows.reduce((s, { e }) => s + Math.min(Math.max(0, e.allocated), e.monthlyTarget ?? 0), 0);
  const targetSum = rows.reduce((s, { e }) => s + (e.monthlyTarget ?? 0), 0);
  const pctTotal = targetSum > 0 ? Math.round((fundedSum / targetSum) * 100) : 0;
  const missSum = rows.reduce((s, { gp }) => s + gp.missing, 0);
  const allFunded = rows.length > 0 && missSum === 0;
  // Same entry-visibility predicate as Budget's "Fill by goals" button — a pool to place
  // AND at least one goal still short (missSum > 0 already implies the latter).
  const canFillGoals = state.readyToAssign > 0 && missSum > 0;
  return (
    <ReportShell
      title={t(TITLES.goals)}
      month={state.month}
      onPrev={onPrev}
      onNext={onNext}
      onBack={onBack}
      eyebrow={t("Monthly goals")}
      hero={`${pctTotal}%`}
      sub={
        rows.length === 0 ? undefined : allFunded ? (
          <span style={{ color: hc(C.headerPos, C.pos) }}>{t("All goals funded ✓")}</span>
        ) : (
          <>
            {t("{amount} to go", { amount: M(missSum) })}
            {canFillGoals && (
              <>
                {" · "}
                <button
                  onClick={onFillGoals}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    margin: 0,
                    font: "inherit",
                    color: hc(C.headerInk, TEAL),
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  {t("Fill ›")}
                </button>
              </>
            )}
          </>
        )
      }
    >
      {rows.length === 0 && (
        <div style={{ fontSize: 12.5, color: C.mute, padding: "8px 0" }}>{t("No envelopes with a goal. Set a monthly target when editing an envelope.")}</div>
      )}
      {rows.map(({ e, gp }) => {
        const barColor = gp.funded ? C.pos : "var(--accent)";
        const fundedAmt = Math.min(Math.max(0, e.allocated), e.monthlyTarget ?? 0);
        return (
          <button
            key={e.id}
            onClick={() => onOpenEnvelope(e.id, state.month)}
            style={{
              display: "block",
              width: "100%",
              background: "none",
              border: "none",
              padding: "0 0 12px",
              cursor: "pointer",
              textAlign: "left",
              fontFamily: "inherit",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 3 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    fontSize: 13,
                    color: C.text,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  <GoalRing pct={gp.pct} size={16} color={gp.funded ? C.pos : undefined} />
                  {e.name}
                </div>
                {/* Bare masked amounts, slash-joined — no i18n key: a money pair reads fine with no
                   connecting words, and gluing one on would just force English word order. */}
                <div style={{ fontSize: 10.5, color: C.mute, marginTop: 2 }}>
                  {M(fundedAmt)} / {M(e.monthlyTarget ?? 0)}
                </div>
              </div>
              <span style={{ textAlign: "right", flexShrink: 0 }}>
                <span style={{ display: "block", fontSize: 12.5, fontWeight: 700, color: gp.funded ? C.pos : C.text, fontVariantNumeric: "tabular-nums" }}>
                  {Math.round(gp.pct)}%
                </span>
                <span style={{ display: "block", fontSize: 10.5, color: gp.funded ? C.pos : C.soft, fontVariantNumeric: "tabular-nums" }}>
                  {gp.funded ? t("funded ✓") : t("{amount} to go", { amount: M(gp.missing) })}
                </span>
              </span>
            </div>
            <Bar pct={gp.pct} color={barColor} />
          </button>
        );
      })}
      {rows.length > 0 && noGoalCount > 0 && (
        <div style={{ fontSize: 11, color: C.mute, padding: "6px 0 4px" }}>
          {tp(
            "+ {n} envelope without a goal — set one when editing an envelope. | + {n} envelopes without a goal — set one when editing an envelope.",
            noGoalCount,
          )}
        </div>
      )}
    </ReportShell>
  );
}
