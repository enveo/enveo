import { useEffect, useState } from "react";
import { type EnvelopeView, type StateResponse } from "../lib/api";
import { fmtSignedTrim, padPreview, padPreviewLive, type PadState } from "../lib/amount";
import { local } from "../lib/mutate";
import { Header, Sheet } from "../components/chrome";
import { AmountPadHost, type AmountPadTarget } from "../components/AmountPadSheet";
import { BudgetSuggestSheet } from "../components/BudgetSuggestSheet";
import { DockedNumpad } from "../components/DockedNumpad";
import { IconColorPicker } from "../components/IconColorPicker";
import { useCurrency, useMask, useSettings, useTheme } from "../lib/contexts";
import { useDragReorder } from "../lib/dnd";
import { currencySymbol, fmtTrim, formatMoney, isLight, parseAmount } from "../lib/format";
import { goalProgress } from "../lib/goals";
import { useT } from "../lib/i18n";
import { Glyph, Ico } from "../lib/icons";
import { CORAL, ENV_PALETTE, P, SAGE_BG, SAGE_TX, TEAL, font } from "../lib/theme";

export function BudgetScreen({
  state,
  month,
  onMenu,
  onPrev,
  onNext,
  onOpenEnvelope,
}: {
  state: StateResponse;
  month: string;
  onMenu: () => void;
  onPrev: () => void;
  onNext: () => void;
  onOpenEnvelope: (envId: string, month: string) => void;
}) {
  const C = useTheme();
  const M = useMask();
  const { settings } = useSettings();
  const { t, lang } = useT();
  const currency = useCurrency();
  const [manage, setManage] = useState(false);
  const [suggest, setSuggest] = useState(false);
  // IN-PLACE allocation editing (docked-numpad spec): one active cell per screen;
  // `err` = ✓ on an uncomputable/negative result, cleared on the next keypress.
  const [editing, setEditing] = useState<{ envelopeId: string; pad: PadState; err?: boolean } | null>(null);

  const groups = [...state.groups].sort((a, b) => a.sort - b.sort);
  const envs = state.envelopes.filter((e) => !e.archived);
  const totAdd = envs.reduce((s, e) => s + e.allocated, 0);
  const totAvail = envs.reduce((s, e) => s + e.available, 0);
  const pill = (e: EnvelopeView) => ({ bg: e.color, txt: isLight(e.color) ? "#33312c" : "#fff" });
  const COLS = "1fr 94px 108px";

  // Commit-or-cancel of the current edit (tap on another envelope): computable and ≥0 → save, otherwise discard.
  const commitEditing = (ed: { envelopeId: string; pad: PadState }) => {
    const minor = padPreview(ed.pad.expr);
    const env = envs.find((x) => x.id === ed.envelopeId);
    if (minor !== null && minor >= 0 && env && minor !== env.allocated) {
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
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
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
  const tbbLive = state.toBeBudgeted - (activeEnv && activePreview !== null ? activePreview - activeEnv.allocated : 0);

  return (
    <div className="gs" style={{ flex: 1, overflowY: "auto", paddingBottom: editing ? 300 : 6 }}>
      <Header month={month} onMenu={onMenu} onPrev={onPrev} onNext={onNext} onRight={() => setManage(true)} rightIcon="pencil" />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "0 0 10px" }}>
        <span style={{ fontSize: 13.5, color: C.soft }}>{t("budget.toBeBudgeted")}</span>
        <span style={{ display: "inline-block", padding: "4px 14px", borderRadius: 15, background: tbbLive < 0 ? CORAL : SAGE_BG, color: tbbLive < 0 ? "#fff" : SAGE_TX, fontSize: 14, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{M(tbbLive)}</span>
        <button onClick={() => setSuggest(true)} aria-label={t("suggest.title")} style={{ padding: "5px 12px", borderRadius: 13, border: `1px solid var(--accent-55)`, background: "var(--accent-1a)", color: TEAL, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>{t("budget.suggestBtn")}</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: COLS, padding: `0 ${P}px 6px`, gap: 8, alignItems: "start" }}>
        <span style={{ fontSize: 10.5, color: C.mute, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase" }}>{t("budget.colName")}</span>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 10.5, color: C.mute, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase" }}>{t("budget.colAllocated")}</div>
          <div style={{ fontSize: 12, color: C.soft, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>{M(totAdd)}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 10.5, color: C.mute, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase" }}>{t("budget.colAvailable")}</div>
          <div style={{ fontSize: 12, color: C.text, fontWeight: 600, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>{M(totAvail)}</div>
        </div>
      </div>

      {/* Empty state (backstop outside the wizard): no active envelopes → CTA to the manage sheet */}
      {envs.length === 0 && (
        <div style={{ margin: `6px ${P}px 10px`, padding: "12px 14px", background: "var(--accent-14)", border: `1px solid var(--accent-44)`, borderRadius: 12 }}>
          <button onClick={() => setManage(true)} style={{ width: "100%", padding: "10px 0", borderRadius: 10, border: "none", background: TEAL, color: "#fff", fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: font }}>
            {t("onb.ctaEnvelopes2")}
          </button>
        </div>
      )}

      {groups.map((g, gi) => {
        const items = envs.filter((e) => e.groupId === g.id).sort((a, b) => a.sort - b.sort);
        if (!items.length) return null;
        const gA = items.reduce((s, e) => s + e.allocated, 0);
        const gV = items.reduce((s, e) => s + e.available, 0);
        return (
          <div key={g.id} className="fu" style={{ animationDelay: `${gi * 40}ms`, marginBottom: 2 }}>
            <div style={{ display: "grid", gridTemplateColumns: COLS, padding: `6px ${P}px`, gap: 8, background: C.band, alignItems: "center" }}>
              <span style={{ fontSize: 14.5, fontWeight: 600, color: C.text }}>{g.name}</span>
              <span style={{ fontSize: 11.5, color: C.soft, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{M(gA)}</span>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: C.text, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{M(gV)}</span>
            </div>
            {items.map((e) => {
              const pc = pill(e);
              // Live edit context: the active envelope's Available pill shows the value AFTER the change;
              // strikethrough only when there is no value (empty expression after ⌫).
              const active = editing?.envelopeId === e.id ? editing : null;
              const struck = !!active && activePreview === null;
              const avail = active && activePreview !== null ? e.available + activePreview - e.allocated : e.available;
              const neg = avail < 0;
              const zero = avail === 0;
              const carryStr = e.carryIn !== 0 ? `${e.carryIn < 0 ? "-" : "+"}${settings.discreet ? "••••" : formatMoney(Math.abs(e.carryIn), currency, lang, { trim: true })}` : "";
              const gp = goalProgress(e);
              return (
                <div key={e.id} role="button" onClick={() => onOpenEnvelope(e.id, month)} style={{ display: "grid", gridTemplateColumns: COLS, padding: `4px ${P}px`, gap: 8, width: "100%", boxSizing: "border-box", cursor: "pointer", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0 }}>
                    <div style={{ width: 28, height: 28, borderRadius: 7, background: e.color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <Glyph name={e.icon} size={14} color={isLight(e.color) ? "#33312c" : "#fff"} sw={1.6} />
                    </div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: "block", fontSize: 14.5, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}>{e.name}</span>
                      {gp && (
                        <div style={{ height: 3, borderRadius: 2, background: C.inset, marginTop: 3, maxWidth: "90%", overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${gp.pct}%`, background: gp.funded ? "#4fa583" : "var(--accent)", borderRadius: 2 }} />
                        </div>
                      )}
                    </div>
                  </div>
                  <div style={{ position: "relative" }}>
                    {carryStr && (
                      <span style={{ position: "absolute", left: -8, top: -9, zIndex: 1, fontSize: 10, fontWeight: 600, color: e.carryIn < 0 ? CORAL : C.soft, background: C.bg, padding: "1px 7px", borderRadius: 9, border: `1px solid ${e.carryIn < 0 ? CORAL : C.mute}`, transform: "rotate(-6deg)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", pointerEvents: "none" }}>{carryStr}</span>
                    )}
                    <AllocCell e={e} editing={active ? { expr: active.pad.expr, err: active.err } : null} onStart={(el) => startEdit(e, el)} />
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <span style={{ position: "relative", display: "inline-block", padding: "4px 10px", borderRadius: 13, background: neg ? "transparent" : zero ? C.inset : pc.bg, color: struck ? "var(--danger)" : neg ? C.text : zero ? C.mute : pc.txt, fontSize: 13.5, fontWeight: 700, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", textDecoration: struck ? "line-through" : "none" }}>
                      {neg ? "-" : ""}{M(Math.abs(avail))}
                      {neg && (
                        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: "absolute", inset: "-1px -3px", width: "calc(100% + 6px)", height: "calc(100% + 2px)", pointerEvents: "none" }}>
                          <line x1="4" y1="10" x2="96" y2="90" stroke="#e04f42" strokeWidth="2.2" strokeLinecap="round" vectorEffect="non-scaling-stroke" opacity="0.85" />
                          <line x1="96" y1="10" x2="4" y2="90" stroke="#e04f42" strokeWidth="2.2" strokeLinecap="round" vectorEffect="non-scaling-stroke" opacity="0.85" />
                        </svg>
                      )}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}

      <EnvManageSheet show={manage} state={state} onClose={() => setManage(false)} />
      <BudgetSuggestSheet show={suggest} state={state} month={month} onClose={() => setSuggest(false)} />
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
  const box = { background: C.inset, borderRadius: 7, padding: "4px 9px" } as const;
  if (settings.discreet) {
    return <div style={{ ...box, textAlign: "right" as const, fontSize: 13, color: C.text }}>•••• {currencySymbol(currency, lang)}</div>;
  }
  if (editing) {
    // Active cell: the padKey expression in place of the input; err = ✓ on a bad result.
    // stopPropagation: a tap on the edited cell must not open the envelope action sheet.
    return (
      <div
        data-pad-cell="1"
        onClick={(ev) => ev.stopPropagation()}
        aria-label={t("budget.allocAria", { name: e.name })}
        style={{ ...box, textAlign: "right" as const, fontSize: 13, color: editing.err ? "var(--danger)" : C.text, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", overflowX: "auto", boxSizing: "border-box", borderBottom: `2px solid ${editing.err ? "var(--danger)" : "var(--accent)"}`, borderRadius: "7px 7px 0 0" }}
      >
        {editing.expr || "0"}
        {/* blinking cursor — like the amount on the Add screen */}
        <span style={{ display: "inline-block", width: 2, height: 13, background: editing.err ? "var(--danger)" : "var(--accent)", borderRadius: 1, marginLeft: 2, verticalAlign: "-2px", animation: "fi .6s ease-in-out infinite alternate" }} />
      </div>
    );
  }
  return (
    <div onClick={(ev) => { ev.stopPropagation(); onStart(ev.currentTarget); }} style={{ ...box, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 3, cursor: "pointer" }}>
      <input
        value={fmtTrim(e.allocated)}
        readOnly
        aria-label={t("budget.allocAria", { name: e.name })}
        onFocus={(ev) => onStart(ev.currentTarget)}
        style={{ width: "100%", minWidth: 0, background: "none", border: "none", outline: "none", textAlign: "right", fontSize: 13, color: C.text, fontFamily: font, fontVariantNumeric: "tabular-nums", padding: 0, cursor: "pointer" }}
      />
      <span style={{ fontSize: 13, color: C.text, flexShrink: 0 }}>{currencySymbol(currency, lang)}</span>
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
          <div style={{ fontSize: 17, fontWeight: 700, color: C.text, marginBottom: 4, textAlign: "center" }}>{t("budget.manageTitle")}</div>
          <div style={{ fontSize: 11, color: C.mute, marginBottom: 16, textAlign: "center" }}>{t("budget.manageHint")}</div>

          {groups.map((g) => (
            <ManageGroup key={g.id} g={g} list={flat.filter((e) => e.groupId === g.id)} flat={flat} />
          ))}

          {archived.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 10.5, fontWeight: 600, color: C.mute, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 6 }}>{t("budget.archivedSection")}</div>
              {archived.map((e) => (
                <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", opacity: 0.75 }}>
                  <div style={{ width: 24, height: 24, borderRadius: 6, background: e.color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <Glyph name={e.icon} size={12} color={isLight(e.color) ? "#33312c" : "#fff"} sw={1.6} />
                  </div>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: C.soft, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
                  <button onClick={() => local.updateEnvelope(e.id, { archived: false })} style={{ flexShrink: 0, padding: "6px 12px", borderRadius: 8, border: `1px solid var(--accent-55)`, background: "var(--accent-1a)", color: TEAL, fontSize: 11.5, fontWeight: 600, cursor: "pointer" }}>{t("common.restore")}</button>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: "flex", gap: 6, marginTop: 8, paddingTop: 12, borderTop: `1px solid ${C.line}` }}>
            <input value={newGroup} onChange={(ev) => setNewGroup(ev.target.value)} onKeyDown={(ev) => { if (ev.key === "Enter" && newGroup.trim()) { local.createGroup(newGroup.trim()); setNewGroup(""); } }} placeholder={t("budget.newGroupPlaceholder")} style={{ flex: 1, padding: "8px 11px", borderRadius: 9, border: `1px solid ${C.line}`, background: C.bg, color: C.text, fontSize: 13, fontFamily: font, outline: "none" }} />
            <button onClick={() => { if (newGroup.trim()) { local.createGroup(newGroup.trim()); setNewGroup(""); } }} style={{ padding: "8px 14px", borderRadius: 9, border: `1px solid var(--accent-55)`, background: "var(--accent-1a)", color: TEAL, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>{t("budget.addGroupBtn")}</button>
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
    if (name) local.createEnvelope({ groupId: g.id, name, color: ENV_PALETTE[flat.length % ENV_PALETTE.length]!, sort: (flat[flat.length - 1]?.sort ?? -1) + 1 });
    setAddName("");
    setAdding(false);
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <input
          defaultValue={g.name}
          onBlur={(ev) => { const v = ev.target.value.trim(); if (v && v !== g.name) local.updateGroup(g.id, { name: v }); }}
          style={{ flex: 1, fontSize: 13, fontWeight: 700, color: C.text, background: "none", border: "none", borderBottom: `1px solid transparent`, outline: "none", fontFamily: font, padding: "2px 0" }}
        />
        {list.length === 0 && (
          <button onClick={() => { if (window.confirm(t("budget.deleteGroupConfirm", { name: g.name }))) local.deleteGroup(g.id); }} aria-label={t("budget.deleteGroupAria")} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex" }}>
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
            style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 0", borderBottom: `1px solid ${C.line}`, borderRadius: 8, background: dnd.dragging === idx ? C.bg : "transparent", outline: dnd.over === idx && dnd.dragging !== idx ? `2px dashed ${TEAL}` : "none", outlineOffset: -2 }}
          >
            <span {...b} aria-label={t("budget.dragAria", { name: e.name })} style={{ ...b.style, display: "flex", padding: "8px 6px", marginLeft: -4 }}>
              <Ico d="M4 7h16M4 12h16M4 17h16" size={14} color={C.mute} />
            </span>
            <div style={{ width: 24, height: 24, borderRadius: 6, background: e.color, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Glyph name={e.icon} size={12} color={isLight(e.color) ? "#33312c" : "#fff"} sw={1.6} />
            </div>
            <input
              defaultValue={e.name}
              onBlur={(ev) => { const v = ev.target.value.trim(); if (v && v !== e.name) local.updateEnvelope(e.id, { name: v }); }}
              style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: C.text, background: "none", border: "none", outline: "none", fontFamily: font, padding: "2px 0" }}
            />
            <button onClick={() => { if (window.confirm(t("budget.deleteEnvConfirm", { name: e.name }))) local.deleteEnvelope(e.id); }} aria-label={t("budget.deleteEnvAria", { name: e.name })} style={{ background: "none", border: "none", cursor: "pointer", padding: 6, display: "flex" }}>
              <Ico d="M3 6h18M8 6V4h8v2m-9 0v14a1 1 0 001 1h8a1 1 0 001-1V6" size={15} color={CORAL} />
            </button>
          </div>
        );
      })}

      {adding ? (
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <input autoFocus value={addName} onChange={(ev) => setAddName(ev.target.value)} onKeyDown={(ev) => ev.key === "Enter" && addEnvelope()} placeholder={t("budget.envName")} style={{ flex: 1, padding: "7px 10px", borderRadius: 8, border: `1px solid ${C.line}`, background: C.bg, color: C.text, fontSize: 12, fontFamily: font, outline: "none" }} />
          <button onClick={addEnvelope} style={{ padding: "7px 12px", borderRadius: 8, border: "none", background: TEAL, color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>{t("common.add")}</button>
        </div>
      ) : (
        <button onClick={() => { setAdding(true); setAddName(""); }} style={{ marginTop: 8, padding: "6px 0", background: "none", border: "none", color: TEAL, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>{t("budget.addEnvBtn")}</button>
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
      setName(env.name); setGroupId(env.groupId); setColor(env.color); setIcon(env.icon); setArchived(env.archived);
      setSaving(!!env.isSavings);
      setTarget(env.monthlyTarget != null ? (env.monthlyTarget / 100).toFixed(2).replace(".", ",") : "");
    }
  }, [env]);
  if (!env) return null;
  const openTargetPad = () =>
    setPad({
      label: t("budget.monthlyTargetLabel"),
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
            <span style={{ fontSize: 17, fontWeight: 700, color: C.text }}>{t("budget.editEnvTitle")}</span>
            <button onClick={() => {
              if (archived && !env.archived) {
                const ok = window.confirm(t("budget.archiveEnvConfirm", { name }));
                if (!ok) return; // save nothing — the sheet stays open
              }
              const mt = target.trim() === "" ? null : parseAmount(target);
              local.updateEnvelope(env.id, { name, groupId, color, icon, archived, monthlyTarget: mt, isSavings: saving });
              onClose();
            }} style={{ background: "none", border: "none", cursor: "pointer", padding: 4 }}>
              <Ico d="M5 13l4 4L19 7" size={20} color={TEAL} sw={2.4} />
            </button>
          </div>
          <div style={{ fontSize: 10.5, color: C.mute, fontWeight: 600, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.6 }}>{t("budget.envName")}</div>
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: "100%", padding: "8px 0", border: "none", borderBottom: `1px solid ${C.line}`, background: "none", color: C.text, fontSize: 15, fontFamily: font, outline: "none", marginBottom: 16, boxSizing: "border-box" }} />
          <div style={{ fontSize: 10.5, color: C.mute, fontWeight: 600, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.6 }}>{t("budget.groupLabel")}</div>
          <select value={groupId} onChange={(e) => setGroupId(e.target.value)} style={{ width: "100%", padding: "8px 0", border: "none", borderBottom: `1px solid ${C.line}`, background: "none", color: C.text, fontSize: 14, fontFamily: font, outline: "none", marginBottom: 16 }}>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
          <IconColorPicker palette={ENV_PALETTE} color={color} icon={icon} onColor={setColor} onIcon={setIcon} />
          <div style={{ fontSize: 10.5, color: C.mute, fontWeight: 600, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.6 }}>{t("budget.monthlyTargetLabel")}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 18 }}>
            <input value={target} readOnly onClick={openTargetPad} onFocus={openTargetPad} placeholder={t("budget.monthlyTargetPlaceholder")} style={{ flex: 1, padding: "8px 0", border: "none", borderBottom: `1px solid ${C.line}`, background: "none", color: C.text, fontSize: 15, fontFamily: font, outline: "none", fontVariantNumeric: "tabular-nums", cursor: "pointer" }} />
            <span style={{ color: C.mute, fontSize: 13 }}>{t("budget.perMonth", { sym: currencySymbol(currency, lang) })}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <span style={{ fontSize: 14, color: C.text }}>{t("budget.savingsToggle")}</span>
            <button onClick={() => setSaving(!saving)} style={{ width: 42, height: 24, borderRadius: 12, background: saving ? TEAL : C.line, position: "relative", border: "none", cursor: "pointer", transition: "background .2s" }}>
              <div style={{ width: 20, height: 20, borderRadius: "50%", background: "#fff", position: "absolute", top: 2, left: saving ? 20 : 2, transition: "left .2s", boxShadow: "0 1px 2px rgba(0,0,0,0.2)" }} />
            </button>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 14, color: C.text }}>{t("budget.archiveToggle")}</span>
            <button onClick={() => setArchived(!archived)} style={{ width: 42, height: 24, borderRadius: 12, background: archived ? TEAL : C.line, position: "relative", border: "none", cursor: "pointer", transition: "background .2s" }}>
              <div style={{ width: 20, height: 20, borderRadius: "50%", background: "#fff", position: "absolute", top: 2, left: archived ? 20 : 2, transition: "left .2s", boxShadow: "0 1px 2px rgba(0,0,0,0.2)" }} />
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

