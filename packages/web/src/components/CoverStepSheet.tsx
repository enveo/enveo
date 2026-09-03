import { computeStateResponse } from "@enveo/shared";
import { type ReactNode, useEffect, useState } from "react";
import type { StateResponse } from "../lib/api";
import { useCurrency, useMask, useSettings, useTheme } from "../lib/contexts";
import { type CoverPlan, coverDonors, coverPlanStatus, POOL_SOURCE_ID, proposeCoverSources } from "../lib/coverSources";
import { currencySymbol, fmtTrim, isLight, localizePadExpression } from "../lib/format";
import { haptic } from "../lib/haptics";
import { useT } from "../lib/i18n";
import { Glyph } from "../lib/icons";
import { local } from "../lib/mutate";
import type { BudgetStep } from "../lib/reportSummary";
import { store } from "../lib/store";
import { CTA, font, TEAL } from "../lib/theme";
import { AmountPadHost, type AmountPadTarget } from "./AmountPadSheet";
import { Surface } from "./chrome";

/** One allocation write the caller can undo — the envelope and the exact `allocated` it had
 *  right before the sheet wrote it (absolute restore, same idiom as the checklist's undo). */
export interface CoverRestore {
  envelopeId: string;
  previousAllocated: number;
}

/**
 * "Cover from…" for one Budgets-checklist step: the pool ("To be budgeted") and every envelope
 * with money left are listed as sources, each with an editable amount (shared amount-pad idiom,
 * FillGoalsSheet). The default plan is `proposeCoverSources` — pool first, then the loosest
 * envelopes — and the human may retarget any row, including taking from an envelope while the
 * pool could still pay (that is the point: "don't touch the pool, take it from Groceries").
 *
 * Confirm is a series of plain allocation edits, donors first, target last — `allocated − x` on
 * each donor, `allocated + moved` on the target — every one re-read FRESH from the replica at
 * press time (a donor archived or spent down since the sheet opened is skipped, and the target
 * receives only what was actually taken plus the pool part). The pool row never gets a write of
 * its own: allocating to the target draws from it implicitly. No new op, no server change.
 */
export function CoverStepSheet({
  show,
  state,
  step,
  onClose,
  onApplied,
}: {
  show: boolean;
  state: StateResponse;
  /** The step being covered; the sheet renders nothing useful without one (kept mounted for the exit animation). */
  step: BudgetStep | null;
  onClose: () => void;
  onApplied: (result: { moved: number; restores: CoverRestore[] }) => void;
}) {
  const C = useTheme();
  const M = useMask();
  const currency = useCurrency();
  const { settings } = useSettings();
  const { t, lang } = useT();
  const [plan, setPlan] = useState<CoverPlan>({});
  const [pad, setPad] = useState<AmountPadTarget | null>(null);

  const compareNames = new Intl.Collator(lang).compare;
  const targetId = step?.envelopeId ?? "";
  const donors = coverDonors(state.envelopes, targetId, compareNames);
  const poolAvailable = Math.max(0, state.readyToAssign);
  const sources = [{ id: POOL_SOURCE_ID, available: poolAvailable }, ...donors];
  const status = coverPlanStatus(plan, sources);
  const overdrawn = new Set(status.overdrawn);
  const amount = step?.amount ?? 0;

  // Re-propose on every open: the pool and every donor's slack may have moved since last time,
  // and a stale plan would offer money that is no longer there.
  useEffect(() => {
    if (!show || !step) return;
    setPlan(proposeCoverSources(step.amount, state.readyToAssign, coverDonors(state.envelopes, step.envelopeId, compareNames)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, step?.envelopeId]);

  const close = () => {
    setPad(null);
    onClose();
  };

  const openPadFor = (id: string, label: string) =>
    setPad({
      label,
      initial: plan[id] ?? 0,
      onCommit: (minor) => setPlan((p) => ({ ...p, [id]: minor })),
    });

  const confirm = () => {
    if (!step || !status.valid) return;
    const ledger = store.getLedger();
    const live = ledger ? computeStateResponse(ledger, state.month) : null;
    const target = live?.envelopes.find((e) => e.id === step.envelopeId);
    if (!live || !target || target.archived) {
      close();
      return;
    }
    const restores: CoverRestore[] = [];
    let moved = plan[POOL_SOURCE_ID] ?? 0;
    for (const d of donors) {
      const take = plan[d.id] ?? 0;
      if (take <= 0) continue;
      const fresh = live.envelopes.find((e) => e.id === d.id);
      if (!fresh || fresh.archived) continue; // gone since the sheet opened — take nothing from it
      restores.push({ envelopeId: d.id, previousAllocated: fresh.allocated });
      local.setDisplayedAllocation({ envelopeId: d.id, month: state.month, amount: fresh.allocated - take });
      moved += take;
    }
    if (moved > 0) {
      restores.push({ envelopeId: target.id, previousAllocated: target.allocated });
      local.setDisplayedAllocation({ envelopeId: target.id, month: state.month, amount: target.allocated + moved });
      haptic([10, 30, 14]);
      onApplied({ moved, restores });
    }
    close();
  };

  const title = !step ? "" : step.kind === "over" ? t("Cover the overspend in {name}", { name: step.name }) : t("Top up {name}", { name: step.name });

  const row = (opts: { id: string; name: string; available: number; glyph: ReactNode; note?: string; last: boolean }) => {
    const value = plan[opts.id] ?? 0;
    const bad = overdrawn.has(opts.id);
    const inert = opts.available === 0;
    const after = opts.available - value;
    return (
      <div
        key={opts.id}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 0",
          borderBottom: opts.last ? "none" : `1px solid ${C.line}`,
          opacity: inert ? 0.5 : 1,
        }}
      >
        {opts.glyph}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {opts.name}
            {opts.note && <span style={{ fontSize: 10.5, fontWeight: 500, color: C.mute, marginLeft: 6 }}>{opts.note}</span>}
          </div>
          <div style={{ fontSize: 10.5, color: bad ? C.neg : C.mute, fontVariantNumeric: "tabular-nums" }}>
            {bad
              ? t("Only {available} available", { available: M(opts.available) })
              : value > 0
                ? t("{available} available → {after} left", { available: M(opts.available), after: M(after) })
                : t("{available} available", { available: M(opts.available) })}
          </div>
        </div>
        {/* Discreet mode (FillGoalsSheet precedent): masked, non-interactive — no tap target that
            would reveal an amount via the pad's prefill. */}
        {settings.discreet ? (
          <div style={{ display: "flex", alignItems: "center", border: `1px solid ${C.line}`, background: C.inset, borderRadius: 9, padding: "6px 9px" }}>
            <span style={{ fontSize: 13, color: C.text }}>•••• {currencySymbol(currency, lang)}</span>
          </div>
        ) : (
          <div
            onClick={() => !inert && openPadFor(opts.id, opts.name)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 3,
              border: `1px solid ${bad ? C.neg : value > 0 ? TEAL : C.line}`,
              background: C.inset,
              borderRadius: 9,
              padding: "6px 9px",
              cursor: inert ? "default" : "pointer",
            }}
          >
            <span style={{ fontSize: 11, color: C.soft }}>−</span>
            <input
              value={localizePadExpression(fmtTrim(value), lang)}
              readOnly
              disabled={inert}
              tabIndex={inert ? -1 : 0}
              aria-label={t("Amount from {name}", { name: opts.name })}
              onClick={() => !inert && openPadFor(opts.id, opts.name)}
              onFocus={() => !inert && openPadFor(opts.id, opts.name)}
              style={{
                width: 60,
                background: "none",
                border: "none",
                textAlign: "right",
                fontSize: 13,
                fontWeight: 700,
                color: bad ? C.neg : value > 0 ? TEAL : C.soft,
                fontFamily: font,
                fontVariantNumeric: "tabular-nums",
                cursor: inert ? "default" : "pointer",
                padding: 0,
              }}
            />
            <span style={{ fontSize: 11, color: C.soft }}>{currencySymbol(currency, lang)}</span>
          </div>
        )}
      </div>
    );
  };

  const envGlyph = (color: string, icon: string) => (
    <div style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, background: color, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <Glyph name={icon} size={14} color={isLight(color) ? "#33312c" : "#fff"} sw={1.6} />
    </div>
  );
  const envById = new Map(state.envelopes.map((e) => [e.id, e]));
  const short = status.sum < amount;

  return (
    <>
      <Surface show={show} onClose={close} tall={donors.length > 5}>
        {(C) => (
          <>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.text }}>{title}</div>
            <div style={{ fontSize: 12, color: C.mute, marginTop: 3, marginBottom: 12, fontVariantNumeric: "tabular-nums" }}>
              {t("Needs {amount} · pick where it comes from", { amount: M(amount) })}
            </div>

            {row({
              id: POOL_SOURCE_ID,
              name: t("To be budgeted"),
              available: poolAvailable,
              last: donors.length === 0,
              glyph: (
                <div
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 8,
                    flexShrink: 0,
                    border: `1.5px dashed ${TEAL}`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Glyph name="wallet" size={14} color={TEAL} sw={1.6} />
                </div>
              ),
            })}
            {donors.map((d, i) => {
              const env = envById.get(d.id);
              return row({
                id: d.id,
                name: d.name,
                available: d.available,
                note: d.isSavings ? t("savings") : undefined,
                last: i === donors.length - 1,
                glyph: envGlyph(env?.color ?? C.line, env?.icon ?? "envelope"),
              });
            })}
            {donors.length === 0 && poolAvailable === 0 && (
              <div style={{ fontSize: 12, color: C.mute, padding: "8px 0" }}>{t("No envelope has money left this month.")}</div>
            )}

            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, color: overdrawn.size > 0 ? C.neg : short ? C.warn : C.soft, marginBottom: 10, fontVariantNumeric: "tabular-nums" }}>
                {overdrawn.size > 0 ? t("A source is asked for more than it has") : t("Moving {sum} of {amount}", { sum: M(status.sum), amount: M(amount) })}
              </div>
              <button
                onClick={confirm}
                disabled={!status.valid}
                style={{
                  width: "100%",
                  padding: "12px 0",
                  borderRadius: 12,
                  border: "none",
                  background: CTA,
                  color: "#fff",
                  fontSize: 13.5,
                  fontWeight: 600,
                  cursor: status.valid ? "pointer" : "default",
                  opacity: status.valid ? 1 : 0.5,
                  fontFamily: "inherit",
                }}
              >
                {t("Move {sum}", { sum: M(status.sum) })}
              </button>
            </div>
          </>
        )}
      </Surface>
      {/* Sibling of the Surface, not a child (FillGoalsSheet): the sheet's transform would break the pad's position:fixed. */}
      <AmountPadHost target={pad} onClose={() => setPad(null)} />
    </>
  );
}
