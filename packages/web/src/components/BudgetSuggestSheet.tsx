import { useEffect, useState, type CSSProperties } from "react";
import { buildBudgetSuggestionBasis, buildPrevMonthSuggestion, buildTopUpNegativesSuggestion, computeStateResponse, type ClientLedger, type NormalizedBudgetSuggestion } from "@enveo/shared";
import { Sheet } from "./chrome";
import { AiConsentSheet } from "./AiConsentSheet";
import { AmountPadHost, type AmountPadTarget } from "./AmountPadSheet";
import { useCurrency, useSettings, type Settings } from "../lib/contexts";
import { currencySymbol, fmtTrim, formatMoney, isLight, parseAmount } from "../lib/format";
import { useT, type Message, msg } from "../lib/i18n";
import { Glyph, Ico } from "../lib/icons";
import { CORAL, CTA, TEAL, font, tint, type Theme } from "../lib/theme";
import { apiErrorMessage, type BudgetSuggestProfile, type BudgetSuggestResponse, type StateResponse } from "../lib/api";
import { runSuggest } from "../lib/ai";
import { local } from "../lib/mutate";
import { store } from "../lib/store";

/** Predefined rules-engine strategies (no "custom" — user-defined ones are always named). */
const PROFILES: Array<{ id: BudgetSuggestProfile; labelKey: Message; descKey: Message }> = [
  { id: "cautious", labelKey: msg("By history"), descKey: msg("Median of historical monthly spending — resistant to one-off spikes; the free remainder is spread proportionally.") },
  { id: "investor", labelKey: msg("Investor"), descKey: msg("Savings envelopes first — the free remainder goes to them.") },
];

const LOCK_D = "M8 11V7a4 4 0 018 0v4M6 11h12v9H6z";
const GEAR_D = "M12 15a3 3 0 100-6 3 3 0 000 6zm7.4-3a7.4 7.4 0 00-.1-1.2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 00-2.1-1.2L14.4 3h-4l-.4 2.6a7.5 7.5 0 00-2.1 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 000 2.4l-2 1.6 2 3.4 2.4-1c.6.5 1.4.9 2.1 1.2l.4 2.6h4l.4-2.6a7.5 7.5 0 002.1-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z";

type CustomProfile = Settings["customProfiles"][number];

type Phase = "setup" | "loading" | "review";

/** Deterministic strategies (local, zero AI/egress/consent). */
type DetStrategy = "topUp" | "prevMonth";

/** 'YYYY-MM' → previous month 'YYYY-MM'. */
const prevMonthOf = (month: string): string => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};

/**
 * Engine warning CODE → the sentence a user reads. The suggestion engines (shared/aiBudget.ts and
 * the /budget/suggest route) emit codes, never prose — the wording lives here, in every locale.
 * "remainder" is skipped: its own line below carries the amount. An unknown code renders nothing
 * (a raw `warn.*` on screen is worse than silence).
 */
const WARNINGS: Record<string, Message> = {
  over_tbb: msg("The proposal exceeds “To be budgeted” — uncheck or reduce items."),
  agent_empty: msg("The agent proposed no distribution — refine your prompt."),
  agent_requires_ai: msg("Requires AI (server mode or your own key)."),
  "warn.capped": msg("Some funds stayed in To be budgeted — envelopes are at their target caps."),
  "warn.nothingToDistribute": msg("To be budgeted is ≤ 0 — there is nothing to distribute."),
  "warn.aiUnavailable": msg("AI unavailable — rules were used instead."),
};
const warnMessage = (w: string): Message | undefined => WARNINGS[w];

/** Agent tool → label in the "Agent checked: …" line (submit and unknown tools skipped). */
const TRACE_LABELS: Record<string, Message> = {
  get_month_state: msg("month state"),
  get_history: msg("history"),
  get_spending: msg("spending breakdown"),
  get_goals: msg("goals"),
};

export function BudgetSuggestSheet({ show, state, month, onClose }: { show: boolean; state: StateResponse; month: string; onClose: () => void }) {
  const { t, lang } = useT();
  const currency = useCurrency();
  const { settings } = useSettings();
  const [phase, setPhase] = useState<Phase>("setup");
  const [profile, setProfile] = useState<BudgetSuggestProfile>("cautious");
  /** Selected CUSTOM profile (id from settings.customProfiles) — then profile==="custom". */
  const [selCustom, setSelCustom] = useState<string | null>(null);
  /** Selected deterministic strategy (takes precedence over profiles). */
  const [det, setDet] = useState<DetStrategy | null>(null);
  const [resp, setResp] = useState<BudgetSuggestResponse | null>(null);
  const [edited, setEdited] = useState<Record<string, string>>({}); // envelopeId -> amount string
  const [checked, setChecked] = useState<Record<string, boolean>>({}); // envelopeId -> selection
  const [error, setError] = useState<string | null>(null);
  const [showManage, setShowManage] = useState(false);
  // AI consent — asked once per sheet session (until close), only in off mode.
  const [showConsent, setShowConsent] = useState(false);
  const [consented, setConsented] = useState(false);
  const [pendingGen, setPendingGen] = useState(false);
  // One numpad sheet per review — the correction row supplies the target on tap.
  const [pad, setPad] = useState<AmountPadTarget | null>(null);

  const envById = new Map(state.envelopes.map((e) => [e.id, e]));
  const selProfile = profile === "custom" && selCustom ? settings.customProfiles.find((p) => p.id === selCustom) : undefined;
  const effectivePrompt = selProfile?.prompt;
  const customDisabled = settings.aiMode === "off"; // custom profile = agent, requires AI

  // A profile deleted in "Manage" also disappears from the picker — fall back to Historical.
  useEffect(() => {
    if (profile === "custom" && !selProfile) { setProfile("cautious"); setSelCustom(null); }
  }, [profile, selProfile]);

  const reset = () => { setPhase("setup"); setResp(null); setEdited({}); setChecked({}); setError(null); };
  const close = () => { reset(); setShowConsent(false); setConsented(false); setShowManage(false); onClose(); };

  const startReview = (r: BudgetSuggestResponse) => {
    setResp(r);
    setEdited(Object.fromEntries(r.items.map((i) => [i.envelopeId, fmtTrim(i.proposedDelta)])));
    setChecked(Object.fromEntries(r.items.map((i) => [i.envelopeId, true])));
    setPhase("review");
  };

  const doGenerate = async () => {
    const ledger = store.getLedger();
    if (!ledger) { setError(t("The local replica is not ready.")); return; }
    setPhase("loading");
    setError(null);
    try {
      const r = await runSuggest({ ledger, month, profile, customPrompt: effectivePrompt, locale: lang, settings });
      startReview(r);
    } catch (e) {
      setError(apiErrorMessage(e));
      setPhase("setup");
    }
  };

  /** Deterministic strategies: computed LOCALLY on the replica — zero AI, zero fetch, zero consent. */
  const doDetGenerate = (kind: DetStrategy) => {
    const ledger = store.getLedger();
    if (!ledger) { setError(t("The local replica is not ready.")); return; }
    setError(null);
    const basis = buildBudgetSuggestionBasis({ ledger, month, profile: "historical" });
    const norm: NormalizedBudgetSuggestion =
      kind === "topUp" ? buildTopUpNegativesSuggestion(basis) : buildPrevMonthSuggestion(basis, prevAllocations(ledger, month));
    startReview({
      month,
      profile: "historical",
      source: "rules",
      amountToDistribute: basis.amountToDistribute,
      undistributedRemainder: norm.undistributedRemainder,
      generatedAt: new Date().toISOString(),
      items: norm.items,
      warnings: norm.warnings,
    });
  };

  // Generation deferred by one render: the AiConsentSheet decision saves settings
  // (same React batch), so the effect already sees the FRESH mode/key from context.
  useEffect(() => {
    if (!pendingGen) return;
    setPendingGen(false);
    void doGenerate();
  }, [pendingGen]); // eslint-disable-line react-hooks/exhaustive-deps

  const generate = () => {
    if (det) { doDetGenerate(det); return; }
    if (settings.aiMode === "off" && !consented) { setShowConsent(true); return; }
    void doGenerate();
  };

  const editedMinor = (id: string, fallback: number): number => {
    const raw = edited[id];
    if (raw === undefined) return fallback;
    const v = raw.trim() === "" ? 0 : parseAmount(raw);
    return v === null ? fallback : v;
  };

  const deltaOf = (it: BudgetSuggestResponse["items"][number]): number => editedMinor(it.envelopeId, it.proposedDelta);

  const openPadFor = (it: BudgetSuggestResponse["items"][number]) =>
    setPad({
      label: envById.get(it.envelopeId)?.name ?? it.envelopeId,
      initial: deltaOf(it),
      onCommit: (minor) => setEdited((s) => ({ ...s, [it.envelopeId]: fmtTrim(minor) })),
    });

  const apply = () => {
    if (!resp) return;
    // Staleness guard: recompute the current state from the replica and compare with the generation basis.
    const ledger = store.getLedger();
    const live = ledger ? computeStateResponse(ledger, month) : null;
    if (!live || live.toBeBudgeted !== resp.amountToDistribute) {
      setError(t("The budget has changed since this was generated — generate a new suggestion."));
      return;
    }
    // Apply covers ONLY checked items with a positive (edited) delta — partial application is OK.
    const chosen = resp.items.filter((it) => checked[it.envelopeId] && deltaOf(it) > 0);
    for (const it of chosen) {
      const liveEnv = live.envelopes.find((e) => e.id === it.envelopeId);
      if (!liveEnv || liveEnv.archived || liveEnv.allocated !== it.currentAllocated) {
        setError(t("Envelopes have changed since this was generated — generate a new suggestion."));
        return;
      }
    }
    for (const it of chosen) {
      local.setAllocation({ envelopeId: it.envelopeId, month, amount: it.currentAllocated + deltaOf(it) });
    }
    close();
  };

  /* ── Result view (W3): items grouped by envelope groups like on the Budget screen ── */
  const sections = resp
    ? (() => {
        const itemsById = new Map(resp.items.map((it) => [it.envelopeId, it]));
        const list = [...state.groups]
          .sort((a, b) => a.sort - b.sort)
          .map((g) => ({
            key: g.id,
            name: g.name,
            rows: state.envelopes
              .filter((e) => e.groupId === g.id && itemsById.has(e.id))
              .sort((a, b) => a.sort - b.sort)
              .map((e) => itemsById.get(e.id)!),
          }))
          .filter((s) => s.rows.length > 0);
        // Theoretical edge case: items with no envelope in state (e.g. a race with sync) — appended without a header.
        const orphans = resp.items.filter((it) => !envById.has(it.envelopeId));
        if (orphans.length > 0) list.push({ key: "__orphans", name: "", rows: orphans });
        return list;
      })()
    : [];

  /** Agent trace labels: duplicates merged (Set over keys), ordered by first invocation. */
  const traceLabels = resp?.trace
    ? [...new Set(resp.trace.map((s) => TRACE_LABELS[s.tool]).filter((k): k is Message => k !== undefined))].map((k) => t(k))
    : [];

  const sumChecked = resp ? resp.items.reduce((s, it) => s + (checked[it.envelopeId] ? deltaOf(it) : 0), 0) : 0;
  const remaining = resp ? resp.amountToDistribute - sumChecked : 0;
  const nSel = resp ? resp.items.filter((it) => checked[it.envelopeId] && deltaOf(it) > 0).length : 0;

  const toggleRow = (id: string) => setChecked((s) => ({ ...s, [id]: !s[id] }));
  /** Tap on a group header: fully checked → uncheck all; otherwise check all. */
  const toggleGroup = (rows: BudgetSuggestResponse["items"]) => {
    const allOn = rows.every((it) => checked[it.envelopeId]);
    setChecked((s) => {
      const next = { ...s };
      for (const it of rows) next[it.envelopeId] = !allOn;
      return next;
    });
  };

  return (
    <>
    <Sheet show={show} onClose={close}>
      {(C) => (
        <>
          <div style={{ fontSize: 17, fontWeight: 700, color: C.text, marginBottom: 4 }}>{t("Suggest a distribution")}</div>
          <div style={{ fontSize: 12.5, color: C.soft, marginBottom: 14 }}>
            {t("To be budgeted this month:")} <b style={{ color: state.toBeBudgeted < 0 ? CORAL : C.text, fontVariantNumeric: "tabular-nums" }}>{formatMoney(Math.max(0, state.toBeBudgeted), currency, lang, { trim: true })}</b>
          </div>

          {phase !== "review" && (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "2px 0 8px" }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: C.mute, letterSpacing: 0.5, textTransform: "uppercase" }}>{t("Strategy")}</span>
                <button onClick={() => setShowManage(true)} aria-label={t("Manage…")} style={{ width: 28, height: 28, borderRadius: 9, border: "none", background: C.inset, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Ico d={GEAR_D} size={15} color={C.soft} sw={1.4} />
                </button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7, marginBottom: 14 }}>
                <StrategyOption C={C} name={t("Top up negatives")} desc={t("Distributes the amount only to envelopes in the red — proportionally to shortfalls, never past zero.")} badge="noai" active={det === "topUp"} onSelect={() => { setDet("topUp"); setSelCustom(null); }} />
                <StrategyOption C={C} name={t("Like last month")} desc={t("Tops envelopes up to last month's allocations. Uncheck what you don't want.")} badge="noai" active={det === "prevMonth"} onSelect={() => { setDet("prevMonth"); setSelCustom(null); }} />
                {PROFILES.map((p) => (
                  <StrategyOption key={p.id} C={C} name={t(p.labelKey)} desc={t(p.descKey)} badge={settings.aiMode === "off" ? "noai" : "ai"} active={!det && profile === p.id && !selProfile} onSelect={() => { setDet(null); setProfile(p.id); setSelCustom(null); }} />
                ))}
                {settings.customProfiles.map((cp) => (
                  <StrategyOption
                    key={cp.id}
                    C={C}
                    name={`✎ ${cp.name}`}
                    desc={`“${cp.prompt}”`}
                    badge="ai"
                    note={customDisabled ? t("Requires AI (server mode or your own key).") : undefined}
                    disabled={customDisabled}
                    active={!det && selProfile?.id === cp.id}
                    onSelect={() => { setDet(null); setProfile("custom"); setSelCustom(cp.id); }}
                  />
                ))}
              </div>
              {error && <div style={{ fontSize: 12.5, color: CORAL, marginBottom: 10 }}>{error}</div>}
              <button onClick={generate} disabled={phase === "loading" || state.toBeBudgeted <= 0} style={{ width: "100%", padding: "12px 0", borderRadius: 12, border: "none", background: CTA, color: "#fff", fontSize: 13.5, fontWeight: 600, cursor: "pointer", opacity: phase === "loading" || state.toBeBudgeted <= 0 ? 0.5 : 1 }}>
                {phase === "loading" ? t("Generating…") : state.toBeBudgeted <= 0 ? t("No funds to distribute") : t("Generate suggestion")}
              </button>
            </>
          )}

          {phase === "review" && resp && (
            <>
              <div style={{ fontSize: 11, color: C.mute, marginBottom: 6 }}>
                {t("Source: {src}", { src: resp.source === "rules" ? t("rules") : resp.source === "ai" ? t("AI") : t("AI (corrected)") })}
                {resp.warnings.map((w, i) => {
                  const m = warnMessage(w);
                  return m ? <div key={i} style={{ color: CORAL, marginTop: 3 }}>{t(m)}</div> : null;
                })}
                {resp.undistributedRemainder > 0 && <div style={{ color: CORAL, marginTop: 3 }}>{t("{amount} stays in “To be budgeted”.", { amount: formatMoney(resp.undistributedRemainder, currency, lang, { trim: true }) })}</div>}
              </div>

              {/* Agent trace: what it checked with tools before proposing (custom mode only). */}
              {traceLabels.length > 0 && (
                <div style={{ fontSize: 12.5, color: C.soft, marginBottom: 6 }}>
                  {t("Agent checked:")} {traceLabels.join(", ")}
                </div>
              )}

              {sections.map((s) => {
                const anyOn = s.rows.some((it) => checked[it.envelopeId]);
                const allOn = s.rows.every((it) => checked[it.envelopeId]);
                // Sum of the group's checked items; a skipped group shows the struck-through sum of all.
                const groupSum = s.rows.reduce((x, it) => x + (!anyOn || checked[it.envelopeId] ? deltaOf(it) : 0), 0);
                return (
                  <div key={s.key}>
                    {s.name !== "" && (
                      <button onClick={() => toggleGroup(s.rows)} role="checkbox" aria-checked={allOn} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", border: "none", background: "none", padding: "10px 0 6px", cursor: "pointer", textAlign: "left" }}>
                        <CheckBox on={allOn} C={C} />
                        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, fontWeight: 700, letterSpacing: 0.7, textTransform: "uppercase", color: C.soft, opacity: anyOn ? 1 : 0.5 }}>
                          {s.name}{anyOn ? "" : ` — ${t("skipped")}`}
                        </span>
                        <span style={{ fontSize: 11, color: C.mute, fontWeight: 600, fontVariantNumeric: "tabular-nums", textDecoration: anyOn ? "none" : "line-through" }}>
                          {formatMoney(groupSum, currency, lang, { trim: true })}
                        </span>
                      </button>
                    )}
                    {s.rows.map((it, ri) => {
                      const on = !!checked[it.envelopeId];
                      const env = envById.get(it.envelopeId);
                      const delta = deltaOf(it);
                      const isEdited = delta !== it.proposedDelta;
                      return (
                        <div key={it.envelopeId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: ri < s.rows.length - 1 ? `1px solid ${C.line}` : "none" }}>
                          <button onClick={() => toggleRow(it.envelopeId)} role="checkbox" aria-checked={on} aria-label={env?.name ?? it.envelopeId} style={{ border: "none", background: "none", padding: 0, cursor: "pointer", display: "flex" }}>
                            <CheckBox on={on} C={C} />
                          </button>
                          <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0, opacity: on ? 1 : 0.4 }}>
                            <div style={{ width: 30, height: 30, borderRadius: 8, flexShrink: 0, background: env?.color ?? C.inset, display: "flex", alignItems: "center", justifyContent: "center" }}>
                              <Glyph name={env?.icon ?? "wallet"} size={14} color={env && isLight(env.color) ? "#33312c" : "#fff"} sw={1.6} />
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 13, fontWeight: 600, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{env?.name ?? it.envelopeId}</div>
                              <div style={{ fontSize: 10.5, color: C.mute }}>
                                {on ? t("available after: {amount}", { amount: formatMoney(it.currentAvailable + delta, currency, lang, { trim: true }) }) : t("skipped")}
                              </div>
                            </div>
                            <div onClick={on ? () => openPadFor(it) : undefined} style={{ display: "flex", alignItems: "center", gap: 3, border: `1px solid ${on && isEdited ? TEAL : C.line}`, background: C.inset, borderRadius: 9, padding: "6px 9px", cursor: on ? "pointer" : "default" }}>
                              <span style={{ fontSize: 11, color: C.soft }}>+</span>
                              <input
                                value={edited[it.envelopeId] ?? ""}
                                readOnly
                                tabIndex={on ? 0 : -1}
                                onClick={on ? () => openPadFor(it) : undefined}
                                onFocus={on ? () => openPadFor(it) : undefined}
                                style={{ width: 60, background: "none", border: "none", outline: "none", textAlign: "right", fontSize: 13, fontWeight: 700, color: on && isEdited ? TEAL : C.text, fontFamily: font, fontVariantNumeric: "tabular-nums", cursor: on ? "pointer" : "default", textDecoration: on ? "none" : "line-through", padding: 0 }}
                              />
                              <span style={{ fontSize: 11, color: C.soft }}>{currencySymbol(currency, lang)}</span>
                            </div>
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
              <div style={{ position: "sticky", bottom: 0, zIndex: 3, background: C.sheet, borderTop: `1px solid ${C.line}`, margin: "10px -20px 0", padding: "10px 20px 4px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: remaining >= 0 ? C.pos : C.neg }}>{t(remaining >= 0 ? msg("Left after changes") : msg("Short after changes"))}</span>
                  <span style={{ fontSize: 16, fontWeight: 700, color: remaining >= 0 ? C.pos : C.neg, fontVariantNumeric: "tabular-nums" }}>
                    {(remaining >= 0 ? "+" : "−") + formatMoney(Math.abs(remaining), currency, lang, { trim: true })}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 10 }}>
                  <button onClick={reset} style={{ flex: 1, padding: "11px 0", borderRadius: 12, border: `1px solid ${C.line}`, background: "transparent", color: C.text, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>{t("Back")}</button>
                  <button onClick={apply} disabled={nSel === 0} style={{ flex: 2, padding: "11px 0", borderRadius: 12, border: "none", background: CTA, color: "#fff", fontSize: 13.5, fontWeight: 600, cursor: "pointer", opacity: nSel === 0 ? 0.5 : 1 }}>{t("Apply ({n})", { n: nSel })}</button>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </Sheet>
    {/* Sibling of the Sheet (not a child) — the panel's transform would break position:fixed. */}
    <ProfileManageSheet show={showManage} onClose={() => setShowManage(false)} />
    <AmountPadHost target={pad} onClose={() => setPad(null)} />
    <AiConsentSheet
      show={showConsent}
      feature="suggest"
      onClose={() => setShowConsent(false)}
      onDecided={() => {
        // "rules" keeps aiMode=off (local), server/byok have already saved settings —
        // we generate in every case, with the fresh mode (pendingGen effect).
        setShowConsent(false);
        setConsented(true);
        setPendingGen(true);
      }}
    />
    </>
  );
}

/** PREVIOUS month's allocations per envelope (summed — the replica may hold multiple entries). */
function prevAllocations(ledger: ClientLedger, month: string): Map<string, number> {
  const prev = prevMonthOf(month);
  const map = new Map<string, number>();
  for (const a of ledger.allocations) {
    if (a.month === prev) map.set(a.envelopeId, (map.get(a.envelopeId) ?? 0) + a.amount);
  }
  return map;
}

/** Result-list checkbox: 20px, radius 7, ✓ on C.pos (import list pattern). */
function CheckBox({ on, C }: { on: boolean; C: Theme }) {
  return (
    <span aria-hidden style={{ width: 20, height: 20, borderRadius: 7, flexShrink: 0, boxSizing: "border-box", border: `1.6px solid ${on ? C.pos : C.mute}`, background: on ? C.pos : "transparent", display: "flex", alignItems: "center", justifyContent: "center" }}>
      {on && (
        <svg width={12} height={12} viewBox="0 0 24 24" fill="none" style={{ stroke: "#fff" }} strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 12l6 6L20 6" />
        </svg>
      )}
    </span>
  );
}

/** Strategy radio row: dot, name, one-line description (custom ones: start of the prompt). */
function StrategyOption({ C, name, desc, note, badge, active, disabled, onSelect }: { C: Theme; name: string; desc: string; note?: string; badge?: "noai" | "ai"; active: boolean; disabled?: boolean; onSelect: () => void }) {
  const { t } = useT();
  return (
    <button onClick={disabled ? undefined : onSelect} role="radio" aria-checked={active} aria-disabled={disabled || undefined} style={{ display: "flex", alignItems: "flex-start", gap: 11, width: "100%", textAlign: "left", padding: "11px 13px", borderRadius: 13, border: `1px solid ${active ? TEAL : C.line}`, background: active ? "var(--accent-14)" : "transparent", cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.45 : 1 }}>
      <span style={{ width: 18, height: 18, borderRadius: "50%", border: `2px solid ${active ? TEAL : C.mute}`, flexShrink: 0, marginTop: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {active && <span style={{ width: 8, height: 8, borderRadius: "50%", background: TEAL }} />}
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: active ? TEAL : C.text, minWidth: 0 }}>{name}</span>
          {badge && (
            <span style={{ marginLeft: "auto", flexShrink: 0, marginTop: 1, fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, padding: "2px 7px", borderRadius: 8, background: badge === "noai" ? tint(C.pos, 0.15) : tint(C.warn, 0.15), color: badge === "noai" ? C.pos : C.warn }}>
              {badge === "noai" ? t("NO AI") : t("AI")}
            </span>
          )}
        </span>
        <span style={{ display: "block", fontSize: 11.5, color: C.soft, lineHeight: 1.4, marginTop: 2 }}>{desc}</span>
        {note && <span style={{ display: "block", fontSize: 10.5, color: C.mute, marginTop: 3 }}>{note}</span>}
      </span>
    </button>
  );
}

/**
 * Profile management: predefined (preview + lock, no editing) and custom
 * (add/edit/delete) — stored in settings.customProfiles (this device only).
 */
function ProfileManageSheet({ show, onClose }: { show: boolean; onClose: () => void }) {
  const { t } = useT();
  const { settings, setSettings } = useSettings();
  const [form, setForm] = useState<{ id: string | null; name: string; prompt: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const closeForm = () => { setForm(null); setFormError(null); };
  const close = () => { closeForm(); onClose(); };

  const save = () => {
    if (!form) return;
    const name = form.name.trim();
    const prompt = form.prompt.trim();
    if (!name || !prompt) return;
    const taken = settings.customProfiles.some((p) => p.id !== form.id && p.name.trim().toLowerCase() === name.toLowerCase());
    if (taken) { setFormError(t("A profile with this name already exists.")); return; }
    const next: CustomProfile[] = form.id
      ? settings.customProfiles.map((p) => (p.id === form.id ? { ...p, name, prompt } : p))
      : [...settings.customProfiles, { id: crypto.randomUUID(), name, prompt }];
    setSettings({ ...settings, customProfiles: next });
    closeForm();
  };

  const remove = (p: CustomProfile) => {
    if (!window.confirm(t("Delete profile “{name}”?", { name: p.name }))) return;
    setSettings({ ...settings, customProfiles: settings.customProfiles.filter((x) => x.id !== p.id) });
  };

  const rowStyle = (C: Theme): CSSProperties => ({ display: "flex", alignItems: "center", gap: 8, padding: "9px 0", borderBottom: `1px solid ${C.line}` });
  const smallBtn = (C: Theme, danger = false): CSSProperties => ({ padding: "5px 10px", borderRadius: 8, border: `1px solid ${danger ? CORAL : C.line}`, background: "transparent", color: danger ? CORAL : C.text, fontSize: 12, fontWeight: 600, cursor: "pointer" });
  const inputStyle = (C: Theme): CSSProperties => ({ width: "100%", boxSizing: "border-box", padding: "9px 11px", borderRadius: 9, border: `1px solid ${C.line}`, background: C.bg, color: C.text, fontSize: 13, fontFamily: font, outline: "none", marginBottom: 8 });

  return (
    <Sheet show={show} onClose={close}>
      {(C) => (
        <>
          <div style={{ fontSize: 16.5, fontWeight: 700, color: C.text, marginBottom: 12 }}>{t("Manage…")}</div>

          <div style={{ fontSize: 11, fontWeight: 700, color: C.mute, letterSpacing: 0.4, textTransform: "uppercase", marginBottom: 2 }}>{t("Predefined")}</div>
          {PROFILES.map((p) => (
            <div key={p.id} style={rowStyle(C)}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 13.5, color: C.text }}>{t(p.labelKey)}</span>
                <span style={{ display: "block", fontSize: 11, color: C.mute, lineHeight: 1.4, marginTop: 1 }}>{t(p.descKey)}</span>
              </span>
              <Ico d={LOCK_D} size={14} color={C.mute} sw={1.5} />
            </div>
          ))}

          <div style={{ fontSize: 11, fontWeight: 700, color: C.mute, letterSpacing: 0.4, textTransform: "uppercase", margin: "14px 0 2px" }}>{t("Custom")}</div>
          {settings.customProfiles.map((p) => (
            <div key={p.id} style={rowStyle(C)}>
              <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>✎ {p.name}</span>
              <button onClick={() => { setForm({ id: p.id, name: p.name, prompt: p.prompt }); setFormError(null); }} style={smallBtn(C)}>{t("Edit")}</button>
              <button onClick={() => remove(p)} style={smallBtn(C, true)}>{t("Delete")}</button>
            </div>
          ))}

          {form ? (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, color: C.soft, marginBottom: 4 }}>{t("Name")}</div>
              <input value={form.name} onChange={(e) => { setForm({ ...form, name: e.target.value }); setFormError(null); }} style={inputStyle(C)} />
              <div style={{ fontSize: 12, color: C.soft, marginBottom: 4 }}>{t("Prompt")}</div>
              <textarea value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} maxLength={2000} rows={4} placeholder={t("Describe how to distribute (e.g. prioritize savings, less on entertainment)")} style={{ ...inputStyle(C), resize: "vertical" }} />
              {formError && <div style={{ fontSize: 12.5, color: CORAL, marginBottom: 8 }}>{formError}</div>}
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={closeForm} style={{ flex: 1, padding: "10px 0", borderRadius: 10, border: `1px solid ${C.line}`, background: "transparent", color: C.text, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>{t("Cancel")}</button>
                <button onClick={save} disabled={!form.name.trim() || !form.prompt.trim()} style={{ flex: 2, padding: "10px 0", borderRadius: 10, border: "none", background: CTA, color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", opacity: form.name.trim() && form.prompt.trim() ? 1 : 0.5 }}>{t("Save")}</button>
              </div>
            </div>
          ) : (
            <button onClick={() => { setForm({ id: null, name: "", prompt: "" }); setFormError(null); }} style={{ width: "100%", marginTop: 12, padding: "11px 0", borderRadius: 12, border: `1px dashed ${C.line}`, background: "transparent", color: C.text, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>{t("+ Add profile")}</button>
          )}

          <div style={{ fontSize: 11, color: C.mute, lineHeight: 1.5, marginTop: 12 }}>{t("Custom profiles are stored only on this device.")}</div>
        </>
      )}
    </Sheet>
  );
}
