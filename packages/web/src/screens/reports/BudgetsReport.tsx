import { computeStateResponse } from "@enveo/shared";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useBand } from "../../components/kit";
import { Bar, ReportShell } from "../../components/reportKit";
import type { StateResponse } from "../../lib/api";
import { useTheme } from "../../lib/contexts";
import { todayISO } from "../../lib/dates";
import { haptic } from "../../lib/haptics";
import { useT } from "../../lib/i18n";
import { local } from "../../lib/mutate";
import { type BudgetStep, budgetPace, budgetRowPresentation, budgetSteps, budgetUsage, compareBudgetUsageRows, monthProgress } from "../../lib/reportSummary";
import { store } from "../../lib/store";
import { font, TEAL, tint } from "../../lib/theme";
import { PHONE_COL } from "../../lib/viewMode";
import { type Mask, TITLES } from "./types";

/** One in-flight "Cover"/"Top up" the checklist can still undo. Captured entirely at press time —
 *  `previousAllocated` is the fresh `allocated` read right before the write, so undo is just
 *  writing that same number back through the same absolute-amount API (no inverse op needed). */
interface PendingUndo {
  id: string;
  envelopeId: string;
  /** The month the write targeted — always the VIEWED month at press time, never re-derived later. */
  month: string;
  envelopeName: string;
  kind: BudgetStep["kind"];
  /** The amount actually moved (`step.fundable`, already capped at the pool). */
  amount: number;
  previousAllocated: number;
}

const UNDO_TIMEOUT_MS = 6000;

/**
 * The checklist's own undo toast — deliberately LOCAL to this screen, not "the app's toast
 * system" (there isn't one yet; see the task-3 brief). Promoting this to a shared component is a
 * separate decision for whenever a second consumer needs one.
 *
 * Rendered via createPortal(document.body): a CSS `transform` on an ancestor (this screen's `fi`
 * entrance, sheet animations elsewhere) breaks `position: fixed` descendants (known pitfall).
 *
 * Stacks rather than replacing or queuing one at a time: covering two steps in quick succession
 * must not silently lose either captured undo value or risk applying one to the wrong envelope,
 * and a queue would delay the second toast behind the first — exactly the multi-click flow this
 * checklist exists to speed up. Newest goes on top; each entry dismisses independently.
 */
function UndoStack({ pending, onUndo, onDismiss, M }: { pending: PendingUndo[]; onUndo: (u: PendingUndo) => void; onDismiss: (id: string) => void; M: Mask }) {
  const { t } = useT();
  if (pending.length === 0) return null;
  return createPortal(
    <div
      style={{
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
      }}
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
          <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>
            {u.kind === "over"
              ? t("Covered {amount} in {name}", { amount: M(u.amount), name: u.envelopeName })
              : t("Topped up {amount} in {name}", { amount: M(u.amount), name: u.envelopeName })}
          </span>
          <button
            onClick={() => onUndo(u)}
            style={{
              border: "none",
              background: "#fff",
              color: TEAL,
              borderRadius: 8,
              padding: "6px 12px",
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
            style={{ border: "none", background: "transparent", color: "#fff", fontSize: 16, cursor: "pointer", lineHeight: 1, padding: 4 }}
          >
            ×
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

/** One envelope row shared by the checklist's collapsed "healthy" list: name + right-aligned
 *  status (colored per section), then a progress `Bar`. An ignored step's envelope renders here
 *  too (still counted "healthy" for the ring/headline) at reduced `opacity` with a muted bar and
 *  a restore chip (`onRestore`) — the ONLY row renderer this screen has; the numbered checklist
 *  cards above it are a different shape entirely and are not built from this component. */
function BudgetRow({
  name,
  onClick,
  statusColor,
  status,
  barPct,
  barColor,
  opacity = 1,
  onRestore,
}: {
  name: string;
  onClick: () => void;
  statusColor: string;
  status: ReactNode;
  barPct: number;
  barColor: string;
  opacity?: number;
  onRestore?: () => void;
}) {
  const C = useTheme();
  const { t } = useT();
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8, opacity, padding: "0 0 12px" }}>
      <button
        onClick={onClick}
        style={{
          display: "block",
          flex: 1,
          minWidth: 0,
          background: "none",
          border: "none",
          padding: 0,
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
        <Bar pct={barPct} color={barColor} />
      </button>
      {onRestore != null && (
        <button
          onClick={onRestore}
          title={t("This step was ignored — click to bring it back")}
          style={{
            flexShrink: 0,
            marginTop: 2,
            cursor: "pointer",
            fontSize: 9.5,
            fontWeight: 700,
            letterSpacing: "0.06em",
            textTransform: "uppercase" as const,
            color: C.warn,
            background: tint(C.warn, 0.14),
            border: "none",
            borderRadius: 5,
            padding: "2px 6px",
            fontFamily: "inherit",
          }}
        >
          {t("ignored ↩")}
        </button>
      )}
    </div>
  );
}

/**
 * "Budgets" tab (frame A3, checklist rebuild — spec 2026-08-21): the screen stops being a passive
 * triage and becomes a fix-it list. A health ring + headline summarize the plan; numbered steps
 * (Overspent first, then pace risks, then near-limit top-ups — `budgetSteps` orders them) are
 * what's actionable RIGHT NOW; everything else — including a step the human dismissed with
 * "Ignore" — collapses into one "N healthy envelopes" disclosure using the pre-existing
 * `BudgetRow`. The band above (`ReportShell`'s eyebrow/hero/sub/pills) is untouched: it still
 * classifies via `budgetUsage` alone, the same threshold `budgetsSummary` uses for the hub's
 * mini-card — parity between hub and subscreen is the whole point of that helper, and the new
 * pace-aware "risk" bucket only ever narrows the checklist below, never the band's counts.
 *
 * "Ignore" is local component state only (`Set<string>` of envelope ids) — deliberately not
 * persisted; the next month's numbers are different anyway (see the memoed product decision on
 * the 20% near-limit cushion and the silent-carry-in-overspend case).
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
  const { t, tp, lang } = useT();
  const { hc } = useBand();
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);
  const [pendingUndos, setPendingUndos] = useState<PendingUndo[]>([]);
  const undoTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismissUndo = (id: string) => {
    const timer = undoTimers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      undoTimers.current.delete(id);
    }
    setPendingUndos((prev) => prev.filter((u) => u.id !== id));
  };

  // A pending undo targets a specific month (whichever was viewed when the button was pressed).
  // Navigating to a different month — or away from this screen entirely (unmount runs the same
  // cleanup) — drops every pending undo: undoing it there would move money in a month the user
  // isn't looking at (the same "account balances are global, envelopes are monthly" rule, applied
  // to a pending write instead of a read).
  useEffect(() => {
    return () => {
      for (const timer of undoTimers.current.values()) clearTimeout(timer);
      undoTimers.current.clear();
      setPendingUndos([]);
    };
  }, [state.month]);

  // Re-reads `allocated` FRESH from the live replica at press time (FillGoalsSheet's pattern,
  // exactly) — the `state` prop may already be a render behind the outbox. `previousAllocated`
  // is captured BEFORE the write so undo can restore it verbatim through the same absolute-amount
  // API — no inverse op, nothing new in the outbox to reason about.
  const coverStep = (step: BudgetStep) => {
    if (step.fundable <= 0) return; // defensive — the button is already disabled in this case
    const ledger = store.getLedger();
    const live = ledger ? computeStateResponse(ledger, state.month) : null;
    const envFresh = live?.envelopes.find((e) => e.id === step.envelopeId);
    if (!envFresh || envFresh.archived) return; // vanished/archived since the checklist rendered
    const previousAllocated = envFresh.allocated;
    local.setDisplayedAllocation({ envelopeId: step.envelopeId, month: state.month, amount: previousAllocated + step.fundable });
    haptic([10, 30, 14]);

    const id = crypto.randomUUID();
    const timer = setTimeout(() => dismissUndo(id), UNDO_TIMEOUT_MS);
    undoTimers.current.set(id, timer);
    setPendingUndos((prev) => [
      ...prev,
      { id, envelopeId: step.envelopeId, month: state.month, envelopeName: step.name, kind: step.kind, amount: step.fundable, previousAllocated },
    ]);
  };

  const undoStep = (u: PendingUndo) => {
    // Absolute write, not a delta: restores the exact `allocated` captured right before covering.
    // If something else changed this envelope's allocation in the meantime, this still wins —
    // last-write-wins, same as every other manual allocation edit.
    local.setDisplayedAllocation({ envelopeId: u.envelopeId, month: u.month, amount: u.previousAllocated });
    haptic(8);
    dismissUndo(u.id);
  };

  const rows = state.envelopes
    .filter((e) => !e.archived && (e.allocated + e.carryIn > 0 || e.spent > 0))
    .map((e) => {
      const usage = budgetUsage(e);
      return { e, name: e.name, ...usage, presentation: budgetRowPresentation(usage) };
    });
  const rowById = new Map(rows.map((r) => [r.e.id, r]));

  // Band pills/hero: unchanged threshold classification (parity with budgetsSummary — do not
  // reclassify these via budgetPace's "risk" bucket, which only feeds the checklist below).
  const overRows = rows.filter((r) => r.status === "over");
  const nearRows = rows.filter((r) => r.status === "near");
  const okRows = rows.filter((r) => r.status === "ok");
  const overspendTotal = overRows.reduce((s, r) => s + -r.left, 0);

  const progress = monthProgress(state.month, todayISO());
  const budgetedCount = rows.length;
  const steps = budgetSteps(state.envelopes, progress, { ignored, readyToAssign: state.readyToAssign });
  const openSteps = steps.filter((s) => !s.ignored);
  const openIds = new Set(openSteps.map((s) => s.envelopeId));
  const ignoredIds = new Set(steps.filter((s) => s.ignored).map((s) => s.envelopeId));
  const healthyCount = budgetedCount - openSteps.length;

  const compareNames = new Intl.Collator(lang).compare;
  const healthyRows = rows
    .filter((r) => !openIds.has(r.e.id))
    .map((r) => ({ ...r, isIgnored: ignoredIds.has(r.e.id) }))
    .sort((a, b) => compareBudgetUsageRows(a, b, compareNames));
  const ignoredCount = healthyRows.filter((r) => r.isIgnored).length;

  const denom = Math.max(1, budgetedCount);
  const overFrac = Math.round((openSteps.filter((s) => s.kind === "over").length / denom) * 100);
  const warnFrac = Math.round((openSteps.filter((s) => s.kind !== "over").length / denom) * 100);
  const ring = `conic-gradient(${C.neg} 0 ${overFrac}%, ${C.warn} ${overFrac}% ${overFrac + warnFrac}%, ${TEAL} ${overFrac + warnFrac}% 100%)`;

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
    <>
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

        {rows.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {/* Step 1: health ring + headline */}
            <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
              <span
                style={{
                  width: 46,
                  height: 46,
                  borderRadius: "50%",
                  background: ring,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    width: 33,
                    height: 33,
                    borderRadius: "50%",
                    background: C.card,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 10,
                    fontWeight: 750,
                    color: C.text,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {healthyCount}/{budgetedCount}
                </span>
              </span>
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
                <span style={{ fontSize: 13.5, fontWeight: 700, color: C.text }}>
                  {openSteps.length === 0
                    ? t("Plan closed — every envelope holds")
                    : tp("{n} of {m} envelope is healthy | {n} of {m} envelopes are healthy", healthyCount, { m: budgetedCount })}
                </span>
                <span style={{ fontSize: 11, color: C.soft }}>
                  {openSteps.length === 0
                    ? t("Nothing to fix right now ✓")
                    : tp("{n} step to a closed plan · {pct}% of the month gone | {n} steps to a closed plan · {pct}% of the month gone", openSteps.length, {
                        pct: Math.round(progress * 100),
                      })}
                </span>
              </div>
            </div>

            {/* Step 2: numbered steps — over, then risk, then near (budgetSteps' own order) */}
            {openSteps.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {openSteps.map((step, i) => {
                  const row = rowById.get(step.envelopeId)!;
                  const pace = budgetPace(row.e, progress);
                  const badgeColor = step.kind === "over" ? C.neg : C.warn;
                  const title =
                    step.kind === "over"
                      ? t("Cover the overspend in {name}", { name: step.name })
                      : step.kind === "risk"
                        ? t("Top up {name} — its pace will bust the budget", { name: step.name })
                        : t("Top up {name} — almost at the limit", { name: step.name });
                  const sub =
                    step.kind === "over"
                      ? t("{amount} from To be budgeted ({pool} available)", { amount: M(step.amount), pool: M(state.readyToAssign) })
                      : step.kind === "risk"
                        ? t("at this pace ≈ {projected} against a {budget} budget", { projected: M(pace.projected), budget: M(row.rawBudget) })
                        : t("{left} left · {pct}% of the budget spent", { left: M(row.left), pct: Math.round(row.pct ?? 0) });
                  const buttonLabel =
                    step.kind === "over" ? t("Cover {amount}", { amount: M(step.fundable) }) : t("Top up {amount}", { amount: M(step.fundable) });
                  const shortfall = step.fundable < step.amount;
                  const isLast = i === openSteps.length - 1;
                  return (
                    <div key={step.envelopeId} style={{ display: "flex", flexDirection: "column" }}>
                      <div style={{ display: "flex", gap: 11 }}>
                        <span
                          style={{
                            flexShrink: 0,
                            width: 22,
                            height: 22,
                            borderRadius: "50%",
                            background: badgeColor,
                            color: "#fff",
                            fontSize: 11,
                            fontWeight: 750,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          {i + 1}
                        </span>
                        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
                          <span style={{ fontSize: 12.5, color: C.text }}>{title}</span>
                          <span style={{ fontSize: 10.5, color: C.mute, fontVariantNumeric: "tabular-nums" }}>{sub}</span>
                          {shortfall && (
                            <span style={{ fontSize: 10.5, color: C.warn, fontVariantNumeric: "tabular-nums" }}>
                              {t("Only {fundable} of {amount} available in To be budgeted", { fundable: M(step.fundable), amount: M(step.amount) })}
                            </span>
                          )}
                          <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            {/* Real allocation, no confirmation (§4c) — the amount is already on the button, and an
                              allocation is reversible via the undo toast below. Only an empty pool (fundable===0)
                              disables it, and that case must read as visibly inert, not merely inactive on press. */}
                            <button
                              onClick={() => coverStep(step)}
                              disabled={step.fundable === 0}
                              style={{
                                cursor: step.fundable === 0 ? "default" : "pointer",
                                fontSize: 11,
                                fontWeight: 700,
                                color: step.kind === "over" ? "#fff" : TEAL,
                                background: step.kind === "over" ? C.neg : "transparent",
                                border: `1px solid ${step.kind === "over" ? C.neg : TEAL}`,
                                borderRadius: 8,
                                padding: "5px 11px",
                                opacity: step.fundable === 0 ? 0.45 : 1,
                                fontFamily: "inherit",
                              }}
                            >
                              {buttonLabel}
                            </button>
                            <button
                              onClick={() => setIgnored((prev) => new Set(prev).add(step.envelopeId))}
                              title={t("Dismiss this step for now")}
                              style={{
                                cursor: "pointer",
                                fontSize: 11,
                                fontWeight: 650,
                                color: C.soft,
                                background: "none",
                                border: `1px solid ${C.line}`,
                                borderRadius: 8,
                                padding: "5px 11px",
                                fontFamily: "inherit",
                              }}
                            >
                              {t("Ignore")}
                            </button>
                          </span>
                        </div>
                      </div>
                      {!isLast && <span style={{ display: "block", marginLeft: 10, width: 1.5, height: 12, background: C.line }} />}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Step 3: collapsed healthy list — includes ignored steps, flagged and restorable */}
            <div style={{ border: `1px solid ${C.line}`, borderRadius: 12, overflow: "hidden" }}>
              <button
                onClick={() => setExpanded((v) => !v)}
                style={{
                  display: "flex",
                  width: "100%",
                  alignItems: "center",
                  gap: 8,
                  padding: "10px 12px",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  textAlign: "left" as const,
                  fontFamily: "inherit",
                }}
              >
                <span aria-hidden style={{ width: 7, height: 7, borderRadius: "50%", background: C.pos, display: "block", flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 12, fontWeight: 650, color: C.text }}>
                  {ignoredCount > 0
                    ? tp("{n} healthy envelope · {ignored} ignored | {n} healthy envelopes · {ignored} ignored", healthyRows.length, { ignored: ignoredCount })
                    : tp("{n} healthy envelope | {n} healthy envelopes", healthyRows.length)}
                </span>
                <span style={{ fontSize: 11, color: C.mute }}>{expanded ? "▴" : "▾"}</span>
              </button>
              {expanded && (
                <div style={{ display: "flex", flexDirection: "column", padding: "2px 12px" }}>
                  {healthyRows.map((row) => {
                    const usedUp = row.status === "ok" && row.pct !== null && row.pct >= 100;
                    const pctText = row.presentation.percentage === null ? "—" : `${Math.round(row.presentation.percentage)}%`;
                    const status =
                      row.status === "over"
                        ? `${pctText} · +${M(row.presentation.overspend)}`
                        : row.status === "near"
                          ? `${pctText} · ${t("{amount} left", { amount: M(row.left) })}`
                          : usedUp
                            ? `${pctText} · ${t("used up")}`
                            : `${pctText} · ${t("{amount} left", { amount: M(row.left) })}`;
                    const statusColor = row.status === "over" ? C.neg : row.status === "near" ? C.warn : usedUp ? C.soft : C.text;
                    const barColor = row.isIgnored ? C.mute : usedUp ? C.mute : row.status === "over" ? C.neg : row.status === "near" ? C.warn : row.e.color;
                    return (
                      <BudgetRow
                        key={row.e.id}
                        name={row.e.name}
                        onClick={() => onOpenEnvelope(row.e.id, state.month)}
                        statusColor={statusColor}
                        status={status}
                        barPct={row.presentation.visualBarPct}
                        barColor={barColor}
                        opacity={row.isIgnored ? 0.65 : 1}
                        onRestore={
                          row.isIgnored
                            ? () =>
                                setIgnored((prev) => {
                                  const next = new Set(prev);
                                  next.delete(row.e.id);
                                  return next;
                                })
                            : undefined
                        }
                      />
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </ReportShell>
      <UndoStack pending={pendingUndos} onUndo={undoStep} onDismiss={dismissUndo} M={M} />
    </>
  );
}
