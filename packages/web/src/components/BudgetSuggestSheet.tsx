import {
  type AllocationPreset,
  type AllocationPresetMode,
  type BudgetSuggestion,
  computeStateResponse,
  type SuggestItem,
  suggestFromPreset,
  suggestTopUpNegatives,
} from "@enveo/shared";
import { type CSSProperties, useEffect, useState } from "react";
import type { StateResponse } from "../lib/api";
import { useBudgetPreferences, useCurrency } from "../lib/contexts";
import { currencySymbol, fmtTrim, formatMoney, isLight, localizePadExpression, parseAmount } from "../lib/format";
import { canFillGoals } from "../lib/goals";
import { useT } from "../lib/i18n";
import { Glyph, Ico } from "../lib/icons";
import { local } from "../lib/mutate";
import { store } from "../lib/store";
import { CORAL, CTA, font, TEAL, type Theme } from "../lib/theme";
import { AmountPadHost, type AmountPadTarget } from "./AmountPadSheet";
import { Surface } from "./chrome";

const GEAR_D =
  "M12 15a3 3 0 100-6 3 3 0 000 6zm7.4-3a7.4 7.4 0 00-.1-1.2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 00-2.1-1.2L14.4 3h-4l-.4 2.6a7.5 7.5 0 00-2.1 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 000 2.4l-2 1.6 2 3.4 2.4-1c.6.5 1.4.9 2.1 1.2l.4 2.6h4l.4-2.6a7.5 7.5 0 002.1-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z";

type Choice = "topUp" | "goals" | { presetId: string };

type Review = BudgetSuggestion & { label: string; preset: AllocationPreset | null };

/** The viewed month's envelopes grouped and ordered like the Budget screen. */
function groupedEnvelopes(state: StateResponse, include: (e: StateResponse["envelopes"][number]) => boolean) {
  return [...state.groups]
    .sort((a, b) => a.sort - b.sort)
    .map((g) => ({
      key: g.id,
      name: g.name,
      envelopes: state.envelopes.filter((e) => e.groupId === g.id && include(e)).sort((a, b) => a.sort - b.sort),
    }))
    .filter((g) => g.envelopes.length > 0);
}

type Tp = ReturnType<typeof useT>["tp"];

function presetSummary(p: AllocationPreset, tp: Tp, money: (minor: number) => string): string {
  const amount = money(p.amounts.reduce((s, a) => s + a.amount, 0));
  return p.mode === "add"
    ? tp("Adds {amount} to {n} envelope | Adds {amount} to {n} envelopes", p.amounts.length, { amount })
    : tp("Tops up {n} envelope to {amount} in total | Tops up {n} envelopes to {amount} in total", p.amounts.length, { amount });
}

/** `onFillGoals` hands over to the dedicated "Fill by goals" preview sheet instead of reviewing here. */
export function BudgetSuggestSheet({
  show,
  state,
  month,
  onClose,
  onFillGoals,
}: {
  show: boolean;
  state: StateResponse;
  month: string;
  onClose: () => void;
  onFillGoals: () => void;
}) {
  const { t, tp, lang } = useT();
  const currency = useCurrency();
  const { preferences } = useBudgetPreferences();
  const presets = preferences.allocationPresets;
  const [choice, setChoice] = useState<Choice>("topUp");
  const [resp, setResp] = useState<Review | null>(null);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [manage, setManage] = useState<"list" | "new" | null>(null);
  const [pad, setPad] = useState<AmountPadTarget | null>(null);

  const envById = new Map(state.envelopes.map((e) => [e.id, e]));
  const selectedPreset = typeof choice === "object" ? presets.find((p) => p.id === choice.presetId) : undefined;

  // A preset deleted (here or on another device) while selected falls back to the default strategy.
  useEffect(() => {
    if (typeof choice === "object" && !selectedPreset) setChoice("topUp");
  }, [choice, selectedPreset]);

  const money = (minor: number) => formatMoney(minor, currency, lang, { trim: true });

  const reset = () => {
    setResp(null);
    setEdited({});
    setChecked({});
    setError(null);
  };
  const close = () => {
    reset();
    setManage(null);
    onClose();
  };

  const generate = () => {
    if (choice === "goals") {
      reset();
      onFillGoals();
      return;
    }
    setError(null);
    const pool = Math.max(0, state.toBeBudgeted);
    const r: Review = selectedPreset
      ? { ...suggestFromPreset(state.envelopes, selectedPreset, pool), label: selectedPreset.name, preset: selectedPreset }
      : { ...suggestTopUpNegatives(state.envelopes, pool), label: t("Top up negatives"), preset: null };
    setResp(r);
    setEdited(Object.fromEntries(r.items.map((i) => [i.envelopeId, fmtTrim(i.proposedDelta)])));
    setChecked(Object.fromEntries(r.items.map((i) => [i.envelopeId, true])));
  };

  const editedMinor = (id: string, fallback: number): number => {
    const raw = edited[id];
    if (raw === undefined) return fallback;
    const v = raw.trim() === "" ? 0 : parseAmount(raw);
    return v === null ? fallback : v;
  };

  const deltaOf = (it: SuggestItem): number => editedMinor(it.envelopeId, it.proposedDelta);

  const openPadFor = (it: SuggestItem) =>
    setPad({
      label: envById.get(it.envelopeId)?.name ?? it.envelopeId,
      initial: deltaOf(it),
      onCommit: (minor) => setEdited((s) => ({ ...s, [it.envelopeId]: fmtTrim(minor) })),
    });

  const sumChecked = resp ? resp.items.reduce((s, it) => s + (checked[it.envelopeId] ? deltaOf(it) : 0), 0) : 0;
  const remaining = resp ? resp.amountToDistribute - sumChecked : 0;
  const nSel = resp ? resp.items.filter((it) => checked[it.envelopeId] && deltaOf(it) > 0).length : 0;
  const canApply = nSel > 0 && remaining >= 0;

  const apply = () => {
    if (!resp || !canApply) return;

    const ledger = store.getLedger();
    const live = ledger ? computeStateResponse(ledger, month) : null;
    if (!live || Math.max(0, live.toBeBudgeted) !== resp.amountToDistribute) {
      setError(t("The budget has changed since this was generated — generate a new suggestion."));
      return;
    }

    const chosen = resp.items.filter((it) => checked[it.envelopeId] && deltaOf(it) > 0);
    for (const it of chosen) {
      const liveEnv = live.envelopes.find((e) => e.id === it.envelopeId);
      if (!liveEnv || liveEnv.archived || liveEnv.allocated !== it.currentAllocated) {
        setError(t("Envelopes have changed since this was generated — generate a new suggestion."));
        return;
      }
    }
    for (const it of chosen) {
      local.setDisplayedAllocation({ envelopeId: it.envelopeId, month, amount: it.currentAllocated + deltaOf(it) });
    }
    close();
  };

  const sections = resp
    ? (() => {
        const itemsById = new Map(resp.items.map((it) => [it.envelopeId, it]));
        const list = groupedEnvelopes(state, (e) => itemsById.has(e.id)).map((g) => ({
          key: g.key,
          name: g.name,
          rows: g.envelopes.map((e) => itemsById.get(e.id)!),
        }));
        // Theoretical edge case: items with no envelope in state (e.g. a race with sync) — appended without a header.
        const orphans = resp.items.filter((it) => !envById.has(it.envelopeId));
        if (orphans.length > 0) list.push({ key: "__orphans", name: "", rows: orphans });
        return list;
      })()
    : [];

  const toggleRow = (id: string) => setChecked((s) => ({ ...s, [id]: !s[id] }));
  /** Tap on a group header: fully checked → uncheck all; otherwise check all. */
  const toggleGroup = (rows: SuggestItem[]) => {
    const allOn = rows.every((it) => checked[it.envelopeId]);
    setChecked((s) => {
      const next = { ...s };
      for (const it of rows) next[it.envelopeId] = !allOn;
      return next;
    });
  };

  return (
    <>
      <Surface show={show} onClose={close}>
        {(C) =>
          manage ? (
            <PresetManager key={manage} C={C} start={manage} state={state} onClose={() => setManage(null)} onPad={setPad} />
          ) : (
            <>
              <div style={{ fontSize: 17, fontWeight: 700, color: C.text, marginBottom: 4 }}>{t("Suggest a distribution")}</div>
              <div style={{ fontSize: 12.5, color: C.soft, marginBottom: 14 }}>
                {t("To be budgeted this month:")}{" "}
                <b style={{ color: state.toBeBudgeted < 0 ? CORAL : C.text, fontVariantNumeric: "tabular-nums" }}>{money(Math.max(0, state.toBeBudgeted))}</b>
              </div>

              {!resp && (
                <>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "2px 0 8px" }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: C.mute, letterSpacing: 0.5, textTransform: "uppercase" }}>{t("Strategy")}</span>
                    <button
                      onClick={() => setManage("list")}
                      aria-label={t("Manage presets")}
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 9,
                        border: "none",
                        background: C.inset,
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <Ico d={GEAR_D} size={15} color={C.soft} sw={1.4} />
                    </button>
                  </div>
                  <div role="radiogroup" aria-label={t("Strategy")} style={{ display: "flex", flexDirection: "column", gap: 7, marginBottom: 14 }}>
                    <StrategyOption
                      C={C}
                      name={t("Top up negatives")}
                      desc={t("Distributes the amount only to envelopes in the red — proportionally to shortfalls, never past zero.")}
                      active={choice === "topUp"}
                      onSelect={() => setChoice("topUp")}
                    />
                    {canFillGoals(state) && (
                      <StrategyOption
                        C={C}
                        name={t("Fill by goals")}
                        desc={t("Funds envelopes with a monthly goal in budget order — each one fully or not at all.")}
                        active={choice === "goals"}
                        onSelect={() => setChoice("goals")}
                      />
                    )}
                    {presets.map((p) => (
                      <StrategyOption
                        key={p.id}
                        C={C}
                        name={p.name}
                        desc={presetSummary(p, tp, money)}
                        active={selectedPreset?.id === p.id}
                        onSelect={() => setChoice({ presetId: p.id })}
                      />
                    ))}
                    {presets.length === 0 && (
                      <button onClick={() => setManage("new")} style={dashedButton(C)}>
                        {t("+ New preset")}
                      </button>
                    )}
                  </div>
                  {error && <div style={{ fontSize: 12.5, color: CORAL, marginBottom: 10 }}>{error}</div>}
                  <button
                    onClick={generate}
                    disabled={state.toBeBudgeted <= 0}
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
                      opacity: state.toBeBudgeted <= 0 ? 0.5 : 1,
                    }}
                  >
                    {state.toBeBudgeted <= 0 ? t("No funds to distribute") : t("Generate suggestion")}
                  </button>
                </>
              )}

              {resp && (
                <>
                  <div style={{ fontSize: 11, color: C.mute, marginBottom: 6 }}>
                    <div style={{ fontWeight: 700, color: C.soft }}>{resp.label}</div>
                    {resp.items.length === 0 && (
                      <div style={{ marginTop: 3 }}>
                        {resp.preset
                          ? resp.preset.mode === "topUp" && resp.skipped < resp.preset.amounts.length
                            ? t("Every envelope in this preset already has its amount this month.")
                            : null
                          : t("No envelope is in the red.")}
                      </div>
                    )}
                    {resp.skipped > 0 && (
                      <div style={{ marginTop: 3 }}>
                        {tp(
                          "{n} envelope from this preset is archived or deleted and was skipped. | {n} envelopes from this preset are archived or deleted and were skipped.",
                          resp.skipped,
                        )}
                      </div>
                    )}
                    {remaining < 0 && (
                      <div role="alert" style={{ color: CORAL, marginTop: 3 }}>
                        {t("{amount} is missing from “To be budgeted” — uncheck or lower some rows to apply.", { amount: money(-remaining) })}
                      </div>
                    )}
                  </div>

                  {sections.map((s) => {
                    const anyOn = s.rows.some((it) => checked[it.envelopeId]);
                    const allOn = s.rows.every((it) => checked[it.envelopeId]);

                    const groupSum = s.rows.reduce((x, it) => x + (!anyOn || checked[it.envelopeId] ? deltaOf(it) : 0), 0);
                    return (
                      <div key={s.key}>
                        {s.name !== "" && (
                          <button
                            onClick={() => toggleGroup(s.rows)}
                            role="checkbox"
                            aria-checked={allOn}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                              width: "100%",
                              border: "none",
                              background: "none",
                              padding: "10px 0 6px",
                              cursor: "pointer",
                              textAlign: "left",
                            }}
                          >
                            <CheckBox on={allOn} C={C} />
                            <span
                              style={{
                                flex: 1,
                                minWidth: 0,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                fontSize: 11,
                                fontWeight: 700,
                                letterSpacing: 0.7,
                                textTransform: "uppercase",
                                color: C.soft,
                                opacity: anyOn ? 1 : 0.5,
                              }}
                            >
                              {s.name}
                              {anyOn ? "" : ` — ${t("skipped")}`}
                            </span>
                            <span
                              style={{
                                fontSize: 11,
                                color: C.mute,
                                fontWeight: 600,
                                fontVariantNumeric: "tabular-nums",
                                textDecoration: anyOn ? "none" : "line-through",
                              }}
                            >
                              {money(groupSum)}
                            </span>
                          </button>
                        )}
                        {s.rows.map((it, ri) => {
                          const on = !!checked[it.envelopeId];
                          const env = envById.get(it.envelopeId);
                          const delta = deltaOf(it);
                          const isEdited = delta !== it.proposedDelta;
                          return (
                            <div
                              key={it.envelopeId}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 10,
                                padding: "8px 0",
                                borderBottom: ri < s.rows.length - 1 ? `1px solid ${C.line}` : "none",
                              }}
                            >
                              <button
                                onClick={() => toggleRow(it.envelopeId)}
                                role="checkbox"
                                aria-checked={on}
                                aria-label={env?.name ?? it.envelopeId}
                                style={{ border: "none", background: "none", padding: 0, cursor: "pointer", display: "flex" }}
                              >
                                <CheckBox on={on} C={C} />
                              </button>
                              <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0, opacity: on ? 1 : 0.4 }}>
                                <EnvelopeChip C={C} env={env} />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div
                                    style={{ fontSize: 13, fontWeight: 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                                  >
                                    {env?.name ?? it.envelopeId}
                                  </div>
                                  <div style={{ fontSize: 10.5, color: C.mute }}>
                                    {on ? t("available after: {amount}", { amount: money(it.currentAvailable + delta) }) : t("skipped")}
                                  </div>
                                </div>
                                <AmountBox
                                  C={C}
                                  prefix="+"
                                  value={localizePadExpression(edited[it.envelopeId] ?? "", lang)}
                                  highlight={on && isEdited}
                                  struck={!on}
                                  onOpen={on ? () => openPadFor(it) : undefined}
                                  symbol={currencySymbol(currency, lang)}
                                />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}

                  {error && <div style={{ fontSize: 12.5, color: CORAL, margin: "10px 0 0" }}>{error}</div>}

                  {/* STICKY bar — position:sticky within the sheet's scroll (NOT fixed: the Sheet has a transform).
                  NOTE: NO negative bottom margin — it ate 28px+safe-area of content height
                  (scrollHeight==clientHeight → dead scroll, last row permanently under the
                  bar; on iOS a whole row disappeared). Side -20px (full-bleed) stays. */}
                  <div
                    style={{
                      position: "sticky",
                      bottom: 0,
                      zIndex: 3,
                      background: C.sheet,
                      borderTop: `1px solid ${C.line}`,
                      margin: "10px -20px 0",
                      padding: "10px 20px 4px",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <span style={{ fontSize: 11.5, fontWeight: 600, color: remaining >= 0 ? C.pos : C.neg }}>
                        {remaining >= 0 ? t("Left after changes") : t("Short after changes")}
                      </span>
                      <span style={{ fontSize: 16, fontWeight: 700, color: remaining >= 0 ? C.pos : C.neg, fontVariantNumeric: "tabular-nums" }}>
                        {(remaining >= 0 ? "+" : "−") + money(Math.abs(remaining))}
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: 10 }}>
                      <button onClick={reset} style={{ ...secondaryButton(C), flex: 1, padding: "11px 0", borderRadius: 12 }}>
                        {t("Back")}
                      </button>
                      <button
                        onClick={apply}
                        disabled={!canApply}
                        style={{
                          flex: 2,
                          padding: "11px 0",
                          borderRadius: 12,
                          border: "none",
                          background: CTA,
                          color: "#fff",
                          fontSize: 13.5,
                          fontWeight: 600,
                          cursor: canApply ? "pointer" : "default",
                          opacity: canApply ? 1 : 0.5,
                        }}
                      >
                        {t("Apply ({n})", { n: nSel })}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </>
          )
        }
      </Surface>
      {/* Sibling of the Surface (not a child) — the panel's transform would break position:fixed. */}
      <AmountPadHost target={pad} onClose={() => setPad(null)} />
    </>
  );
}

function CheckBox({ on, C }: { on: boolean; C: Theme }) {
  return (
    <span
      aria-hidden
      style={{
        width: 20,
        height: 20,
        borderRadius: 7,
        flexShrink: 0,
        boxSizing: "border-box",
        border: `1.6px solid ${on ? C.pos : C.mute}`,
        background: on ? C.pos : "transparent",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {on && (
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" style={{ stroke: "#fff" }} strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 12l6 6L20 6" />
        </svg>
      )}
    </span>
  );
}

function EnvelopeChip({ C, env }: { C: Theme; env: { color: string; icon: string } | undefined }) {
  return (
    <div
      style={{
        width: 30,
        height: 30,
        borderRadius: 8,
        flexShrink: 0,
        background: env?.color ?? C.inset,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Glyph name={env?.icon ?? "wallet"} size={14} color={env && isLight(env.color) ? "#33312c" : "#fff"} sw={1.6} />
    </div>
  );
}

/** Read-only amount field that opens the shared amount pad (the AmountPadHost idiom). */
function AmountBox({
  C,
  prefix,
  value,
  highlight,
  struck,
  onOpen,
  symbol,
  label,
}: {
  C: Theme;
  prefix?: string;
  value: string;
  highlight: boolean;
  struck?: boolean;
  onOpen?: () => void;
  symbol: string;
  label?: string;
}) {
  return (
    <div
      onClick={onOpen}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 3,
        border: `1px solid ${highlight ? TEAL : C.line}`,
        background: C.inset,
        borderRadius: 9,
        padding: "6px 9px",
        cursor: onOpen ? "pointer" : "default",
      }}
    >
      {prefix && <span style={{ fontSize: 11, color: C.soft }}>{prefix}</span>}
      <input
        value={value}
        readOnly
        placeholder="0"
        aria-label={label}
        tabIndex={onOpen ? 0 : -1}
        onClick={onOpen}
        onFocus={onOpen}
        style={{
          width: 60,
          background: "none",
          border: "none",
          textAlign: "right",
          fontSize: 13,
          fontWeight: 700,
          color: highlight ? TEAL : C.text,
          fontFamily: font,
          fontVariantNumeric: "tabular-nums",
          cursor: onOpen ? "pointer" : "default",
          textDecoration: struck ? "line-through" : "none",
          padding: 0,
        }}
      />
      <span style={{ fontSize: 11, color: C.soft }}>{symbol}</span>
    </div>
  );
}

function StrategyOption({ C, name, desc, active, onSelect }: { C: Theme; name: string; desc: string; active: boolean; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      role="radio"
      aria-checked={active}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 11,
        width: "100%",
        textAlign: "left",
        padding: "11px 13px",
        borderRadius: 13,
        border: `1px solid ${active ? TEAL : C.line}`,
        background: active ? "var(--accent-14)" : "transparent",
        cursor: "pointer",
      }}
    >
      <span
        style={{
          width: 18,
          height: 18,
          borderRadius: "50%",
          border: `2px solid ${active ? TEAL : C.mute}`,
          flexShrink: 0,
          marginTop: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {active && <span style={{ width: 8, height: 8, borderRadius: "50%", background: TEAL }} />}
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: "block", fontSize: 13.5, fontWeight: 700, color: active ? TEAL : C.text, overflowWrap: "anywhere" }}>{name}</span>
        <span style={{ display: "block", fontSize: 11.5, color: C.soft, lineHeight: 1.4, marginTop: 2 }}>{desc}</span>
      </span>
    </button>
  );
}

const dashedButton = (C: Theme): CSSProperties => ({
  width: "100%",
  padding: "11px 0",
  borderRadius: 12,
  border: `1px dashed ${C.line}`,
  background: "transparent",
  color: C.text,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
});

const secondaryButton = (C: Theme): CSSProperties => ({
  padding: "10px 0",
  borderRadius: 10,
  border: `1px solid ${C.line}`,
  background: "transparent",
  color: C.text,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
});

type PresetForm = { id: string | null; name: string; mode: AllocationPresetMode; amounts: Record<string, number> };

const emptyForm = (): PresetForm => ({ id: null, name: "", mode: "add", amounts: {} });

/**
 * Allocation presets: list, create, edit, delete — views inside the Suggest Surface (the side panel
 * on wide layouts, never a popup over it). Presets are budget preferences — they sync. `start="new"`
 * opens the editor directly, and leaving it returns to Suggest rather than to the list.
 */
function PresetManager({
  C,
  start,
  state,
  onClose,
  onPad,
}: {
  C: Theme;
  start: "list" | "new";
  state: StateResponse;
  onClose: () => void;
  onPad: (target: AmountPadTarget) => void;
}) {
  const { t, tp, lang } = useT();
  const currency = useCurrency();
  const { preferences, update } = useBudgetPreferences();
  const presets = preferences.allocationPresets;
  const [form, setForm] = useState<PresetForm | null>(() => (start === "new" ? emptyForm() : null));
  const [formError, setFormError] = useState<string | null>(null);

  const closeForm = () => {
    if (start === "new") onClose();
    else {
      setForm(null);
      setFormError(null);
    }
  };

  const money = (minor: number) => formatMoney(minor, currency, lang, { trim: true });
  const groups = groupedEnvelopes(state, (e) => !e.archived);
  const known = new Set(state.envelopes.map((e) => e.id));

  const fillFromMonth = () => {
    if (!form) return;
    const amounts = Object.fromEntries(state.envelopes.filter((e) => !e.archived && e.allocated > 0).map((e) => [e.id, e.allocated]));
    setForm({ ...form, amounts, mode: form.id ? form.mode : "topUp" });
    setFormError(null);
  };

  const save = () => {
    if (!form) return;
    const name = form.name.trim();
    if (!name) return;
    if (presets.some((p) => p.id !== form.id && p.name.trim().toLowerCase() === name.toLowerCase())) {
      setFormError(t("A preset with this name already exists."));
      return;
    }
    // Entries of deleted envelopes are dropped; archived ones are kept (and skipped when the preset runs).
    const amounts = Object.entries(form.amounts)
      .filter(([envelopeId, amount]) => amount > 0 && known.has(envelopeId))
      .map(([envelopeId, amount]) => ({ envelopeId, amount }));
    if (amounts.length === 0) {
      setFormError(t("Enter an amount for at least one envelope."));
      return;
    }
    const preset: AllocationPreset = { id: form.id ?? crypto.randomUUID(), name, mode: form.mode, amounts };
    update({ allocationPresets: form.id ? presets.map((p) => (p.id === form.id ? preset : p)) : [...presets, preset] });
    closeForm();
  };

  const remove = (p: AllocationPreset) => {
    if (!window.confirm(t("Delete preset “{name}”?", { name: p.name }))) return;
    update({ allocationPresets: presets.filter((x) => x.id !== p.id) });
  };

  const formTotal = form ? Object.values(form.amounts).reduce((s, a) => s + (a > 0 ? a : 0), 0) : 0;

  const smallBtn = (danger = false): CSSProperties => ({
    padding: "5px 10px",
    borderRadius: 8,
    border: `1px solid ${danger ? CORAL : C.line}`,
    background: "transparent",
    color: danger ? CORAL : C.text,
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  });

  return form ? (
    <>
      <div style={{ fontSize: 16.5, fontWeight: 700, color: C.text, marginBottom: 12 }}>{form.id ? t("Edit preset") : t("New preset")}</div>
      <label style={{ display: "block", fontSize: 12, color: C.soft, marginBottom: 4 }}>
        {t("Name")}
        <input
          value={form.name}
          maxLength={80}
          placeholder={t("e.g. Payday")}
          onChange={(e) => {
            setForm({ ...form, name: e.target.value });
            setFormError(null);
          }}
          style={{
            display: "block",
            width: "100%",
            boxSizing: "border-box",
            marginTop: 4,
            padding: "9px 11px",
            borderRadius: 9,
            border: `1px solid ${C.line}`,
            background: C.bg,
            color: C.text,
            fontSize: 16,
            fontFamily: font,
          }}
        />
      </label>

      <div role="radiogroup" aria-label={t("How amounts are applied")} style={{ display: "flex", flexDirection: "column", gap: 7, margin: "12px 0" }}>
        <StrategyOption
          C={C}
          name={t("Add amounts")}
          desc={t("Each amount is added on top of what the envelope already has this month.")}
          active={form.mode === "add"}
          onSelect={() => setForm({ ...form, mode: "add" })}
        />
        <StrategyOption
          C={C}
          name={t("Top up to amounts")}
          desc={t("Each envelope is filled up to its amount for the month; one that already has it gets nothing more.")}
          active={form.mode === "topUp"}
          onSelect={() => setForm({ ...form, mode: "topUp" })}
        />
      </div>

      <button onClick={fillFromMonth} style={{ ...dashedButton(C), marginBottom: 6 }}>
        {t("Fill from this month's allocations")}
      </button>

      {groups.map((g) => (
        <div key={g.key}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0.7,
              textTransform: "uppercase",
              color: C.soft,
              padding: "10px 0 4px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {g.name}
          </div>
          {g.envelopes.map((e, i) => {
            const amount = form.amounts[e.id] ?? 0;
            return (
              <div
                key={e.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "7px 0",
                  borderBottom: i < g.envelopes.length - 1 ? `1px solid ${C.line}` : "none",
                }}
              >
                <EnvelopeChip C={C} env={e} />
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 13,
                    fontWeight: 600,
                    color: amount > 0 ? C.text : C.soft,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {e.name}
                </span>
                <AmountBox
                  C={C}
                  label={e.name}
                  value={amount > 0 ? localizePadExpression(fmtTrim(amount), lang) : ""}
                  highlight={amount > 0}
                  symbol={currencySymbol(currency, lang)}
                  onOpen={() =>
                    onPad({
                      label: e.name,
                      initial: amount,
                      onCommit: (minor) => {
                        setForm((f) => (f ? { ...f, amounts: { ...f.amounts, [e.id]: minor } } : f));
                        setFormError(null);
                      },
                    })
                  }
                />
              </div>
            );
          })}
        </div>
      ))}

      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: C.soft, margin: "12px 0 10px" }}>
        <span>{t("Total")}</span>
        <b style={{ color: C.text, fontVariantNumeric: "tabular-nums" }}>{money(formTotal)}</b>
      </div>
      {formError && (
        <div role="alert" style={{ fontSize: 12.5, color: CORAL, marginBottom: 8 }}>
          {formError}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={closeForm} style={{ ...secondaryButton(C), flex: 1 }}>
          {t("Cancel")}
        </button>
        <button
          onClick={save}
          disabled={!form.name.trim()}
          style={{
            flex: 2,
            padding: "10px 0",
            borderRadius: 10,
            border: "none",
            background: CTA,
            color: "#fff",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            opacity: form.name.trim() ? 1 : 0.5,
          }}
        >
          {t("Save")}
        </button>
      </div>
    </>
  ) : (
    <>
      <div style={{ fontSize: 16.5, fontWeight: 700, color: C.text, marginBottom: 4 }}>{t("Presets")}</div>
      <div style={{ fontSize: 12, color: C.soft, lineHeight: 1.5, marginBottom: 8 }}>
        {t("A preset is a named set of amounts per envelope — for example, what you set aside every payday.")}
      </div>
      {presets.map((p) => (
        <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 0", borderBottom: `1px solid ${C.line}` }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 13.5, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {p.name}
            </span>
            <span style={{ display: "block", fontSize: 11, color: C.mute, marginTop: 1 }}>{presetSummary(p, tp, money)}</span>
          </span>
          <button
            onClick={() => {
              setForm({ id: p.id, name: p.name, mode: p.mode, amounts: Object.fromEntries(p.amounts.map((a) => [a.envelopeId, a.amount])) });
              setFormError(null);
            }}
            style={smallBtn()}
          >
            {t("Edit")}
          </button>
          <button onClick={() => remove(p)} style={smallBtn(true)}>
            {t("Delete")}
          </button>
        </div>
      ))}
      <button
        onClick={() => {
          setForm(emptyForm());
          setFormError(null);
        }}
        style={{ ...dashedButton(C), marginTop: 12 }}
      >
        {t("+ New preset")}
      </button>
      <div style={{ fontSize: 11, color: C.mute, lineHeight: 1.5, marginTop: 12 }}>{t("Presets follow this budget on every device.")}</div>
      <button onClick={onClose} style={{ ...secondaryButton(C), width: "100%", marginTop: 14 }}>
        {t("Back")}
      </button>
    </>
  );
}
