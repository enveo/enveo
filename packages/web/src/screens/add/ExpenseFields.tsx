import type { CSSProperties } from "react";
import { SectionEyebrow } from "../../components/kit";
import type { StateResponse } from "../../lib/api";
import { useMask, useTheme } from "../../lib/contexts";
import { useT } from "../../lib/i18n";
import { Glyph, Ico } from "../../lib/icons";
import { font, P, TEAL, tint } from "../../lib/theme";
import { SplitEditor } from "./SplitEditor";
import { collapsedRowStyle, gridCardStyle, linkBtnStyle } from "./styles";
import type { SplitItem } from "./types";

/** Expense-tab entry: envelope suggestion grid / collapsed row, category chips
 *  + search/create, place chips + typed input, and the split entry (link +
 *  SplitEditor slot). Presentational — every mutation (category/place create,
 *  selection state, split items) flows through controller callbacks. */
export function ExpenseFields({
  splitMode,
  isDraft,
  items,
  setItems,
  envelopes,
  splitTotal,
  onCancelSplit,
  onEnterSplit,
  envOpen,
  envGridList,
  envelopeId,
  env,
  envPreviewText,
  onOpenEnvSheet,
  onPickEnvelope,
  onExpandEnvGrid,
  catOpen,
  catList,
  categoryId,
  catInput,
  filteredCats,
  categories,
  onOpenCat,
  onToggleCategory,
  onCatInputChange,
  onPickCategory,
  onCreateCategory,
  placeList,
  places,
  placeId,
  placeInput,
  showPlace,
  placeAutoFocus,
  filteredPlaces,
  onTogglePlaceChip,
  onTogglePlaceInput,
  onPlaceInputChange,
  onClearPlace,
  onPickPlace,
  onCreatePlace,
  onFieldFocus,
}: {
  splitMode: boolean;
  isDraft: boolean;
  items: SplitItem[];
  setItems: (i: SplitItem[]) => void;
  envelopes: StateResponse["envelopes"];
  splitTotal: number;
  onCancelSplit: () => void;
  onEnterSplit: () => void;
  envOpen: boolean;
  envGridList: StateResponse["envelopes"];
  envelopeId: string | null;
  env: StateResponse["envelopes"][number] | null | undefined;
  envPreviewText: string;
  onOpenEnvSheet: () => void;
  onPickEnvelope: (id: string) => void;
  onExpandEnvGrid: () => void;
  catOpen: boolean;
  catList: StateResponse["categories"];
  categoryId: string | null;
  catInput: string;
  filteredCats: StateResponse["categories"];
  categories: StateResponse["categories"];
  onOpenCat: () => void;
  onToggleCategory: (id: string) => void;
  onCatInputChange: (value: string) => void;
  onPickCategory: (id: string) => void;
  onCreateCategory: () => void;
  placeList: StateResponse["places"];
  places: StateResponse["places"];
  placeId: string | null;
  placeInput: string;
  showPlace: boolean;
  placeAutoFocus: boolean;
  filteredPlaces: StateResponse["places"];
  onTogglePlaceChip: (id: string) => void;
  onTogglePlaceInput: () => void;
  onPlaceInputChange: (value: string) => void;
  onClearPlace: () => void;
  onPickPlace: (id: string) => void;
  onCreatePlace: () => void;
  onFieldFocus: () => void;
}) {
  const C = useTheme();
  const M = useMask();
  const { t } = useT();

  // Chip surface (board spec: pill, centered flex-wrap) — the ghost variant marks "type your own".
  const chipStyle = (selected: boolean): CSSProperties => ({
    background: selected ? "var(--accent-1a)" : C.card,
    border: `1px solid ${selected ? "var(--accent)" : C.line}`,
    color: selected ? "var(--accent)" : C.text,
    borderRadius: 999,
    padding: "5px 11px",
    fontSize: 11,
    fontWeight: selected ? 650 : 600,
    cursor: "pointer",
  });
  const ghostChipStyle: CSSProperties = {
    background: C.card,
    border: `1px solid ${C.line}`,
    color: C.mute,
    borderRadius: 999,
    padding: "5px 11px",
    fontSize: 11,
    cursor: "pointer",
  };

  return (
    <>
      {splitMode ? (
        <SplitEditor items={items} setItems={setItems} envelopes={envelopes} total={splitTotal} onCancel={onCancelSplit} />
      ) : (
        <>
          <SectionEyebrow
            label={t("Envelope")}
            right={
              <button onClick={onOpenEnvSheet} style={linkBtnStyle}>
                {envOpen ? t("All") : t("Change")} ›
              </button>
            }
          />
          {envOpen ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, padding: `0 ${P}px` }}>
              {envGridList.map((e) => (
                <button key={e.id} onClick={() => onPickEnvelope(e.id)} style={gridCardStyle(C, e.id === envelopeId)}>
                  <Glyph name={e.icon} size={15} color={e.color} sw={1.8} />
                  <span style={{ minWidth: 0 }}>
                    <span
                      style={{
                        display: "block",
                        fontSize: 11,
                        fontWeight: 650,
                        color: C.text,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {e.name}
                    </span>
                    <span style={{ display: "block", fontSize: 9, color: C.soft, fontVariantNumeric: "tabular-nums" }}>
                      {e.available < 0 ? "−" : ""}
                      {M(Math.abs(e.available))}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ) : env ? (
            <button onClick={onOpenEnvSheet} style={collapsedRowStyle(C, true)}>
              <Glyph name={env.icon} size={17} color={env.color} sw={1.8} />
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 12.5,
                  fontWeight: 650,
                  color: C.text,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {env.name}
              </span>
              <span style={{ fontSize: 11, color: C.soft, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{envPreviewText}</span>
            </button>
          ) : (
            <button onClick={onExpandEnvGrid} style={collapsedRowStyle(C, false)}>
              <span style={{ flex: 1, fontSize: 12.5, color: C.mute }}>{t("Choose an envelope")}</span>
            </button>
          )}
        </>
      )}

      {!splitMode && (
        <>
          <SectionEyebrow
            label={t("Category")}
            right={
              <button onClick={onOpenCat} style={linkBtnStyle}>
                {t("Other")} ›
              </button>
            }
          />
          {!catOpen && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: `0 ${P}px 4px` }}>
              {catList.map((c) => (
                <button key={c.id} onClick={() => onToggleCategory(c.id)} style={chipStyle(categoryId === c.id)}>
                  {c.name}
                </button>
              ))}
            </div>
          )}
          {catOpen && (
            <div style={{ padding: `0 ${P}px 6px` }}>
              <input
                value={catInput}
                onChange={(e) => onCatInputChange(e.target.value)}
                onFocus={onFieldFocus}
                placeholder={t("Type or pick a category...")}
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
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
                {filteredCats.slice(0, 8).map((c) => (
                  <button
                    key={c.id}
                    onClick={() => onPickCategory(c.id)}
                    style={{
                      padding: "5px 10px",
                      borderRadius: 8,
                      fontSize: 11,
                      background: C.chip,
                      color: C.text,
                      border: `1px solid ${C.line}`,
                      cursor: "pointer",
                    }}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
              {/* category creation = local.createCategory — unavailable in draft (zero local.*) */}
              {!isDraft && catInput && !categories.some((c) => c.name.toLowerCase() === catInput.toLowerCase()) && (
                <button
                  onClick={onCreateCategory}
                  style={{
                    padding: "7px 10px",
                    borderRadius: 8,
                    fontSize: 11,
                    background: tint(C.pos, 0.1),
                    color: C.pos,
                    border: `1px solid ${tint(C.pos, 0.27)}`,
                    cursor: "pointer",
                    width: "100%",
                    textAlign: "left",
                  }}
                >
                  {t("+ Add “{name}”", { name: catInput })}
                </button>
              )}
            </div>
          )}
        </>
      )}

      <SectionEyebrow label={t("Place")} />
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: `0 ${P}px 4px` }}>
        {placeList.map((p) => (
          <button key={p.id} onClick={() => onTogglePlaceChip(p.id)} style={chipStyle(placeId === p.id)}>
            {p.name}
          </button>
        ))}
        <button onClick={onTogglePlaceInput} style={ghostChipStyle}>
          {t("Type a place…")}
        </button>
      </div>
      {showPlace && (
        <div style={{ position: "relative", padding: `0 ${P}px 6px` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Ico d="M3 9l9-7 9 7v11a1 1 0 01-1 1h-4v-7H8v7H4a1 1 0 01-1-1V9z" size={15} color={placeId ? TEAL : C.mute} />
            <input
              // biome-ignore lint/a11y/noAutofocus: flag-gated — set only right after the user taps "Type a place…", never on a programmatic expand
              autoFocus={placeAutoFocus}
              placeholder={t("Place")}
              value={placeId ? (places.find((p) => p.id === placeId)?.name ?? "") : placeInput}
              onChange={(e) => onPlaceInputChange(e.target.value)}
              onFocus={onFieldFocus}
              style={{
                flex: 1,
                background: "none",
                border: "none",
                borderBottom: `1px solid ${C.line}`,
                color: C.text,
                fontSize: 12,
                fontFamily: font,
                padding: "4px 0",
              }}
            />
            {placeId && (
              <button onClick={onClearPlace} style={{ background: "none", border: "none", color: C.mute, fontSize: 11, cursor: "pointer" }}>
                ✕
              </button>
            )}
          </div>
          {/* in draft the place travels by NAME to /import/apply (server creates/matches) —
              no local.createPlace button; dropdown only when there are suggestions */}
          {placeInput && !placeId && (!isDraft || filteredPlaces.length > 0) && (
            <div
              style={{
                position: "absolute",
                top: "100%",
                left: 23,
                right: 0,
                background: C.card,
                border: `1px solid ${C.line}`,
                borderRadius: 8,
                zIndex: 10,
                maxHeight: 140,
                overflowY: "auto",
                marginTop: 2,
                boxShadow: "0 4px 14px rgba(0,0,0,0.1)",
              }}
            >
              {filteredPlaces.map((p) => (
                <button
                  key={p.id}
                  onClick={() => onPickPlace(p.id)}
                  style={{
                    display: "block",
                    width: "100%",
                    padding: "8px 11px",
                    background: "none",
                    border: "none",
                    borderBottom: `1px solid ${C.line}`,
                    color: C.text,
                    fontSize: 11,
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: font,
                  }}
                >
                  {p.name}
                </button>
              ))}
              {!isDraft && (
                <button
                  onClick={onCreatePlace}
                  style={{
                    display: "block",
                    width: "100%",
                    padding: "8px 11px",
                    background: "none",
                    border: "none",
                    color: TEAL,
                    fontSize: 11,
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: font,
                  }}
                >
                  {t("+ “{name}”", { name: placeInput })}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Footer: split link — the old bottom icon row's remaining link. Hidden
          in draft (import editing is the past; it never splits). */}
      {!isDraft && !splitMode && (
        <div style={{ textAlign: "center", padding: "10px 0 6px" }}>
          <button
            onClick={onEnterSplit}
            style={{ background: "none", border: "none", color: C.soft, fontSize: 11, fontWeight: 600, cursor: "pointer", padding: 0 }}
          >
            {t("Split across envelopes")} ›
          </button>
        </div>
      )}
    </>
  );
}
