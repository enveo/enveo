import { computeGoalHistory } from "@enveo/shared";
import { GoalRing, useBand } from "../../components/kit";
import { Bar, ReportShell } from "../../components/reportKit";
import type { StateResponse } from "../../lib/api";
import { useTheme } from "../../lib/contexts";
import { monthLabel, monthShortLabel } from "../../lib/dates";
import { goalProgress } from "../../lib/goals";
import { useT } from "../../lib/i18n";
import { store } from "../../lib/store";
import { TEAL, tint } from "../../lib/theme";
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
 * 0` guard keeps a budget with zero goals from reading as a false "All funded ✓".
 *
 * Reports-3f Task 1 (this rebuild): each row is now a bordered card, display-only — the per-card
 * "Fill" write + undo toast is Task 2, not here.
 * - Leads with a `GoalRing` (40px) + envelope name + a bare `{funded} of {target}` line (no
 *   "this month" suffix — the screen is month-navigable via `onPrev`/`onNext`, so a trailing
 *   "this month"/hardcoded month name would go stale the instant the viewer moves off the live
 *   month; the screen's own header already names the viewed month).
 * - A progress track (`Bar`) whose tooltip DOES name the viewed month via `monthLabel` (nominative,
 *   no case-governing preposition — "so far" is a label, not "in {month}").
 * - Six month chips built from `computeGoalHistory` (oldest→newest, always the last 6 months
 *   ending at the viewed one) — met ⇒ pos-tinted "✓", the current (last) chip ⇒ accent-tinted
 *   with its live %, everything else ⇒ neutral chip fill with its ended-at %. Each chip's tooltip
 *   is one whole phrase per state (met / current / past-unmet) rather than glued fragments.
 * - A "Met in N of 5 months …" caption (the 6th, current, chip is excluded — it hasn't ended yet)
 *   and, once for the whole list (not per card), the mandatory basis caption: past months are
 *   judged against TODAY's target (`computeGoalHistory`'s `basis: "current-target"`), so editing a
 *   goal rewrites its own history rather than only affecting months going forward.
 *
 * `computeGoalHistory` needs the raw ledger (`ClientLedger`), not `state: StateResponse` — it
 * re-derives `computeBudgetState` per past month, which the state prop's single month cannot give
 * it. `store.getLedger()` is nullable (replica not yet booted); the whole per-card section derives
 * from a single `ledger !== null` check up front (mirrors `BudgetsReport`'s `coverStep`), and each
 * row ALSO guards `computeGoalHistory`'s own `| null` return (an envelope whose live ledger view
 * has diverged from the `state` snapshot this render started from) by skipping just that card
 * rather than crashing — both cases degrade to the existing empty-state copy / a shorter list,
 * never a thrown error. `gp` (`goalProgress(e)`, sourced from `state`, unchanged) still drives the
 * ring/track/status — `history.points.at(-1)` is proven to agree with it
 * (`reports.test.ts`: "agrees with goalProgress for the current month"), so the current chip is
 * never a second, potentially-divergent computation of the same number.
 *
 * Ring/track colour is the funded-status convention already shipped here (`C.pos` once funded,
 * `TEAL`/accent otherwise) — not the design mockup's per-envelope identity colour. That's a
 * deliberate call for this codebase (`BudgetRow`'s bars are status-colored too; envelope colour is
 * reserved for small identity swatches), confirmed by the controller for this slice.
 *
 * The aggregate "fill everything" action moves out of the band `sub` and into the body, after the
 * card list and before the no-goal footer, per the design's own placement — and its copy changes
 * from "Fill ›" to "Fill all goals ›" to match. That rename orphans the old key's existing Polish
 * translation, so `pl.ts` carries BOTH the removal of the stale entry and a fresh translation of
 * the new one in this same commit (the other nine new keys this rebuild introduces are brand-new
 * copy with no prior translation to protect, and ship untranslated per the slice's own ruling — a
 * consolidated pass covers them before the next prod deploy).
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
  const { t, tp, lang } = useT();
  const { hc } = useBand();
  const ledger = store.getLedger();
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
  // The one guard every per-card computation below depends on (see doc comment). When it trips,
  // the screen shows exactly the same copy as "no goals at all" rather than a half-built list.
  const canRenderCards = ledger !== null && rows.length > 0;
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
          t("{amount} to go", { amount: M(missSum) })
        )
      }
    >
      {!canRenderCards && (
        <div style={{ fontSize: 12.5, color: C.mute, padding: "8px 0" }}>{t("No envelopes with a goal. Set a monthly target when editing an envelope.")}</div>
      )}
      {canRenderCards && (
        <>
          <div style={{ fontSize: 10.5, color: C.mute, marginBottom: 10 }}>
            {t("Past months are judged against today's target — changing a goal rewrites its history.")}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {rows.map(({ e, gp }) => {
              const history = computeGoalHistory(ledger, e.id, state.month, 6);
              if (!history) return null; // diverged from `state` since this render started — skip, don't crash
              const fundedAmt = Math.min(Math.max(0, e.allocated), e.monthlyTarget ?? 0);
              const barColor = gp.funded ? C.pos : TEAL;
              return (
                <div
                  key={e.id}
                  style={{ border: `1px solid ${C.line}`, borderRadius: 14, padding: "13px 14px", display: "flex", flexDirection: "column", gap: 10 }}
                >
                  <button
                    onClick={() => onOpenEnvelope(e.id, state.month)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 11,
                      width: "100%",
                      background: "none",
                      border: "none",
                      padding: 0,
                      cursor: "pointer",
                      textAlign: "left",
                      fontFamily: "inherit",
                    }}
                  >
                    <GoalRing pct={gp.pct} size={40} color={barColor} />
                    <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
                      <span
                        style={{
                          fontSize: 13.5,
                          fontWeight: 650,
                          color: C.text,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {e.name}
                      </span>
                      <span style={{ fontSize: 11, color: C.mute, fontVariantNumeric: "tabular-nums" }}>
                        {t("{funded} of {target}", { funded: M(fundedAmt), target: M(e.monthlyTarget ?? 0) })}
                      </span>
                    </span>
                  </button>
                  <div title={t("{month} so far: {pct}%", { month: monthLabel(state.month, lang), pct: Math.round(gp.pct) })}>
                    <Bar pct={gp.pct} color={barColor} />
                  </div>
                  <div style={{ display: "flex", gap: 5 }}>
                    {history.points.map((p, i) => {
                      const isCurrent = i === history.points.length - 1;
                      // TEAL is a CSS var (`var(--accent)`), not a hex string — `tint()` only accepts hex
                      // (BudgetsReport/SpendingReport/ImportSheet all call it with a real Theme hex like
                      // C.pos/C.warn). The accent tint has to come from the precomputed alpha CSS var
                      // instead (same family `heatColor` already uses); `--accent-22` (≈0.13 alpha) is the
                      // closest step to the 0.14 this chip's `met` sibling gets via `tint(C.pos, 0.14)`.
                      const bg = p.met ? tint(C.pos, 0.14) : isCurrent ? "var(--accent-22)" : C.chip;
                      const fg = p.met ? C.pos : isCurrent ? TEAL : C.soft;
                      const border = isCurrent ? TEAL : "transparent";
                      const label = p.met ? "✓" : `${Math.round(p.pct)}%`;
                      const title = p.met
                        ? t("{month} · goal fully funded ✓", { month: monthShortLabel(p.month, lang) })
                        : isCurrent
                          ? t("{month} · so far {pct}%", { month: monthShortLabel(p.month, lang), pct: Math.round(p.pct) })
                          : t("{month} · ended at {pct}% of the goal", { month: monthShortLabel(p.month, lang), pct: Math.round(p.pct) });
                      return (
                        <span
                          key={p.month}
                          title={title}
                          style={{
                            flex: 1,
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            gap: 1,
                            background: bg,
                            border: `1px solid ${border}`,
                            borderRadius: 7,
                            padding: "4px 0",
                          }}
                        >
                          <span style={{ fontSize: 8.5, color: C.mute }}>{monthShortLabel(p.month, lang)}</span>
                          <span style={{ fontSize: 10.5, fontWeight: 700, color: fg, fontVariantNumeric: "tabular-nums" }}>{label}</span>
                        </span>
                      );
                    })}
                  </div>
                  <span style={{ fontSize: 10, color: C.mute }}>
                    {t("Met in {n} of 5 months · ✓ = fully funded that month", { n: history.points.slice(0, -1).filter((p) => p.met).length })}
                  </span>
                </div>
              );
            })}
          </div>
          {canFillGoals && (
            <button
              onClick={onFillGoals}
              style={{
                display: "inline-flex",
                alignItems: "center",
                minHeight: 30,
                marginTop: 2,
                background: "none",
                border: "none",
                padding: "6px 0",
                font: "inherit",
                fontSize: 12.5,
                fontWeight: 600,
                color: TEAL,
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              {t("Fill all goals ›")}
            </button>
          )}
          {noGoalCount > 0 && (
            <div style={{ fontSize: 11, color: C.mute, padding: "6px 0 4px" }}>
              {tp(
                "+ {n} envelope without a goal — set one when editing an envelope. | + {n} envelopes without a goal — set one when editing an envelope.",
                noGoalCount,
              )}
            </div>
          )}
        </>
      )}
    </ReportShell>
  );
}
