import { computeStateResponse, type FillProposal, fillByGoals } from "@enveo/shared";
import { useEffect, useState } from "react";
import type { StateResponse } from "../lib/api";
import { useCurrency, useMask, useSettings } from "../lib/contexts";
import { currencySymbol, fmtTrim, isLight, parseAmount } from "../lib/format";
import { haptic } from "../lib/haptics";
import { useT } from "../lib/i18n";
import { Glyph } from "../lib/icons";
import { local } from "../lib/mutate";
import { store } from "../lib/store";
import { CTA, font, TEAL } from "../lib/theme";
import { AmountPadHost, type AmountPadTarget } from "./AmountPadSheet";
import { Sheet } from "./chrome";

/**
 * "Fill by goals" preview (spec 2026-07-31): on open, proposes how to spend the current
 * "ready to assign" pool across envelopes with a monthly target (`fillByGoals`, full-or-skip
 * in group-major order — mirrors the Budget screen's visual order, see `Budget.tsx` — with a
 * single-partial fallback) — one row per proposed envelope, its `+amount` editable via the
 * shared amount-pad idiom (BudgetSuggestSheet). Confirm re-reads `allocated` FRESH from the
 * replica per envelope (the proposal is a point-in-time snapshot; other edits may have landed
 * since the sheet opened) and writes the ABSOLUTE `local.setAllocation` as `allocatedFresh +
 * add` — never the stale `allocated` captured at open. Writes always target the VIEWED
 * `month`, while the pool (`readyToAssign`) is month-independent — same split as Budget's
 * live-edit header (`tbbLive` precedent).
 */
export function FillGoalsSheet({ show, state, month, onClose }: { show: boolean; state: StateResponse; month: string; onClose: () => void }) {
  const M = useMask();
  const currency = useCurrency();
  const { settings } = useSettings();
  const { t, lang } = useT();
  const [proposals, setProposals] = useState<FillProposal[]>([]);
  const [edited, setEdited] = useState<Record<string, string>>({}); // envelopeId -> "+amount" string
  const [pad, setPad] = useState<AmountPadTarget | null>(null);

  // Snapshot the proposal on every open — a later re-open (pool/allocations may have moved
  // since) recomputes rather than reusing a stale list.
  useEffect(() => {
    if (!show) return;
    // Group-major order (fillByGoals docblock): mirror the Budget screen's visual order by
    // resolving each envelope's group.sort. A missing group can't happen (FK) — the fallback
    // just sorts an orphan envelope last rather than crashing.
    const groupSortById = new Map(state.groups.map((g) => [g.id, g.sort]));
    const props = fillByGoals(
      state.envelopes.map((e) => ({ ...e, groupSort: groupSortById.get(e.groupId) ?? Number.MAX_SAFE_INTEGER })),
      state.readyToAssign,
    );
    setProposals(props);
    setEdited(Object.fromEntries(props.map((p) => [p.envelopeId, fmtTrim(p.add)])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);

  const envById = new Map(state.envelopes.map((e) => [e.id, e]));

  // `state` is a live prop — an envelope proposed at open time may have been archived (or
  // removed) since, by an edit elsewhere while the sheet stayed open. Filtering here keeps the
  // rendered rows AND the sum/CTA label in lockstep with what `confirm` actually writes (it
  // already skips archived/missing envelopes per-row) — otherwise the label could promise more
  // than the write delivers.
  const visibleProposals = proposals.filter((p) => {
    const env = envById.get(p.envelopeId);
    return !!env && !env.archived;
  });

  const editedMinor = (id: string, fallback: number): number => {
    const raw = edited[id];
    if (raw === undefined) return fallback;
    const v = raw.trim() === "" ? 0 : parseAmount(raw);
    return v === null ? fallback : v;
  };

  const sum = visibleProposals.reduce((s, p) => s + editedMinor(p.envelopeId, p.add), 0);
  const over = sum > state.readyToAssign;

  const openPadFor = (p: FillProposal) =>
    setPad({
      label: envById.get(p.envelopeId)?.name ?? p.envelopeId,
      initial: editedMinor(p.envelopeId, p.add),
      onCommit: (minor) => setEdited((s) => ({ ...s, [p.envelopeId]: fmtTrim(minor) })),
    });

  const close = () => {
    setPad(null);
    onClose();
  };

  // Confirm: per proposed row with a final positive add, read `allocated` FRESH from the
  // replica (not the `state` prop, which may already be a render behind the outbox) and write
  // the absolute total — `local.setAllocation` is a per-month OVERWRITE, not a delta.
  const confirm = () => {
    const ledger = store.getLedger();
    const live = ledger ? computeStateResponse(ledger, month) : null;
    if (!live) {
      close();
      return;
    }
    for (const p of proposals) {
      const add = editedMinor(p.envelopeId, p.add);
      if (add <= 0) continue;
      const envFresh = live.envelopes.find((e) => e.id === p.envelopeId);
      if (!envFresh || envFresh.archived) continue; // removed/archived since the proposal was computed
      local.setAllocation({ envelopeId: p.envelopeId, month, amount: envFresh.allocated + add });
    }
    haptic([10, 30, 14]);
    close();
  };

  return (
    <>
      <Sheet show={show} onClose={close}>
        {(C) => (
          <>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.text, marginBottom: 14 }}>{t("Fill by goals")}</div>

            {visibleProposals.map((p, i) => {
              const env = envById.get(p.envelopeId)!; // visibleProposals already excludes missing/archived
              return (
                <div
                  key={p.envelopeId}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 0",
                    borderBottom: i < visibleProposals.length - 1 ? `1px solid ${C.line}` : "none",
                  }}
                >
                  <div
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 8,
                      flexShrink: 0,
                      background: env.color,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Glyph name={env.icon} size={14} color={isLight(env.color) ? "#33312c" : "#fff"} sw={1.6} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {env.name}
                    </div>
                    <div style={{ fontSize: 10.5, color: C.mute, fontVariantNumeric: "tabular-nums" }}>
                      {M(env.allocated)} → {M(env.monthlyTarget ?? 0)}
                    </div>
                  </div>
                  {/* Discreet mode (AllocCell precedent, Budget.tsx): masked, non-interactive — no
                      tap target that would reveal an amount via the pad's prefill. */}
                  {settings.discreet ? (
                    <div
                      style={{ display: "flex", alignItems: "center", border: `1px solid ${C.line}`, background: C.inset, borderRadius: 9, padding: "6px 9px" }}
                    >
                      <span style={{ fontSize: 13, color: C.text }}>•••• {currencySymbol(currency, lang)}</span>
                    </div>
                  ) : (
                    <div
                      onClick={() => openPadFor(p)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 3,
                        border: `1px solid ${TEAL}`,
                        background: C.inset,
                        borderRadius: 9,
                        padding: "6px 9px",
                        cursor: "pointer",
                      }}
                    >
                      <span style={{ fontSize: 11, color: C.soft }}>+</span>
                      <input
                        value={edited[p.envelopeId] ?? ""}
                        readOnly
                        tabIndex={0}
                        onClick={() => openPadFor(p)}
                        onFocus={() => openPadFor(p)}
                        style={{
                          width: 60,
                          background: "none",
                          border: "none",
                          textAlign: "right",
                          fontSize: 13,
                          fontWeight: 700,
                          color: TEAL,
                          fontFamily: font,
                          fontVariantNumeric: "tabular-nums",
                          cursor: "pointer",
                          padding: 0,
                        }}
                      />
                      <span style={{ fontSize: 11, color: C.soft }}>{currencySymbol(currency, lang)}</span>
                    </div>
                  )}
                </div>
              );
            })}

            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, color: over ? C.neg : C.soft, marginBottom: 10 }}>
                {t("Assigning {sum} of {available}", { sum: M(sum), available: M(state.readyToAssign) })}
              </div>
              <button
                onClick={confirm}
                disabled={sum === 0}
                style={{
                  width: "100%",
                  padding: "12px 0",
                  borderRadius: 12,
                  border: "none",
                  background: CTA,
                  color: "#fff",
                  fontSize: 13.5,
                  fontWeight: 600,
                  cursor: "pointer",
                  opacity: sum === 0 ? 0.5 : 1,
                }}
              >
                {t("Assign {sum}", { sum: M(sum) })}
              </button>
            </div>
          </>
        )}
      </Sheet>
      {/* Sibling of the Sheet (not a child) — the panel's transform would break the pad's position:fixed. */}
      <AmountPadHost target={pad} onClose={() => setPad(null)} />
    </>
  );
}
