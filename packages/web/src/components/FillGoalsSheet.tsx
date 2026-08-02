import { useEffect, useState } from "react";
import { computeStateResponse, fillByGoals, type FillProposal } from "@enveo/shared";
import { Sheet } from "./chrome";
import { AmountPadHost, type AmountPadTarget } from "./AmountPadSheet";
import { useCurrency, useMask } from "../lib/contexts";
import { currencySymbol, fmtTrim, isLight, parseAmount } from "../lib/format";
import { useT } from "../lib/i18n";
import { Glyph } from "../lib/icons";
import { CTA, TEAL, font } from "../lib/theme";
import { haptic } from "../lib/haptics";
import { local } from "../lib/mutate";
import { store } from "../lib/store";
import { type StateResponse } from "../lib/api";

/**
 * "Fill by goals" preview (spec 2026-07-31): on open, proposes how to spend the current
 * "ready to assign" pool across envelopes with a monthly target (`fillByGoals`, full-or-skip
 * in sort order, single-partial fallback) — one row per proposed envelope, its `+amount`
 * editable via the shared amount-pad idiom (BudgetSuggestSheet). Confirm re-reads `allocated`
 * FRESH from the replica per envelope (the proposal is a point-in-time snapshot; other edits
 * may have landed since the sheet opened) and writes the ABSOLUTE `local.setAllocation`
 * as `allocatedFresh + add` — never the stale `allocated` captured at open.
 */
export function FillGoalsSheet({ show, state, month, onClose }: { show: boolean; state: StateResponse; month: string; onClose: () => void }) {
  const M = useMask();
  const currency = useCurrency();
  const { t, lang } = useT();
  const [proposals, setProposals] = useState<FillProposal[]>([]);
  const [edited, setEdited] = useState<Record<string, string>>({}); // envelopeId -> "+amount" string
  const [pad, setPad] = useState<AmountPadTarget | null>(null);

  // Snapshot the proposal on every open — a later re-open (pool/allocations may have moved
  // since) recomputes rather than reusing a stale list.
  useEffect(() => {
    if (!show) return;
    const props = fillByGoals(state.envelopes, state.readyToAssign);
    setProposals(props);
    setEdited(Object.fromEntries(props.map((p) => [p.envelopeId, fmtTrim(p.add)])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show]);

  const envById = new Map(state.envelopes.map((e) => [e.id, e]));

  const editedMinor = (id: string, fallback: number): number => {
    const raw = edited[id];
    if (raw === undefined) return fallback;
    const v = raw.trim() === "" ? 0 : parseAmount(raw);
    return v === null ? fallback : v;
  };

  const sum = proposals.reduce((s, p) => s + editedMinor(p.envelopeId, p.add), 0);
  const over = sum > state.readyToAssign;

  const openPadFor = (p: FillProposal) =>
    setPad({
      label: envById.get(p.envelopeId)?.name ?? p.envelopeId,
      initial: editedMinor(p.envelopeId, p.add),
      onCommit: (minor) => setEdited((s) => ({ ...s, [p.envelopeId]: fmtTrim(minor) })),
    });

  const close = () => { setPad(null); onClose(); };

  // Confirm: per proposed row with a final positive add, read `allocated` FRESH from the
  // replica (not the `state` prop, which may already be a render behind the outbox) and write
  // the absolute total — `local.setAllocation` is a per-month OVERWRITE, not a delta.
  const confirm = () => {
    const ledger = store.getLedger();
    const live = ledger ? computeStateResponse(ledger, month) : null;
    if (!live) { close(); return; }
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

            {proposals.map((p, i) => {
              const env = envById.get(p.envelopeId);
              if (!env) return null;
              return (
                <div key={p.envelopeId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: i < proposals.length - 1 ? `1px solid ${C.line}` : "none" }}>
                  <div style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, background: env.color, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Glyph name={env.icon} size={14} color={isLight(env.color) ? "#33312c" : "#fff"} sw={1.6} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{env.name}</div>
                    <div style={{ fontSize: 10.5, color: C.mute, fontVariantNumeric: "tabular-nums" }}>{M(env.allocated)} → {M(env.monthlyTarget ?? 0)}</div>
                  </div>
                  <div onClick={() => openPadFor(p)} style={{ display: "flex", alignItems: "center", gap: 3, border: `1px solid ${TEAL}`, background: C.inset, borderRadius: 9, padding: "6px 9px", cursor: "pointer" }}>
                    <span style={{ fontSize: 11, color: C.soft }}>+</span>
                    <input
                      value={edited[p.envelopeId] ?? ""}
                      readOnly
                      tabIndex={0}
                      onClick={() => openPadFor(p)}
                      onFocus={() => openPadFor(p)}
                      style={{ width: 60, background: "none", border: "none", textAlign: "right", fontSize: 13, fontWeight: 700, color: TEAL, fontFamily: font, fontVariantNumeric: "tabular-nums", cursor: "pointer", padding: 0 }}
                    />
                    <span style={{ fontSize: 11, color: C.soft }}>{currencySymbol(currency, lang)}</span>
                  </div>
                </div>
              );
            })}

            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 12, color: over ? C.neg : C.soft, marginBottom: 10 }}>
                {t("Assigning {sum} of {available}", { sum: M(sum), available: M(state.readyToAssign) })}
              </div>
              <button onClick={confirm} disabled={sum === 0} style={{ width: "100%", padding: "12px 0", borderRadius: 12, border: "none", background: CTA, color: "#fff", fontSize: 13.5, fontWeight: 600, cursor: "pointer", opacity: sum === 0 ? 0.5 : 1 }}>
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
