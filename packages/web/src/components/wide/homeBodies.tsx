/**
 * Wide-only Home widget bodies (waveB-t3-brief.md, B3) — rendered by `WideHome` INSTEAD OF
 * `renderWidget` for the `envelopes`/`envelopesSavings` tiles. The phone bodies in `../widgets.tsx`
 * (`EnvelopesWidget`/`EnvelopesSavingsWidget`, grouped `EnvRow` lists with a progress meter and
 * goal ring) stay byte-identical — this module is a second, wide-only rendering of the same
 * `StateResponse.envelopes`, matching the design's compact pill grid (v3.dc.html:592-605) instead
 * of the phone's row list. Statically imported by `WideHome.tsx`, itself only reachable through
 * `WideShell` (lazy from `App.tsx`), so this ships in the wide chunk at zero eager cost.
 *
 * Deliberately does NOT reuse `envelopeSections` (widgets.tsx): that helper splits "all" into two
 * labelled sub-sections (Everyday + Savings), which is the phone's own card grammar (per-section
 * eyebrow + total). The design's grid is one FLAT list with a single footer caption for the whole
 * tile — `pickEnvelopes` below mirrors the same mode semantics (all/savings/group:<id>/picked:<ids>)
 * against a flat, sorted list instead.
 */
import type { EnvelopeGroup, EnvelopeView, StateResponse } from "@enveo/shared";
import { useMask, useTheme } from "../../lib/contexts";
import { type Message, useT } from "../../lib/i18n";

/** Same mode grammar as `EnvelopesOptions`/`envelopeSections` (widgets.tsx / EditWidgetsSheet.tsx)
 *  — "all" | "savings" | "group:<id>" | "picked:<ids>" — but flattened (no sub-section split). */
function pickEnvelopes(state: StateResponse, mode: string): EnvelopeView[] {
  const envelopes = [...state.envelopes].filter((e) => !e.archived).sort((a, b) => a.sort - b.sort);
  if (mode === "savings") return envelopes.filter((e) => e.isSavings);
  if (mode.startsWith("group:")) {
    const gid = mode.slice("group:".length);
    return envelopes.filter((e) => e.groupId === gid);
  }
  if (mode.startsWith("picked:")) {
    const ids = new Set(mode.slice("picked:".length).split(",").filter(Boolean));
    return envelopes.filter((e) => ids.has(e.id));
  }
  return envelopes; // "all" (default/fallback for an unrecognized mode string)
}

/** Footer-caption label for the current mode — the exact same keys `EditWidgetsSheet.tsx`'s
 *  `envModeLabel` already uses for the widget-settings subtitle (all already translated in every
 *  locale), reused here rather than imported: `EditWidgetsSheet` is its own lazy chunk
 *  (`PanelHost.tsx`'s `lazy(() => import("../EditWidgetsSheet"))`), and a static cross-import would
 *  pull that ~500-line module into the wide chunk's eager-within-wide graph for eight lines of pure
 *  string logic. */
function modeCaption(mode: string, groups: EnvelopeGroup[], t: (m: Message, p?: Record<string, string | number>) => string): string {
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

export interface EnvelopePillGridProps {
  state: StateResponse;
  month: string;
  /** Already resolved by the caller: `envelopesSavings` forces "savings" regardless of `opts`,
   *  same as the phone's `EnvelopesSavingsWidget` wrapper. */
  mode: string;
  onOpenEnvelope: (envId: string, month: string) => void;
}

/** The design's compact 2-col envelope pill grid (v3.dc.html:592-605) — a color dot + name + bold
 *  amount per pill, page-bg background (NOT card white, so pills read as recessed against the
 *  tile's own card surface), no progress bar/goal ring/status caption/per-row divider. One footer
 *  caption for the whole tile; no in-body "Envelopes ·" eyebrow (the tile chrome already shows the
 *  title — `WideHome`'s own header row). */
export function EnvelopePillGrid({ state, month, mode, onOpenEnvelope }: EnvelopePillGridProps) {
  const C = useTheme();
  const M = useMask();
  const { t } = useT();
  const list = pickEnvelopes(state, mode);
  const total = M(list.reduce((s, e) => s + e.available, 0));
  const caption = t("{mode} · total {amount}", { mode: modeCaption(mode, state.groups, t), amount: total });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7, flex: 1, minHeight: 0 }}>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, alignContent: "start" }}>
        {list.map((e) => {
          const availColor = e.available < 0 ? C.neg : e.available === 0 ? C.mute : C.text;
          return (
            <button
              key={e.id}
              type="button"
              onClick={() => onOpenEnvelope(e.id, month)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                background: C.bg,
                border: "none",
                borderRadius: 9,
                padding: "7px 9px",
                minHeight: 0,
                cursor: "pointer",
                textAlign: "left",
                fontFamily: "inherit",
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: 3, background: e.color, display: "block", flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {e.name}
              </span>
              <span style={{ fontSize: 11, fontWeight: 700, color: availColor, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{M(e.available)}</span>
            </button>
          );
        })}
      </div>
      <span style={{ flexShrink: 0, fontSize: 10.5, color: C.soft, fontVariantNumeric: "tabular-nums" }}>{caption}</span>
    </div>
  );
}
