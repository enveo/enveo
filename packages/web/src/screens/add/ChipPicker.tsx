import type { CSSProperties } from "react";
import { SectionEyebrow } from "../../components/kit";
import { useTheme } from "../../lib/contexts";
import { useT } from "../../lib/i18n";
import { font, P } from "../../lib/theme";
import { linkBtnStyle } from "./styles";

export interface ChipOption {
  id: string;
  name: string;
}

/**
 * Category and Place share ONE interaction (§ user rule): a row of ranked chips,
 * an "Other ›" link that swaps them for a search field over the full list, and —
 * when nothing matches what was typed — a create button. Selection is a toggle,
 * so a chip tapped twice clears the field.
 */
export function ChipPicker({
  label,
  chips,
  matches,
  selectedId,
  open,
  query,
  searchPlaceholder,
  createLabel,
  onToggleOpen,
  onQueryChange,
  onToggleChip,
  onPick,
  onCreate,
  onFieldFocus,
}: {
  label: string;
  chips: ChipOption[];
  /** The full list filtered by `query` — rendered while open. */
  matches: ChipOption[];
  selectedId: string | null;
  open: boolean;
  query: string;
  searchPlaceholder: string;
  /** Ready-made "+ Add “x”" label, or null when creating is unavailable (draft mode / exact match). */
  createLabel: string | null;
  onToggleOpen: () => void;
  onQueryChange: (value: string) => void;
  onToggleChip: (id: string) => void;
  onPick: (id: string) => void;
  onCreate: () => void;
  onFieldFocus: () => void;
}) {
  const C = useTheme();
  const { t } = useT();
  const chipStyle = (selected: boolean): CSSProperties => ({
    background: selected ? "var(--accent-1a)" : C.card,
    border: `1px solid ${selected ? "var(--accent)" : C.line}`,
    color: selected ? "var(--accent)" : C.text,
    borderRadius: 999,
    padding: "5px 11px",
    fontSize: 11,
    fontWeight: selected ? 650 : 600,
    fontFamily: font,
    cursor: "pointer",
  });
  return (
    <>
      <SectionEyebrow
        label={label}
        right={
          <button onClick={onToggleOpen} style={linkBtnStyle}>
            {open ? t("Collapse") : t("Other")} ›
          </button>
        }
      />
      {open ? (
        <div style={{ padding: `0 ${P}px 6px` }}>
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onFocus={onFieldFocus}
            placeholder={searchPlaceholder}
            style={{
              width: "100%",
              padding: "8px 10px",
              borderRadius: 8,
              border: `1px solid ${C.line}`,
              background: C.bg,
              color: C.text,
              fontSize: 12,
              fontFamily: font,
              boxSizing: "border-box",
              marginBottom: 6,
            }}
          />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: createLabel ? 6 : 0 }}>
            {matches.slice(0, 8).map((o) => (
              <button
                key={o.id}
                onClick={() => onPick(o.id)}
                style={{
                  padding: "5px 10px",
                  borderRadius: 8,
                  fontSize: 11,
                  background: o.id === selectedId ? "var(--accent-1a)" : C.chip,
                  color: o.id === selectedId ? "var(--accent)" : C.text,
                  border: `1px solid ${o.id === selectedId ? "var(--accent)" : C.line}`,
                  fontFamily: font,
                  cursor: "pointer",
                }}
              >
                {o.name}
              </button>
            ))}
          </div>
          {createLabel && (
            <button
              onClick={onCreate}
              style={{
                padding: "7px 10px",
                borderRadius: 8,
                fontSize: 11,
                background: "var(--accent-14)",
                color: "var(--accent)",
                border: `1px solid var(--accent-40)`,
                fontFamily: font,
                cursor: "pointer",
                width: "100%",
                textAlign: "left",
              }}
            >
              {createLabel}
            </button>
          )}
        </div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: `0 ${P}px 4px` }}>
          {chips.map((o) => (
            <button key={o.id} onClick={() => onToggleChip(o.id)} style={chipStyle(o.id === selectedId)}>
              {o.name}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
