import { computeStateResponse } from "@enveo/shared";
import { type ReactNode, useMemo, useState } from "react";
import type { StateResponse } from "../lib/api";
import { useCurrency, useMask, useSettings, useTheme } from "../lib/contexts";
import { type CoverPlan, clampCoverPlan, coverDonors, coverPlanStatus, donorSlack, POOL_SOURCE_ID, proposeCoverSources } from "../lib/coverSources";
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

/** One allocation write the caller can undo: the envelope and the SIGNED change the cover made
 *  to its displayed allocation (donors negative, the target positive). Undo subtracts the delta
 *  from a fresh read, so two covers that borrowed from the same donor undo independently — an
 *  absolute restore would silently revert the later cover's take along with the earlier one. */
export interface CoverDelta {
  envelopeId: string;
  delta: number;
}

/**
 * "Cover from…" for one Budgets-checklist step: the pool ("To be budgeted") and every envelope
 * with money left are listed as sources, each with an editable amount (shared amount-pad idiom,
 * FillGoalsSheet). The default plan is `proposeCoverSources` — pool first, then the loosest
 * envelopes — and the human may retarget any row, including taking from an envelope while the
 * pool could still pay (that is the point: "don't touch the pool, take it from Groceries").
 *
 * Mounted only while a step is being covered (`key` = the step's envelope), so the plan is a
 * fresh proposal by construction — no effect, no re-open bookkeeping.
 *
 * Confirm is a series of plain allocation edits, donors first, target last — `allocated − x` on
 * each donor, `allocated + moved` on the target — CLAMPED to a fresh replica read at press time
 * (`clampCoverPlan`): the plan was built against a render that may be several sync pulls old,
 * so each part is capped at what the live pool / live donor slack still has, and a donor that
 * vanished gives nothing. The target receives exactly what was taken. The pool row never gets a
 * write of its own: allocating to the target draws from it implicitly. No new op, no server change.
 *
 * `slack` is what each envelope may really give for the VIEWED month (`donorSlack`) — for a past
 * month that is less than its `available` there, because later months already consumed some.
 */
export function CoverStepSheet({
  state,
  step,
  slack,
  currentMonth,
  onClose,
  onApplied,
}: {
  state: StateResponse;
  step: BudgetStep;
  slack: ReadonlyMap<string, number>;
  currentMonth: string;
  onClose: () => void;
  onApplied: (step: BudgetStep, result: { moved: number; deltas: CoverDelta[] }) => void;
}) {
  const C = useTheme();
  const M = useMask();
  const currency = useCurrency();
  const { settings } = useSettings();
  const { t, lang } = useT();
  const symbol = currencySymbol(currency, lang);

  const compareNames = useMemo(() => new Intl.Collator(lang).compare, [lang]);
  // `state.envelopes` identity is stable across UI-only renders (useStateQuery memoises per
  // ledger version + month), so this re-sorts only when the ledger actually moved.
  const donors = useMemo(
    () =>
      coverDonors(
        state.envelopes.map((e) => ({ ...e, available: slack.get(e.id) ?? e.available })),
        step.envelopeId,
        compareNames,
      ),
    [state.envelopes, slack, step.envelopeId, compareNames],
  );
  const poolAvailable = Math.max(0, state.readyToAssign);
  const [plan, setPlan] = useState<CoverPlan>(() => proposeCoverSources(step.amount, state.readyToAssign, donors));
  const [pad, setPad] = useState<AmountPadTarget | null>(null);

  const status = coverPlanStatus(plan, [{ id: POOL_SOURCE_ID, available: poolAvailable }, ...donors]);

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
    if (!status.valid) return;
    const ledger = store.getLedger();
    const live = ledger ? computeStateResponse(ledger, state.month) : null;
    const target = live?.envelopes.find((e) => e.id === step.envelopeId);
    if (!ledger || !live || !target || target.archived) {
      close();
      return;
    }
    // Fresh slack for the same month rule the sheet displayed — a past month is bounded by what
    // later months have already consumed, so the clamp must use the same measure.
    const liveSlack = state.month < currentMonth ? donorSlack(ledger, state.month, currentMonth) : null;
    const liveDonors = coverDonors(
      live.envelopes.map((e) => ({ ...e, available: liveSlack?.get(e.id) ?? e.available })),
      step.envelopeId,
      compareNames,
    );
    const { takes, moved } = clampCoverPlan(plan, live.readyToAssign, liveDonors);
    if (moved > 0) {
      const deltas: CoverDelta[] = [];
      for (const { id, take } of takes) {
        const fresh = live.envelopes.find((e) => e.id === id)!; // liveDonors came from live.envelopes
        deltas.push({ envelopeId: id, delta: -take });
        local.setDisplayedAllocation({ envelopeId: id, month: state.month, amount: fresh.allocated - take });
      }
      deltas.push({ envelopeId: target.id, delta: moved });
      local.setDisplayedAllocation({ envelopeId: target.id, month: state.month, amount: target.allocated + moved });
      haptic([10, 30, 14]);
      onApplied(step, { moved, deltas });
    }
    close();
  };

  const title = step.kind === "over" ? t("Cover the overspend in {name}", { name: step.name }) : t("Top up {name}", { name: step.name });

  type Source = { id: string; name: string; available: number; glyph: ReactNode; note?: string };
  const poolGlyph = (
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
  );
  const envGlyph = (color: string, icon: string) => (
    <div style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, background: color, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <Glyph name={icon} size={14} color={isLight(color) ? "#33312c" : "#fff"} sw={1.6} />
    </div>
  );
  const sources: Source[] = [
    { id: POOL_SOURCE_ID, name: t("To be budgeted"), available: poolAvailable, glyph: poolGlyph },
    ...donors.map((d) => ({ id: d.id, name: d.name, available: d.available, glyph: envGlyph(d.color, d.icon), note: d.isSavings ? t("Savings") : undefined })),
  ];

  const row = (s: Source, last: boolean) => {
    const value = plan[s.id] ?? 0;
    const bad = status.overdrawn.has(s.id);
    // A source with nothing to give is inert — unless it still carries a planned amount (the pool
    // can drain under an open sheet); then the row must stay editable so the human can zero it.
    const inert = s.available === 0 && value === 0;
    const tone = bad ? C.neg : value > 0 ? TEAL : null;
    const open = () => !inert && openPadFor(s.id, s.name);
    return (
      <div
        key={s.id}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 0",
          borderBottom: last ? "none" : `1px solid ${C.line}`,
          opacity: inert ? 0.5 : 1,
        }}
      >
        {s.glyph}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* The name truncates, the note never does — a long envelope name must not eat the
              "Savings" tag that explains why the row sits at the bottom of the list. */}
          <div style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
              {s.name}
            </span>
            {s.note && <span style={{ fontSize: 10.5, fontWeight: 500, color: C.mute, flexShrink: 0 }}>{s.note}</span>}
          </div>
          <div style={{ fontSize: 10.5, color: bad ? C.neg : C.mute, fontVariantNumeric: "tabular-nums" }}>
            {bad
              ? t("Only {available} available", { available: M(s.available) })
              : value > 0
                ? t("{available} available → {after} left", { available: M(s.available), after: M(s.available - value) })
                : t("{available} available", { available: M(s.available) })}
          </div>
        </div>
        {/* Discreet mode (FillGoalsSheet precedent): masked, non-interactive — no tap target that
            would reveal an amount via the pad's prefill. */}
        {settings.discreet ? (
          <div style={{ display: "flex", alignItems: "center", border: `1px solid ${C.line}`, background: C.inset, borderRadius: 9, padding: "6px 9px" }}>
            <span style={{ fontSize: 13, color: C.text }}>•••• {symbol}</span>
          </div>
        ) : (
          <div
            onClick={open}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 3,
              border: `1px solid ${tone ?? C.line}`,
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
              aria-label={t("Amount from {name}", { name: s.name })}
              onFocus={open}
              style={{
                width: 60,
                background: "none",
                border: "none",
                textAlign: "right",
                fontSize: 13,
                fontWeight: 700,
                color: tone ?? C.soft,
                fontFamily: font,
                fontVariantNumeric: "tabular-nums",
                cursor: inert ? "default" : "pointer",
                padding: 0,
              }}
            />
            <span style={{ fontSize: 11, color: C.soft }}>{symbol}</span>
          </div>
        )}
      </div>
    );
  };

  const short = status.sum < step.amount;

  return (
    <>
      <Surface show onClose={close} tall={donors.length > 5}>
        {(C) => (
          <>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.text }}>{title}</div>
            <div style={{ fontSize: 12, color: C.mute, marginTop: 3, marginBottom: 12, fontVariantNumeric: "tabular-nums" }}>
              {t("Needs {amount} · pick where it comes from", { amount: M(step.amount) })}
            </div>

            {sources.map((s, i) => row(s, i === sources.length - 1))}
            {donors.length === 0 && poolAvailable === 0 && (
              <div style={{ fontSize: 12, color: C.mute, padding: "8px 0" }}>{t("No envelope has money left this month.")}</div>
            )}

            <div style={{ marginTop: 14 }}>
              <div
                style={{
                  fontSize: 12,
                  color: status.overdrawn.size > 0 ? C.neg : short ? C.warn : C.soft,
                  marginBottom: 10,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {status.overdrawn.size > 0
                  ? t("A source is asked for more than it has")
                  : t("Moving {sum} of {amount}", { sum: M(status.sum), amount: M(step.amount) })}
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
