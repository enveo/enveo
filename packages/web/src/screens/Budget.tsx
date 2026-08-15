import { lazy, useEffect, useState } from "react";
import { AmountPadHost, type AmountPadTarget } from "../components/AmountPadSheet";
import { Header, Sheet } from "../components/chrome";
import { DockedNumpad } from "../components/DockedNumpad";
import { IconColorPicker } from "../components/IconColorPicker";
import { CardBox, GoalRing, useBand } from "../components/kit";
import { LazyChunk, useOpenedOnce } from "../components/lazy";
import { fmtSignedTrim, type PadState, padPreview, padPreviewLive } from "../lib/amount";
import type { EnvelopeView, StateResponse } from "../lib/api";
import { useCurrency, useMask, useSettings, useTheme } from "../lib/contexts";
import { useDragReorder } from "../lib/dnd";
import { activeAllocationDecoration } from "../lib/focusPresentation";
import { currencySymbol, fmtTrim, isLight, localizePadExpression, parseAmount } from "../lib/format";
import { goalProgress } from "../lib/goals";
import { useT } from "../lib/i18n";
import { Glyph, Ico } from "../lib/icons";
import { local } from "../lib/mutate";
import { CORAL, ENV_PALETTE, font, P, TEAL, tint } from "../lib/theme";

// The budget assistant is the second AI surface (§3f). It is the only thing on this screen that
// needs the AI dispatch and the response parsers, and it opens on a deliberate tap — so it loads
// then. Allocation, the docked numpad and "Fill by goals" (pure local math) stay eager.
const BudgetSuggestSheet = lazy(() => import("../components/BudgetSuggestSheet").then((m) => ({ default: m.BudgetSuggestSheet })));
// "Fill by goals" is the assistant's twin: same deliberate-tap lifecycle, same one-shot deep link
// from the Goals report. Leaving one of the pair eager and the other lazy would draw an arbitrary
// line through one feature.
const FillGoalsSheet = lazy(() => import("../components/FillGoalsSheet").then((m) => ({ default: m.FillGoalsSheet })));

export function BudgetScreen({
  state,
  month,
  onMenu,
  onPrev,
  onNext,
  onOpenEnvelope,
  initialSuggest,
  onSuggestConsumed,
  initialFillGoals,
  onFillGoalsConsumed,
}: {
  state: StateResponse;
  month: string;
  onMenu: () => void;
  onPrev: () => void;
  onNext: () => void;
  onOpenEnvelope: (envId: string, month: string) => void;
  /** Start "Suggest" quick action — opens the suggest sheet immediately (like Add's `initialImport`). */
  initialSuggest?: boolean;
  /** Consumption ack for `initialSuggest`, called once on mount (see the effect below) — App
   *  clears its flag the instant this screen consumes it, so a LATER remount (this screen
   *  unmounts/remounts on any `envView` toggle — e.g. envelope Summary → back — WITHOUT going
   *  through `nav()`) never sees a stale `true` and reopens the sheet unprompted. */
  onSuggestConsumed: () => void;
  /** Goals-report "Fill ›" deep link — opens the fill-by-goals sheet immediately (same mechanics as `initialSuggest`). */
  initialFillGoals?: boolean;
  /** Consumption ack for `initialFillGoals` — same one-shot mechanism as `onSuggestConsumed`. */
  onFillGoalsConsumed: () => void;
}) {
  const C = useTheme();
  const M = useMask();
  const { t } = useT();
  const [manage, setManage] = useState(false);
  const [suggest, setSuggest] = useState(!!initialSuggest);
  // Latched — see Add.tsx: mount on first open, stay mounted, so state survives close→reopen.
  const suggestOpened = useOpenedOnce(suggest);
  const [fillGoals, setFillGoals] = useState(!!initialFillGoals);
  const fillGoalsOpened = useOpenedOnce(fillGoals);
  // Consume the deep-link flags right at mount, not on close — this component can remount
  // (envelope Summary → back) without ever going through App's `nav()`, which is the only other
  // place these flags get cleared. Consuming here means only the FIRST mount after App sets a
  // flag ever opens its sheet; any later remount sees the flag already `false`.
  useEffect(() => {
    if (initialSuggest) onSuggestConsumed();
    if (initialFillGoals) onFillGoalsConsumed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Entry visibility: money to place AND at least one active envelope still short of its goal.
  // Same predicate as the Goals report's "Fill ›" entry point (Reports.tsx, `canFillGoals`) —
  // kept in sync by inspection, not by shared code (the report's version folds in `missSum`
  // it already computed for its own display).
  const canFillGoals = state.readyToAssign > 0 && state.envelopes.some((e) => !e.archived && (goalProgress(e)?.missing ?? 0) > 0);
  // IN-PLACE allocation editing (docked-numpad spec): one active cell per screen;
  // `err` = ✓ on an uncomputable/negative result, cleared on the next keypress.
  const [editing, setEditing] = useState<{ envelopeId: string; pad: PadState; err?: boolean } | null>(null);

  const groups = [...state.groups].sort((a, b) => a.sort - b.sort);
  const envs = state.envelopes.filter((e) => !e.archived);
  const COLS = "1fr 94px 108px";

  // Commit-or-cancel of the current edit (tap on another envelope): computable → save
  // (negative allowed — moving money back OUT of an envelope is a valid allocation), otherwise discard.
  const commitEditing = (ed: { envelopeId: string; pad: PadState }) => {
    const minor = padPreview(ed.pad.expr);
    const env = envs.find((x) => x.id === ed.envelopeId);
    if (minor !== null && env && minor !== env.allocated) {
      local.setAllocation({ envelopeId: ed.envelopeId, month, amount: minor });
    }
  };
  const startEdit = (env: EnvelopeView, _cell: HTMLElement | null) => {
    if (editing?.envelopeId === env.id) return;
    if (editing) commitEditing(editing);
    setEditing({ envelopeId: env.id, pad: { expr: fmtSignedTrim(env.allocated), fresh: true } });
  };
  // Scroll ONLY after render (double rAF): a synchronous scrollIntoView in the click
  // handler ran before paddingBottom and the pad appeared — bottom envelopes stayed
  // under the keys, because the container had nowhere to scroll to yet.
  useEffect(() => {
    if (!editing?.envelopeId) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        (document.querySelector('[data-pad-cell="1"]') as HTMLElement | null)?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [editing?.envelopeId]);
  // Long expression: keep the end (and the cursor) in view of the overflowX cell.
  useEffect(() => {
    const cell = document.querySelector('[data-pad-cell="1"]') as HTMLElement | null;
    if (cell) cell.scrollLeft = cell.scrollWidth;
  }, [editing?.pad.expr]);
  const activeEnv = editing ? envs.find((x) => x.id === editing.envelopeId) : undefined;
  // padPreviewLive: a trailing operator ("705+") evaluates like "705" — the chip/TBB
  // don't blank out (or strike through) mid-entry; null only for an empty expression.
  const activePreview = editing ? padPreviewLive(editing.pad.expr) : null;
  // Live "To be budgeted" header: with a computable preview, subtract the allocation delta.
  // Based on readyToAssign (month-independent headline), not the month-bounded toBeBudgeted,
  // so editing an allocation moves the same number the user sees on Start.
  const tbbLive = state.readyToAssign - (activeEnv && activePreview !== null ? activePreview - activeEnv.allocated : 0);
  const { band, hc } = useBand();

  return (
    <div className="gs" style={{ flex: 1, overflowY: "auto", paddingBottom: editing ? 300 : 6 }}>
      <div data-band={band || undefined} style={band ? { background: C.headerBg, paddingBottom: 2 } : undefined}>
        <Header month={month} onMenu={onMenu} onPrev={onPrev} onNext={onNext} onRight={() => setManage(true)} rightIcon="pencil" onBand={band} />
      </div>
      <CardBox style={{ margin: `8px ${P}px 10px`, padding: "10px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 10.5, color: C.soft }}>{t("To be budgeted:")}</div>
          {tbbLive === 0 ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 15, fontWeight: 750, color: C.pos, whiteSpace: "nowrap" }}>
              <Ico d="M5 13l4 4L19 7" size={15} color={C.pos} sw={2.4} />
              {t("All money assigned")}
            </div>
          ) : (
            <div
              style={{
                fontSize: 20,
                fontWeight: 800,
                letterSpacing: "-0.015em",
                fontVariantNumeric: "tabular-nums",
                color: tbbLive < 0 ? C.neg : hc("var(--cta)", C.pos),
              }}
            >
              {M(tbbLive)}
            </div>
          )}
          {canFillGoals && (
            <button
              onClick={() => setFillGoals(true)}
              style={{
                marginTop: 2,
                padding: 0,
                background: "none",
                border: "none",
                color: hc("var(--cta)", TEAL),
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: font,
              }}
            >
              {t("Fill by goals")}
            </button>
          )}
        </div>
        <button
          onClick={() => setSuggest(true)}
          aria-label={t("Suggest a distribution")}
          style={{
            flexShrink: 0,
            padding: "6px 13px",
            borderRadius: 999,
            border: `1.5px solid ${hc("var(--cta)", "var(--accent)")}`,
            background: "transparent",
            color: hc("var(--cta)", TEAL),
            fontSize: 11.5,
            fontWeight: 700,
            cursor: "pointer",
            fontFamily: font,
          }}
        >
          {"✨ "}
          {t("Suggest")}
        </button>
      </CardBox>

      <div style={{ display: "grid", gridTemplateColumns: COLS, padding: `0 ${P}px 6px`, gap: 8, alignItems: "start" }}>
        <span style={{ fontSize: 10.5, color: C.mute, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase" }}>{t("Envelope")}</span>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 10.5, color: C.mute, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase" }}>{t("Allocated")}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 10.5, color: C.mute, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase" }}>{t("Available")}</div>
        </div>
      </div>

      {/* Empty state (backstop outside the wizard): no active envelopes → CTA to the manage sheet */}
      {envs.length === 0 && (
        <CardBox style={{ margin: `6px ${P}px 10px`, padding: "12px 14px" }}>
          <button
            onClick={() => setManage(true)}
            style={{
              width: "100%",
              padding: "10px 0",
              borderRadius: 10,
              border: "none",
              background: TEAL,
              color: "#fff",
              fontSize: 12.5,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: font,
            }}
          >
            {t("Create your first envelopes")}
          </button>
        </CardBox>
      )}

      {groups.map((g, gi) => {
        const items = envs.filter((e) => e.groupId === g.id).sort((a, b) => a.sort - b.sort);
        if (!items.length) return null;
        const gA = items.reduce((s, e) => s + e.allocated, 0);
        const gV = items.reduce((s, e) => s + e.available, 0);
        return (
          <div key={g.id} className="fu" style={{ animationDelay: `${gi * 40}ms`, marginBottom: 2 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "7px 18px 4px" }}>
              <span style={{ fontSize: 12, fontWeight: 750, color: C.text }}>{g.name}</span>
              <span style={{ fontSize: 10, color: C.soft, fontVariantNumeric: "tabular-nums" }}>
                {M(gA)} · {M(gV)}
              </span>
            </div>
            <CardBox style={{ padding: "0 12px", marginBottom: 6 }}>
              {items.map((e, ei) => {
                // Live edit context: the active envelope's Available text shows the value AFTER the change;
                // strikethrough only when there is no value (empty expression after ⌫).
                const active = editing?.envelopeId === e.id ? editing : null;
                const struck = !!active && activePreview === null;
                const avail = active && activePreview !== null ? e.available + activePreview - e.allocated : e.available;
                const neg = avail < 0;
                const zero = avail === 0;
                const gp = goalProgress(e);
                return (
                  <div
                    key={e.id}
                    role="button"
                    onClick={() => onOpenEnvelope(e.id, month)}
                    style={{
                      display: "grid",
                      gridTemplateColumns: COLS,
                      padding: "6px 0",
                      gap: 8,
                      width: "100%",
                      boxSizing: "border-box",
                      cursor: "pointer",
                      alignItems: "center",
                      borderBottom: ei === items.length - 1 ? "none" : `1px solid ${C.line}`,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                      <span
                        style={{
                          position: "relative",
                          width: 28,
                          height: 28,
                          flexShrink: 0,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          borderRadius: 8,
                          background: tint(e.color, 0.16),
                        }}
                      >
                        <Glyph name={e.icon} size={14} color={e.color} sw={1.6} />
                        {gp && (
                          <span style={{ position: "absolute", left: -4, top: -4, width: 36, height: 36, pointerEvents: "none" }}>
                            <GoalRing pct={gp.pct} size={36} />
                          </span>
                        )}
                      </span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <span
                          style={{
                            display: "block",
                            fontSize: 14.5,
                            color: C.text,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            textAlign: "left",
                          }}
                        >
                          {e.name}
                        </span>
                        {/* Carry-over from the previous month (Variant A — may be negative); caption under
                            the name so the 3-column grid (name/allocated/available) stays intact.
                            VISUAL: the name column is the narrow 1fr of "1fr 94px 108px" minus the 28px
                            icon — a worded label ("z poprzedniego 92 397,28 zł") ellipsised away the ONLY
                            part that matters, the amount. So the caption is the signed amount alone; the
                            ↳ glyph + pos/neg colour carry the "came from last month" meaning visually, and
                            the full sentence lives in aria-label for screen readers. */}
                        {e.carryIn !== 0 && (
                          <span
                            aria-label={t("from last month {amount}", { amount: `${e.carryIn < 0 ? "-" : "+"}${M(Math.abs(e.carryIn))}` })}
                            style={{
                              display: "block",
                              fontSize: 10.5,
                              fontWeight: 600,
                              color: e.carryIn < 0 ? C.neg : C.pos,
                              fontVariantNumeric: "tabular-nums",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              textAlign: "left",
                            }}
                          >
                            {"↳ "}
                            {e.carryIn < 0 ? "-" : "+"}
                            {M(Math.abs(e.carryIn))}
                          </span>
                        )}
                      </div>
                    </div>
                    <div style={{ position: "relative" }}>
                      <AllocCell e={e} editing={active ? { expr: active.pad.expr, err: active.err } : null} onStart={(el) => startEdit(e, el)} />
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <span
                        style={{
                          fontSize: 13.5,
                          fontWeight: 750,
                          fontVariantNumeric: "tabular-nums",
                          whiteSpace: "nowrap",
                          color: struck ? C.neg : neg ? C.neg : zero ? C.mute : C.text,
                          textDecoration: struck ? "line-through" : "none",
                        }}
                      >
                        {neg ? "-" : ""}
                        {M(Math.abs(avail))}
                      </span>
                    </div>
                  </div>
                );
              })}
            </CardBox>
          </div>
        );
      })}

      <EnvManageSheet show={manage} state={state} onClose={() => setManage(false)} />
      {suggestOpened && (
        <LazyChunk variant="overlay" onDismiss={() => setSuggest(false)}>
          <BudgetSuggestSheet show={suggest} state={state} month={month} onClose={() => setSuggest(false)} />
        </LazyChunk>
      )}
      {fillGoalsOpened && (
        <LazyChunk variant="overlay" onDismiss={() => setFillGoals(false)}>
          <FillGoalsSheet show={fillGoals} state={state} month={month} onClose={() => setFillGoals(false)} />
        </LazyChunk>
      )}
      {/* Docked numpad instead of a sheet (no backdrop — the list stays visible). */}
      <DockedNumpad
        target={
          editing && activeEnv
            ? {
                label: activeEnv.name,
                icon: activeEnv.icon,
                color: activeEnv.color,
                onCommit: (minor) => {
                  if (minor !== activeEnv.allocated) local.setAllocation({ envelopeId: activeEnv.id, month, amount: minor });
                  setEditing(null);
                },
                onCancel: () => setEditing(null),
                onInvalid: () => setEditing((ed) => ed && { ...ed, err: true }),
              }
            : null
        }
        state={editing?.pad ?? null}
        // every keypress clears the error flag (err deliberately omitted)
        onState={(pad) => setEditing((ed) => ed && { envelopeId: ed.envelopeId, pad })}
      />
    </div>
  );
}

/* ── Editable ALLOCATED column (tap = docked numpad, in-place editing) ── */
function AllocCell({ e, editing, onStart }: { e: EnvelopeView; editing: { expr: string; err?: boolean } | null; onStart: (cell: HTMLElement | null) => void }) {
  const C = useTheme();
  const { settings } = useSettings();
  const { t, lang } = useT();
  const currency = useCurrency();
  const box = { background: C.chip, borderRadius: 7, padding: "4px 9px" } as const;
  if (settings.discreet) {
    return <div style={{ ...box, textAlign: "right" as const, fontSize: 13, color: C.text }}>•••• {currencySymbol(currency, lang)}</div>;
  }
  if (editing) {
    // Active cell: the padKey expression in place of the input; err = ✓ on a bad result.
    // stopPropagation: a tap on the edited cell must not open the envelope action sheet.
    const activeColor = editing.err ? "var(--danger)" : "var(--input-underline)";
    return (
      <div
        data-pad-cell="1"
        onClick={(ev) => ev.stopPropagation()}
        aria-label={t("Allocated: {name}", { name: e.name })}
        style={{
          ...box,
          textAlign: "right" as const,
          fontSize: 13,
          color: editing.err ? "var(--danger)" : C.text,
          fontVariantNumeric: "tabular-nums",
          whiteSpace: "nowrap",
          overflowX: "auto",
          boxSizing: "border-box",
          ...activeAllocationDecoration(activeColor),
        }}
      >
        {localizePadExpression(editing.expr, lang) || "0"}
        {/* blinking cursor — like the amount on the Add screen */}
        <span
          style={{
            display: "inline-block",
            width: 2,
            height: 13,
            background: editing.err ? "var(--danger)" : "var(--input-underline)",
            borderRadius: 1,
            marginLeft: 2,
            verticalAlign: "-2px",
            animation: "fi .6s ease-in-out infinite alternate",
          }}
        />
      </div>
    );
  }
  return (
    <div
      onClick={(ev) => {
        ev.stopPropagation();
        onStart(ev.currentTarget);
      }}
      style={{ ...box, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 3, cursor: "pointer" }}
    >
      <input
        // The RESTING cell of the same editor: localized so tapping it (→ the localized pad line
        // above) cannot flip "12,50" to "12.50" for one and the same number. Display only — the
        // pad still starts from fmtSignedTrim(e.allocated), never from this string.
        value={localizePadExpression(fmtSignedTrim(e.allocated), lang)}
        readOnly
        aria-label={t("Allocated: {name}", { name: e.name })}
        onFocus={(ev) => onStart(ev.currentTarget)}
        style={{
          width: "100%",
          minWidth: 0,
          background: "none",
          border: "none",
          textAlign: "right",
          fontSize: 13,
          color: e.allocated < 0 ? C.neg : C.text,
          fontFamily: font,
          fontVariantNumeric: "tabular-nums",
          padding: 0,
          cursor: "pointer",
        }}
      />
    </div>
  );
}

/* ── Envelope and group management ───────────────────────────────────── */
function EnvManageSheet({ show, state, onClose }: { show: boolean; state: StateResponse; onClose: () => void }) {
  const { t } = useT();
  const [newGroup, setNewGroup] = useState("");

  const groups = [...state.groups].sort((a, b) => a.sort - b.sort);
  // flat ordering of all envelopes — shared by the Start screen and budget groups
  const flat = state.envelopes.filter((e) => !e.archived).sort((a, b) => a.sort - b.sort);
  const archived = state.envelopes.filter((e) => e.archived).sort((a, b) => a.sort - b.sort);

  return (
    <Sheet show={show} onClose={onClose}>
      {(C) => (
        <>
          <div style={{ fontSize: 17, fontWeight: 700, color: C.text, marginBottom: 4, textAlign: "center" }}>{t("Manage envelopes")}</div>
          <div style={{ fontSize: 11, color: C.mute, marginBottom: 16, textAlign: "center" }}>{t("Edit names in place; drag the handle to reorder")}</div>

          {groups.map((g) => (
            <ManageGroup key={g.id} g={g} list={flat.filter((e) => e.groupId === g.id)} flat={flat} />
          ))}

          {archived.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 10.5, fontWeight: 600, color: C.mute, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 }}>
                {t("Archived")}
              </div>
              {archived.map((e) => (
                <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", opacity: 0.75 }}>
                  <div
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 6,
                      background: e.color,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    <Glyph name={e.icon} size={12} color={isLight(e.color) ? "#33312c" : "#fff"} sw={1.6} />
                  </div>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: C.soft, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {e.name}
                  </span>
                  <button
                    onClick={() => local.updateEnvelope(e.id, { archived: false })}
                    style={{
                      flexShrink: 0,
                      padding: "6px 12px",
                      borderRadius: 8,
                      border: `1px solid var(--accent-55)`,
                      background: "var(--accent-1a)",
                      color: TEAL,
                      fontSize: 11.5,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {t("Restore")}
                  </button>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: "flex", gap: 6, marginTop: 8, paddingTop: 12, borderTop: `1px solid ${C.line}` }}>
            <input
              value={newGroup}
              onChange={(ev) => setNewGroup(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" && newGroup.trim()) {
                  local.createGroup(newGroup.trim());
                  setNewGroup("");
                }
              }}
              placeholder={t("New group")}
              style={{
                flex: 1,
                padding: "8px 11px",
                borderRadius: 9,
                border: `1px solid ${C.line}`,
                background: C.bg,
                color: C.text,
                fontSize: 13,
                fontFamily: font,
              }}
            />
            <button
              onClick={() => {
                if (newGroup.trim()) {
                  local.createGroup(newGroup.trim());
                  setNewGroup("");
                }
              }}
              style={{
                padding: "8px 14px",
                borderRadius: 9,
                border: `1px solid var(--accent-55)`,
                background: "var(--accent-1a)",
                color: TEAL,
                fontSize: 12.5,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {t("+ Group")}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

function ManageGroup({ g, list, flat }: { g: StateResponse["groups"][number]; list: EnvelopeView[]; flat: EnvelopeView[] }) {
  const C = useTheme();
  const { t } = useT();
  const [adding, setAdding] = useState(false);
  const [addName, setAddName] = useState("");

  // A move within a group is applied to the flat ordering of all envelopes:
  // the interleaving of other groups stays, sorts get global indices 0..n
  // (per-group indices produced ties and an "unmoving" order on Start).
  const commitMove = (from: number, to: number) => {
    const moved = list[from]!;
    const target = list[to]!;
    const order = flat.map((e) => e.id).filter((id) => id !== moved.id);
    const ti = order.indexOf(target.id);
    order.splice(from < to ? ti + 1 : ti, 0, moved.id);
    const sortOf = new Map(flat.map((e) => [e.id, e.sort]));
    const ch = order.map((id, i) => ({ id, sort: i })).filter((c) => sortOf.get(c.id) !== c.sort);
    // ops per drop — the debounce in sync.poke() coalesces the burst into one push
    for (const c of ch) local.updateEnvelope(c.id, { sort: c.sort });
  };
  const dnd = useDragReorder(commitMove);

  const addEnvelope = () => {
    const name = addName.trim();
    // rotating color from the palette (like accounts) — the final color/icon is chosen in envelope editing
    if (name)
      local.createEnvelope({ groupId: g.id, name, color: ENV_PALETTE[flat.length % ENV_PALETTE.length]!, sort: (flat[flat.length - 1]?.sort ?? -1) + 1 });
    setAddName("");
    setAdding(false);
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <input
          defaultValue={g.name}
          onBlur={(ev) => {
            const v = ev.target.value.trim();
            if (v && v !== g.name) local.updateGroup(g.id, { name: v });
          }}
          style={{
            flex: 1,
            fontSize: 13,
            fontWeight: 700,
            color: C.text,
            background: "none",
            border: "none",
            borderBottom: `1px solid transparent`,
            fontFamily: font,
            padding: "2px 0",
          }}
        />
        {list.length === 0 && (
          <button
            onClick={() => {
              if (window.confirm(t("Delete the empty group “{name}”?", { name: g.name }))) local.deleteGroup(g.id);
            }}
            aria-label={t("Delete group")}
            style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex" }}
          >
            <Ico d="M3 6h18M8 6V4h8v2m-9 0v14a1 1 0 001 1h8a1 1 0 001-1V6" size={15} color={CORAL} />
          </button>
        )}
      </div>

      {list.map((e, idx) => {
        const b = dnd.bind(idx);
        return (
          <div
            key={e.id}
            ref={dnd.itemRef(idx)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "6px 0",
              borderBottom: `1px solid ${C.line}`,
              borderRadius: 8,
              background: dnd.dragging === idx ? C.bg : "transparent",
              outline: dnd.over === idx && dnd.dragging !== idx ? `2px dashed ${TEAL}` : "none",
              outlineOffset: -2,
            }}
          >
            <span {...b} aria-label={t("Drag {name}", { name: e.name })} style={{ ...b.style, display: "flex", padding: "8px 6px", marginLeft: -4 }}>
              <Ico d="M4 7h16M4 12h16M4 17h16" size={14} color={C.mute} />
            </span>
            <div
              style={{
                width: 24,
                height: 24,
                borderRadius: 6,
                background: e.color,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <Glyph name={e.icon} size={12} color={isLight(e.color) ? "#33312c" : "#fff"} sw={1.6} />
            </div>
            <input
              defaultValue={e.name}
              onBlur={(ev) => {
                const v = ev.target.value.trim();
                if (v && v !== e.name) local.updateEnvelope(e.id, { name: v });
              }}
              style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: C.text, background: "none", border: "none", fontFamily: font, padding: "2px 0" }}
            />
            <button
              onClick={() => {
                if (window.confirm(t("Delete the envelope “{name}”? Its transactions will be left without an envelope.", { name: e.name })))
                  local.deleteEnvelope(e.id);
              }}
              aria-label={t("Delete {name}", { name: e.name })}
              style={{ background: "none", border: "none", cursor: "pointer", padding: 6, display: "flex" }}
            >
              <Ico d="M3 6h18M8 6V4h8v2m-9 0v14a1 1 0 001 1h8a1 1 0 001-1V6" size={15} color={CORAL} />
            </button>
          </div>
        );
      })}

      {adding ? (
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <input
            // biome-ignore lint/a11y/noAutofocus: the input exists only because the user just tapped "add" — focus follows that explicit action
            autoFocus
            value={addName}
            onChange={(ev) => setAddName(ev.target.value)}
            onKeyDown={(ev) => ev.key === "Enter" && addEnvelope()}
            placeholder={t("Envelope name")}
            style={{
              flex: 1,
              padding: "7px 10px",
              borderRadius: 8,
              border: `1px solid ${C.line}`,
              background: C.bg,
              color: C.text,
              fontSize: 12,
              fontFamily: font,
            }}
          />
          <button
            onClick={addEnvelope}
            style={{ padding: "7px 12px", borderRadius: 8, border: "none", background: TEAL, color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
          >
            {t("Add")}
          </button>
        </div>
      ) : (
        <button
          onClick={() => {
            setAdding(true);
            setAddName("");
          }}
          style={{ marginTop: 8, padding: "6px 0", background: "none", border: "none", color: TEAL, fontSize: 11, fontWeight: 600, cursor: "pointer" }}
        >
          {t("+ Add envelope")}
        </button>
      )}
    </div>
  );
}

/* ── Envelope editing (reused by the full-screen envelope summary) ── */
export function EnvEdit({ env, groups, onClose }: { env: EnvelopeView | null; groups: StateResponse["groups"]; onClose: () => void }) {
  const { t, lang } = useT();
  const currency = useCurrency();
  const [name, setName] = useState("");
  const [groupId, setGroupId] = useState("");
  const [color, setColor] = useState("");
  const [icon, setIcon] = useState("tag");
  const [archived, setArchived] = useState(false);
  const [saving, setSaving] = useState(false);
  const [target, setTarget] = useState("");
  const [pad, setPad] = useState<AmountPadTarget | null>(null);
  useEffect(() => {
    if (env) {
      setName(env.name);
      setGroupId(env.groupId);
      setColor(env.color);
      setIcon(env.icon);
      setArchived(env.archived);
      setSaving(!!env.isSavings);
      setTarget(env.monthlyTarget != null ? (env.monthlyTarget / 100).toFixed(2).replace(".", ",") : "");
    }
  }, [env]);
  if (!env) return null;
  const openTargetPad = () =>
    setPad({
      label: t("Monthly target (optional)"),
      initial: target.trim() === "" ? 0 : (parseAmount(target) ?? 0),
      // 0 clears the goal (empty field = no goal — same save semantics as before)
      onCommit: (minor) => setTarget(minor === 0 ? "" : fmtTrim(minor)),
    });
  return (
    <>
      <Sheet show={!!env} onClose={onClose}>
        {(C) => (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <span style={{ fontSize: 17, fontWeight: 700, color: C.text }}>{t("Edit envelope")}</span>
              <button
                onClick={() => {
                  if (archived && !env.archived) {
                    const ok = window.confirm(
                      t(
                        "The envelope “{name}” will disappear from the Budget and Start screens. Its transaction history stays, and available funds remain in the envelope. You can restore it in “Manage envelopes” → Archived.\n\nArchive it?",
                        { name },
                      ),
                    );
                    if (!ok) return; // save nothing — the sheet stays open
                  }
                  const mt = target.trim() === "" ? null : parseAmount(target);
                  local.updateEnvelope(env.id, { name, groupId, color, icon, archived, monthlyTarget: mt, isSavings: saving });
                  onClose();
                }}
                style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}
              >
                <Ico d="M5 13l4 4L19 7" size={20} color={TEAL} sw={2.4} />
              </button>
            </div>
            <div style={{ fontSize: 10.5, color: C.mute, fontWeight: 600, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.6 }}>
              {t("Envelope name")}
            </div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{
                width: "100%",
                padding: "8px 0",
                border: "none",
                borderBottom: `1px solid ${C.line}`,
                background: "none",
                color: C.text,
                fontSize: 15,
                fontFamily: font,
                marginBottom: 16,
                boxSizing: "border-box",
              }}
            />
            <div style={{ fontSize: 10.5, color: C.mute, fontWeight: 600, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.6 }}>{t("Group")}</div>
            <select
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              style={{
                width: "100%",
                padding: "8px 0",
                border: "none",
                borderBottom: `1px solid ${C.line}`,
                background: "none",
                color: C.text,
                fontSize: 14,
                fontFamily: font,
                marginBottom: 16,
              }}
            >
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
            <IconColorPicker palette={ENV_PALETTE} color={color} icon={icon} onColor={setColor} onIcon={setIcon} />
            <div style={{ fontSize: 10.5, color: C.mute, fontWeight: 600, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.6 }}>
              {t("Monthly target (optional)")}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 18 }}>
              <input
                // `target` is CANONICAL pad output (fmtTrim) and is read back with parseAmount —
                // only its rendering is localized.
                value={localizePadExpression(target, lang)}
                readOnly
                onClick={openTargetPad}
                onFocus={openTargetPad}
                placeholder={t("e.g. 5000")}
                style={{
                  flex: 1,
                  padding: "8px 0",
                  border: "none",
                  borderBottom: `1px solid ${C.line}`,
                  background: "none",
                  color: C.text,
                  fontSize: 15,
                  fontFamily: font,
                  fontVariantNumeric: "tabular-nums",
                  cursor: "pointer",
                }}
              />
              <span style={{ color: C.mute, fontSize: 13 }}>{t("{sym}/mo", { sym: currencySymbol(currency, lang) })}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <span style={{ fontSize: 14, color: C.text }}>{t("Wealth envelope (savings/investments)")}</span>
              <button
                onClick={() => setSaving(!saving)}
                style={{
                  width: 42,
                  height: 24,
                  borderRadius: 12,
                  background: saving ? TEAL : C.line,
                  position: "relative",
                  border: "none",
                  cursor: "pointer",
                  transition: "background .2s",
                }}
              >
                <div
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: "50%",
                    background: "#fff",
                    position: "absolute",
                    top: 2,
                    left: saving ? 20 : 2,
                    transition: "left .2s",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
                  }}
                />
              </button>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 14, color: C.text }}>{t("Archive")}</span>
              <button
                onClick={() => setArchived(!archived)}
                style={{
                  width: 42,
                  height: 24,
                  borderRadius: 12,
                  background: archived ? TEAL : C.line,
                  position: "relative",
                  border: "none",
                  cursor: "pointer",
                  transition: "background .2s",
                }}
              >
                <div
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: "50%",
                    background: "#fff",
                    position: "absolute",
                    top: 2,
                    left: archived ? 20 : 2,
                    transition: "left .2s",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
                  }}
                />
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
