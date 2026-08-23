/**
 * The "Edit widgets" sheet — reorder (drag handle), enable/disable toggles and per-widget
 * options for Start's configurable widget stack.
 *
 * Split out of `widgets.tsx` into its own module so it can be loaded lazily (§3f): the six
 * `START_WIDGETS` bodies are eager (Start renders them at boot), but this whole editing surface
 * — the sheet itself, its three options bodies (`AccountsOptions`/`EnvelopesOptions`/
 * `QuickActionsOptions`) and the row/toggle/checkbox/chip primitives only they use — is needed
 * only once someone taps the edit pencil. Mounted via `lazy()` + `LazyChunk`/`useOpenedOnce`
 * from `Start.tsx`, the same idiom `App.tsx` already uses for `EnvActionsSheet`.
 *
 * Imports FROM `./widgets` (the eager module) for the action-catalogue it needs
 * (`QUICK_ACTION_DEFS`, `QUICK_ACTION_ORDER`) — never the other way around, so `widgets.tsx` never
 * pulls this chunk into the eager closure. Row membership is checked against `WIDGET_CATALOG`
 * (every `WidgetId`, PR5 onward), NOT `START_WIDGETS` (only the six EAGER bodies) — this sheet
 * lists and toggles all twelve widgets, eager or lazy alike; it never renders a widget BODY itself.
 */
import { type CSSProperties, useEffect, useState } from "react";
import type { StateResponse } from "../lib/api";
import type { WidgetConfig, WidgetId, WidgetOpts } from "../lib/contexts";
import { useSettings, useTheme } from "../lib/contexts";
import { useDragReorder } from "../lib/dnd";
import { type Message, msg, useT } from "../lib/i18n";
import { Glyph, Ico } from "../lib/icons";
import { matchesSearch, SEARCH_THRESHOLD } from "../lib/search";
import { font, TEAL, type Theme, tint } from "../lib/theme";
import { WIDGET_CATALOG } from "../lib/widgetCatalog";
import { Sheet } from "./chrome";
import { HighlightedText, PickerSearch } from "./kit";
import { QUICK_ACTION_DEFS, QUICK_ACTION_ORDER } from "./widgets";

function envModeLabel(mode: string, groups: StateResponse["groups"], t: (m: Message, p?: Record<string, string | number>) => string): string {
  if (mode === "savings") return t("Savings only");
  if (mode.startsWith("group:")) {
    const g = groups.find((gr) => gr.id === mode.slice("group:".length));
    return t("Group: {name}", { name: g?.name ?? "?" });
  }
  if (mode.startsWith("picked:")) {
    const n = mode.slice("picked:".length).split(",").filter(Boolean).length;
    return t("Selected ({n})", { n: String(n) });
  }
  return t("All (Everyday + Savings)");
}

function widgetSubtitle(w: WidgetConfig, state: StateResponse, t: (m: Message, p?: Record<string, string | number>) => string): string {
  switch (w.id) {
    // reuses the same "Selected (n)" key envModeLabel uses for envelopes' picked mode. RAW count
    // (not resolveActions' default-on-empty) — an intentional "all unchecked" must read as 0.
    case "quickActions":
      return t("Selected ({n})", { n: String((w.opts?.actions ?? []).length) });
    case "accounts": {
      const collapsed = w.opts?.collapsed ?? true;
      return collapsed ? t("collapsed · {n} shown ›", { n: String(w.opts?.count ?? 4) }) : t("all shown ›");
    }
    case "envelopes":
      return envModeLabel(w.opts?.mode ?? "all", state.groups, t);
    case "envelopesSavings":
      return t("Savings only");
    case "reportCashflow":
      return t("current month");
    case "reportNetWorth":
      return t("12-month sparkline");
    case "attention":
      return t("budget checklist");
    case "recent":
      return t("latest transactions");
    case "spending":
      return t("this month's total");
    case "goals":
      return t("progress toward targets");
    case "trends":
      return t("6-month chart");
    case "heatmap":
      return t("daily spending calendar");
  }
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  const C = useTheme();
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={on}
      style={{
        width: 40,
        height: 22,
        borderRadius: 12,
        background: on ? "var(--accent)" : C.line,
        position: "relative",
        border: "none",
        cursor: "pointer",
        flexShrink: 0,
        padding: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: on ? 20 : 2,
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: "#fff",
          transition: "left .2s",
          boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
        }}
      />
    </button>
  );
}

/** Shared chip/tab look for the mode switchers below (Accounts' All/Selected, Envelopes' All/Savings/Group/Selected). */
function chipStyle(C: Theme, active: boolean): CSSProperties {
  return {
    padding: "5px 10px",
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
    background: active ? "var(--accent-1a)" : C.chip,
    color: active ? "var(--accent)" : C.text,
    border: `1px solid ${active ? "var(--accent)" : C.line}`,
  };
}

/** Small checkbox-style indicator — same checkmark path used elsewhere for a satisfied state (see
 *  the "All money assigned" tick on Start). */
function CheckBox({ checked }: { checked: boolean }) {
  const C = useTheme();
  return (
    <span
      aria-hidden
      style={{
        width: 18,
        height: 18,
        borderRadius: 5,
        border: `1.5px solid ${checked ? "var(--accent)" : C.line}`,
        background: checked ? "var(--accent)" : "transparent",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      {checked && <Ico d="M5 13l4 4L19 7" size={12} color="#fff" sw={3} />}
    </span>
  );
}

/** A tinted-icon + name + checkbox row — the "picked" checklist idiom shared by AccountsOptions and
 *  EnvelopesOptions (accounts/envelopes both carry their own {color, icon}). `query` (when the list
 *  is under search) highlights the matched span instead of just rendering the plain name. */
function PickRow({
  icon,
  color,
  name,
  checked,
  onToggle,
  query = "",
}: {
  icon: string;
  color: string;
  name: string;
  checked: boolean;
  onToggle: () => void;
  query?: string;
}) {
  const C = useTheme();
  return (
    <button
      onClick={onToggle}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "6px 0",
        background: "none",
        border: "none",
        cursor: "pointer",
        textAlign: "left",
        fontFamily: font,
      }}
    >
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: 7,
          background: tint(color, 0.15),
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <Glyph name={icon} size={12} color={color} sw={1.8} />
      </span>
      <span style={{ flex: 1, fontSize: 12, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        <HighlightedText text={name} query={query} />
      </span>
      <CheckBox checked={checked} />
    </button>
  );
}

function AccountsOptions({ w, state, onChange }: { w: WidgetConfig; state: StateResponse; onChange: (o: WidgetOpts) => void }) {
  const C = useTheme();
  const { t } = useT();
  const collapsed = w.opts?.collapsed ?? true;
  const count = w.opts?.count ?? 4;
  const picked = w.opts?.picked; // defined (even empty) → "Selected" tab active — see AccountsWidget
  const accounts = state.accounts.filter((a) => !a.archived);
  const [q, setQ] = useState("");
  // reset only on the "all"→"picked" transition (undefined→array) — NOT on every checkbox toggle,
  // which also produces a new `picked` array reference and would otherwise clear what was typed.
  useEffect(() => {
    if (picked !== undefined) setQ("");
  }, [picked !== undefined]);
  const filteredAccounts = accounts.filter((a) => matchesSearch(a.name, q));
  const stepBtn = {
    width: 26,
    height: 26,
    borderRadius: 8,
    border: `1px solid ${C.line}`,
    background: C.chip,
    color: C.text,
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    lineHeight: 1,
  } as const;
  const tabs: Array<{ key: "all" | "picked"; label: Message; onClick: () => void }> = [
    { key: "all", label: msg("All"), onClick: () => onChange({ picked: undefined }) },
    { key: "picked", label: msg("Selected"), onClick: () => onChange({ picked: picked ?? [] }) },
  ];
  return (
    <div style={{ padding: "0 0 10px 26px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, color: C.text }}>{t("Collapsed by default")}</span>
        <Toggle on={collapsed} onClick={() => onChange({ collapsed: !collapsed })} label={t("Collapsed by default")} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, color: C.text }}>{t("Accounts shown when collapsed")}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={() => onChange({ count: Math.max(2, count - 1) })} style={stepBtn}>
            −
          </button>
          <span style={{ fontSize: 13, fontWeight: 700, color: C.text, width: 16, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>{count}</span>
          <button onClick={() => onChange({ count: Math.min(8, count + 1) })} style={stepBtn}>
            +
          </button>
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {tabs.map((tb) => (
          <button key={tb.key} onClick={tb.onClick} style={chipStyle(C, picked !== undefined ? tb.key === "picked" : tb.key === "all")}>
            {t(tb.label)}
          </button>
        ))}
      </div>
      {picked !== undefined && (
        <>
          {accounts.length > SEARCH_THRESHOLD && <PickerSearch value={q} onChange={setQ} />}
          {/* fixed (not max-) height once the search box is showing — filtering down to 1-2 rows must
              not shrink the checklist and reflow the whole widget-editor sheet under it (same shrink-
              behind-keyboard bug as the picker sheets in chrome.tsx, contained here since this list
              isn't the whole sheet). */}
          <div
            className="gs"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              ...(accounts.length > SEARCH_THRESHOLD ? { height: 200 } : { maxHeight: 200 }),
              overflowY: "auto",
            }}
          >
            {filteredAccounts.length === 0 ? (
              <div style={{ textAlign: "center", color: C.mute, fontSize: 12, padding: "10px 0" }}>{t("No matches")}</div>
            ) : (
              filteredAccounts.map((a) => {
                const ids = new Set(picked);
                const checked = ids.has(a.id);
                return (
                  <PickRow
                    key={a.id}
                    icon={a.icon}
                    color={a.color}
                    name={a.name}
                    query={q}
                    checked={checked}
                    onToggle={() => {
                      const next = new Set(ids);
                      if (checked) next.delete(a.id);
                      else next.add(a.id);
                      onChange({ picked: [...next] });
                    }}
                  />
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}

function EnvelopesOptions({ w, state, onChange }: { w: WidgetConfig; state: StateResponse; onChange: (o: WidgetOpts) => void }) {
  const C = useTheme();
  const { t } = useT();
  const mode = w.opts?.mode ?? "all";
  const base = mode.split(":")[0]!; // "all" | "savings" | "group" | "picked"
  const groups = state.groups;
  const envelopes = state.envelopes.filter((e) => !e.archived);
  const [q, setQ] = useState("");
  // reset only on the transition INTO "picked" — not on every checkbox toggle, which also changes
  // `mode` (the picked-ids suffix) and would otherwise clear what was typed.
  useEffect(() => {
    if (base === "picked") setQ("");
  }, [base === "picked"]);
  const filteredEnvelopes = envelopes.filter((e) => matchesSearch(e.name, q));
  const tabs: Array<{ key: string; label: Message; onClick: () => void }> = [
    { key: "all", label: msg("All"), onClick: () => onChange({ mode: "all" }) },
    { key: "savings", label: msg("Savings only"), onClick: () => onChange({ mode: "savings" }) },
    { key: "group", label: msg("Group…"), onClick: () => onChange({ mode: `group:${groups[0]?.id ?? ""}` }) },
    { key: "picked", label: msg("Selected"), onClick: () => onChange({ mode: "picked:" }) },
  ];
  return (
    <div style={{ padding: "0 0 10px 26px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        {tabs.map((tb) => (
          <button key={tb.key} onClick={tb.onClick} style={chipStyle(C, base === tb.key)}>
            {t(tb.label)}
          </button>
        ))}
      </div>
      {base === "group" && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {groups.map((g) => (
            <button key={g.id} onClick={() => onChange({ mode: `group:${g.id}` })} style={chipStyle(C, mode === `group:${g.id}`)}>
              {g.name}
            </button>
          ))}
        </div>
      )}
      {base === "picked" && (
        <>
          {envelopes.length > SEARCH_THRESHOLD && <PickerSearch value={q} onChange={setQ} />}
          {/* fixed (not max-) height once the search box is showing — see AccountsOptions' comment. */}
          <div
            className="gs"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              ...(envelopes.length > SEARCH_THRESHOLD ? { height: 200 } : { maxHeight: 200 }),
              overflowY: "auto",
            }}
          >
            {filteredEnvelopes.length === 0 ? (
              <div style={{ textAlign: "center", color: C.mute, fontSize: 12, padding: "10px 0" }}>{t("No matches")}</div>
            ) : (
              filteredEnvelopes.map((e) => {
                const ids = new Set(mode.slice("picked:".length).split(",").filter(Boolean));
                const checked = ids.has(e.id);
                return (
                  <PickRow
                    key={e.id}
                    icon={e.icon}
                    color={e.color}
                    name={e.name}
                    query={q}
                    checked={checked}
                    onToggle={() => {
                      const next = new Set(ids);
                      if (checked) next.delete(e.id);
                      else next.add(e.id);
                      onChange({ mode: `picked:${[...next].join(",")}` });
                    }}
                  />
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}

function QuickActionsOptions({ w, onChange }: { w: WidgetConfig; onChange: (o: WidgetOpts) => void }) {
  const C = useTheme();
  const { t } = useT();
  // RAW opts (like AccountsOptions' `picked`) — resolveActions falls back to the default set on
  // empty, which would make "uncheck everything" snap right back to the defaults in this checklist.
  const selected = w.opts?.actions ?? [];
  return (
    <div style={{ padding: "0 0 10px 26px", display: "flex", flexDirection: "column", gap: 2 }}>
      {QUICK_ACTION_ORDER.map((key) => {
        const def = QUICK_ACTION_DEFS[key];
        const checked = selected.includes(key);
        return (
          <button
            key={key}
            onClick={() => {
              const set = new Set(selected);
              if (checked) set.delete(key);
              else set.add(key);
              // canonical order regardless of tap order — keeps QuickActions' row stable
              onChange({ actions: QUICK_ACTION_ORDER.filter((k) => set.has(k)) });
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "6px 0",
              background: "none",
              border: "none",
              cursor: "pointer",
              textAlign: "left",
              fontFamily: font,
            }}
          >
            <span
              style={{
                width: 22,
                height: 22,
                borderRadius: 7,
                background: C.chip,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              {def.glyph ? <Glyph name={def.glyph} size={12} color={C.soft} sw={1.8} /> : <Ico d={def.d!} size={12} color={C.soft} sw={1.8} />}
            </span>
            <span style={{ flex: 1, fontSize: 12, color: C.text }}>{t(def.label)}</span>
            <CheckBox checked={checked} />
          </button>
        );
      })}
    </div>
  );
}

export function EditWidgetsSheet({ show, state, onClose }: { show: boolean; state: StateResponse; onClose: () => void }) {
  const { t } = useT();
  const { settings, setSettings } = useSettings();
  const [openOptions, setOpenOptions] = useState<WidgetId | null>(null);
  const list = settings.startWidgets;

  const commitMove = (from: number, to: number) => {
    const order = [...list];
    const [m] = order.splice(from, 1);
    order.splice(to, 0, m!);
    setSettings({ ...settings, startWidgets: order });
  };
  const dnd = useDragReorder(commitMove);

  const toggle = (id: WidgetId) => setSettings({ ...settings, startWidgets: list.map((w) => (w.id === id ? { ...w, enabled: !w.enabled } : w)) });
  const setOpts = (id: WidgetId, opts: WidgetOpts) =>
    setSettings({ ...settings, startWidgets: list.map((w) => (w.id === id ? { ...w, opts: { ...w.opts, ...opts } } : w)) });

  return (
    <Sheet show={show} onClose={onClose}>
      {(C) => (
        <>
          <div style={{ fontSize: 16, fontWeight: 750, color: C.text, textAlign: "center", marginBottom: 2 }}>{t("Edit widgets")}</div>
          <div style={{ fontSize: 11, color: C.mute, textAlign: "center", marginBottom: 12 }}>{t("Drag to reorder")}</div>
          {list.map((w, idx) => {
            if (!(w.id in WIDGET_CATALOG)) return null; // corrupted/future persisted id — never crash the sheet
            const b = dnd.bind(idx);
            const title = t(WIDGET_CATALOG[w.id].title);
            return (
              <div
                key={w.id}
                ref={dnd.itemRef(idx)}
                style={{
                  borderBottom: `1px solid ${C.line}`,
                  background: dnd.dragging === idx ? C.bg : "transparent",
                  outline: dnd.over === idx && dnd.dragging !== idx ? `2px dashed ${TEAL}` : "none",
                  outlineOffset: -2,
                  borderRadius: 8,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0" }}>
                  <span
                    {...b}
                    aria-label={t("Drag {name}", { name: title })}
                    style={{ ...b.style, color: C.mute, fontSize: 15, padding: "4px 2px", display: "flex" }}
                  >
                    ≡
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: C.text }}>{title}</div>
                    {WIDGET_CATALOG[w.id].configurable ? (
                      <button
                        onClick={() => setOpenOptions(openOptions === w.id ? null : w.id)}
                        style={{
                          background: "none",
                          border: "none",
                          padding: 0,
                          fontSize: 11,
                          color: C.mute,
                          cursor: "pointer",
                          textAlign: "left",
                          fontFamily: font,
                        }}
                      >
                        {widgetSubtitle(w, state, t)}
                      </button>
                    ) : (
                      <div style={{ fontSize: 11, color: C.mute, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {widgetSubtitle(w, state, t)}
                      </div>
                    )}
                  </div>
                  <Toggle on={w.enabled} onClick={() => toggle(w.id)} label={title} />
                </div>
                {openOptions === w.id && w.id === "accounts" && <AccountsOptions w={w} state={state} onChange={(o) => setOpts("accounts", o)} />}
                {openOptions === w.id && w.id === "envelopes" && <EnvelopesOptions w={w} state={state} onChange={(o) => setOpts("envelopes", o)} />}
                {openOptions === w.id && w.id === "quickActions" && <QuickActionsOptions w={w} onChange={(o) => setOpts("quickActions", o)} />}
              </div>
            );
          })}
          <button
            onClick={onClose}
            style={{
              width: "100%",
              marginTop: 14,
              padding: "12px 0",
              borderRadius: 12,
              border: "none",
              background: TEAL,
              color: "#fff",
              fontSize: 13.5,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {t("Done")}
          </button>
        </>
      )}
    </Sheet>
  );
}
