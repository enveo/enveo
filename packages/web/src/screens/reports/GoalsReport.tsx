import { computeGoalHistory, computeStateResponse } from "@enveo/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { GoalRing, useBand } from "../../components/kit";
import { Bar, ReportShell, UndoBar } from "../../components/reportKit";
import type { StateResponse } from "../../lib/api";
import { useTheme } from "../../lib/contexts";
import { currentMonth, monthLabel, monthShortLabel } from "../../lib/dates";
import { goalProgress } from "../../lib/goals";
import { haptic } from "../../lib/haptics";
import { useT } from "../../lib/i18n";
import { local } from "../../lib/mutate";
import { store } from "../../lib/store";
import { TEAL, tint } from "../../lib/theme";
import { type Mask, TITLES } from "./types";

/** One in-flight per-card "Fill" the toast can still undo — same shape/rule as
 *  `BudgetsReport.PendingUndo` (`previousAllocated` captured fresh right before the write, `month`
 *  pinned to the viewed month at press time so navigating away drops it rather than undoing into
 *  the wrong month). `amount`/`name` are the raw pieces this screen's own toast copy is built
 *  from — composed into `message` AT RENDER (below), never frozen at push time: same
 *  discreet-toggle-beside-an-open-report exposure as `BudgetsReport`'s fix (the wide shell's rail
 *  user menu, unreachable on phone). The shared `UndoBar` still only ever sees `{ id, message }`;
 *  the mapping happens where this state is handed to it. */
interface PendingGoalFill {
  id: string;
  amount: number;
  name: string;
  envelopeId: string;
  month: string;
  previousAllocated: number;
}

const GOAL_UNDO_TIMEOUT_MS = 6000;

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
 *
 * Reports-3f Task 2 (this commit): a per-card "Fill {amount} ›" quick action, mirroring
 * `BudgetsReport.coverStep`/`undoStep` exactly — immediate write + local undo toast, no
 * confirmation sheet (the controller ruling rejected a pre-scoped `FillGoalsSheet` for this).
 * - The amount shown ON the button is capped at the render-scope pool (`state.readyToAssign`,
 *   same as this file's existing `canFillGoals` gate) so the label never promises more than the
 *   pool can currently cover, and the button doesn't render at all once `fillable <= 0` — same
 *   "hidden, not merely disabled" rule as the aggregate action.
 * - The WRITE itself re-reads both `allocated` and `readyToAssign` fresh off the live ledger at
 *   press time (`store.getLedger()` → `computeStateResponse`), never the `state`/`gp` closure —
 *   the same rule `coverStep` already applies to `previousAllocated`, extended here to the pool
 *   cap too, since a card can sit rendered for a while before it's tapped.
 * - The undo toast is the shared `UndoBar` (`components/reportKit.tsx`) — this report's second
 *   consumer, promoted out of `BudgetsReport` in the prior commit on this branch.
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
  // One history per goal envelope, computed when the DATA or the viewed month changes — not on
  // every render. Each computeGoalHistory call runs six full-ledger computeBudgetState passes, so
  // recomputing N of them per render (every toast tick, every press) repeated the app's heaviest
  // derivation dozens of times for identical inputs. Still N x 6 passes on a real change — a
  // one-sweep-per-month shape would need a new shared helper; noted for a wide-shell perf pass.
  // Deps: `state` alone — it is rebuilt (new identity) whenever the ledger or the viewed month
  // changes, so it carries `ledger`/`rows` freshness; `ledger` itself is a mutable store
  // reference with no identity signal of its own. (exhaustive-deps is disabled repo-wide.)
  //
  // Pre-existing bug fixed here, found while verifying this task's UndoBar change in the
  // browser (not part of the wide-shell work otherwise): this `useMemo` used to sit ABOVE
  // `rows` and close over it anyway — `rows` is a `const`, so referencing it before its own
  // declaration statement runs is a temporal-dead-zone `ReferenceError`, thrown on every render
  // that reaches the non-empty-ledger branch (i.e. any real, booted session) regardless of
  // whether any envelope actually has a goal. No render-scope React test ever mounted this
  // component, so nothing caught it. Moving the block below `rows`'s declaration is a pure
  // reorder — same deps, same body, no behavior change once it can actually run.
  const histories = useMemo(() => {
    if (!ledger) return new Map<string, NonNullable<ReturnType<typeof computeGoalHistory>>>();
    const out = new Map<string, NonNullable<ReturnType<typeof computeGoalHistory>>>();
    for (const { e } of rows) {
      const h = computeGoalHistory(ledger, e.id, state.month, 6);
      if (h) out.set(e.id, h);
    }
    return out;
  }, [state]);
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

  const [pendingFills, setPendingFills] = useState<PendingGoalFill[]>([]);
  const fillTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const dismissFill = (id: string) => {
    const timer = fillTimers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      fillTimers.current.delete(id);
    }
    setPendingFills((prev) => prev.filter((u) => u.id !== id));
  };
  // Same "undo targets a specific month" rule as BudgetsReport: navigating away — including to a
  // different viewed month — drops every pending undo rather than risk applying it in a month the
  // user isn't looking at.
  useEffect(() => {
    return () => {
      for (const timer of fillTimers.current.values()) clearTimeout(timer);
      fillTimers.current.clear();
      setPendingFills([]);
    };
  }, [state.month]);

  // Mirrors `BudgetsReport.coverStep` exactly, extended per the controller ruling: BOTH
  // `allocated` and `readyToAssign` are re-read fresh off the live ledger at press time, never
  // the render-scope `state`/`gp` closure — a card can sit rendered a while before it's tapped,
  // and another write (this same action on a different card, a sync pull) can move the pool in
  // the meantime. `missing` (target − funded) is passed in from the render that produced this
  // card; the envelope's own `monthlyTarget` isn't something a fill action itself can change, so
  // re-deriving it fresh would guard nothing this slice's writes can actually invalidate.
  const fillOne = (envelopeId: string, envelopeName: string, missing: number) => {
    const ledger = store.getLedger();
    const live = ledger ? computeStateResponse(ledger, state.month) : null;
    if (!live) return;
    const envFresh = live.envelopes.find((x) => x.id === envelopeId);
    if (!envFresh || envFresh.archived) return; // vanished/archived since the card rendered
    const fillable = Math.max(0, Math.min(missing, live.readyToAssign));
    if (fillable <= 0) return; // defensive — the button is hidden in this case already
    const previousAllocated = envFresh.allocated;
    local.setDisplayedAllocation({ envelopeId, month: state.month, amount: previousAllocated + fillable });
    haptic([10, 30, 14]);
    const id = crypto.randomUUID();
    const timer = setTimeout(() => dismissFill(id), GOAL_UNDO_TIMEOUT_MS);
    fillTimers.current.set(id, timer);
    setPendingFills((prev) => [...prev, { id, amount: fillable, name: envelopeName, envelopeId, month: state.month, previousAllocated }]);
  };
  const undoFill = (u: PendingGoalFill) => {
    local.setDisplayedAllocation({ envelopeId: u.envelopeId, month: u.month, amount: u.previousAllocated });
    haptic(8);
    dismissFill(u.id);
  };

  return (
    <>
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
                const history = histories.get(e.id);
                if (!history) return null; // diverged from `state` since this render started — skip, don't crash
                const fundedAmt = Math.min(Math.max(0, e.allocated), e.monthlyTarget ?? 0);
                const barColor = gp.funded ? C.pos : TEAL;
                // Pool-capped display amount only — the WRITE re-reads both sides of this `Math.min`
                // fresh at press time (see `fillOne`'s own comment). Hidden entirely (not disabled)
                // once the pool can't cover anything, same as the aggregate `canFillGoals` button.
                const fillable = Math.max(0, Math.min(gp.missing, state.readyToAssign));
                return (
                  <div
                    key={e.id}
                    style={{ border: `1px solid ${C.line}`, borderRadius: 14, padding: "13px 14px", display: "flex", flexDirection: "column", gap: 10 }}
                  >
                    {/* The envelope-open button and the Fill action are SIBLINGS sharing one row —
                     never nested, buttons can't nest — so the open target stays the ring+name+
                     amount block while Fill gets its own independent hit target beside it. */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <button
                        onClick={() => onOpenEnvelope(e.id, state.month)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 11,
                          flex: 1,
                          minWidth: 0,
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
                      {fillable > 0 && (
                        <button
                          onClick={() => fillOne(e.id, e.name, gp.missing)}
                          title={t("Move the missing amount from To be budgeted into this envelope")}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            flexShrink: 0,
                            minHeight: 30,
                            fontSize: 11,
                            fontWeight: 700,
                            color: TEAL,
                            border: `1px solid ${TEAL}`,
                            borderRadius: 8,
                            padding: "5px 10px",
                            background: "none",
                            cursor: "pointer",
                            fontFamily: "inherit",
                          }}
                        >
                          {t("Fill {amount} ›", { amount: M(fillable) })}
                        </button>
                      )}
                    </div>
                    <div
                      title={
                        state.month === currentMonth()
                          ? t("{month} so far: {pct}%", { month: monthLabel(state.month, lang), pct: Math.round(gp.pct) })
                          : t("{month} · ended at {pct}% of the goal", { month: monthLabel(state.month, lang), pct: Math.round(gp.pct) })
                      }
                    >
                      <Bar pct={gp.pct} color={barColor} />
                    </div>
                    <div style={{ display: "flex", gap: 5 }}>
                      {history.points.map((p, i) => {
                        // "Current" = the LIVE calendar month, not merely the last chip of the
                        // window: browsing a past month must not caption an ended month "so far".
                        const isCurrent = i === history.points.length - 1 && p.month === currentMonth();
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
      {/* Composed HERE, not at push time (see `PendingGoalFill`'s docstring) — `M`/`t` re-read on
          every render so a discreet-mode toggle while this toast is showing re-masks it. */}
      <UndoBar
        pending={pendingFills.map((p) => ({ ...p, message: t("Filled {amount} in {name}", { amount: M(p.amount), name: p.name }) }))}
        onUndo={undoFill}
        onDismiss={dismissFill}
      />
    </>
  );
}
