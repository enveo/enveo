import { useBand } from "../../components/kit";
import { useTheme } from "../../lib/contexts";
import { msg, useT } from "../../lib/i18n";
import { Ico } from "../../lib/icons";
import { CORAL, font, tint } from "../../lib/theme";
import type { Tab } from "./types";

/** Header for create, edit and draft: back arrow + type tabs always; in edit
 *  trash + kebab on the right, in draft an alignment spacer, otherwise the
 *  screenshot-import camera. Purely presentational — every action (tab switch
 *  reset, delete confirm, duplicate, import open) lives in the controller. */
export function AddHeader({
  tab,
  isEdit,
  isDraft,
  menuOpen,
  onBack,
  onTabSelect,
  onDelete,
  onToggleMenu,
  onDuplicate,
  onOpenImport,
}: {
  tab: Tab;
  isEdit: boolean;
  isDraft: boolean;
  menuOpen: boolean;
  onBack: () => void;
  onTabSelect: (tab: Tab) => void;
  onDelete: () => void;
  onToggleMenu: () => void;
  onDuplicate: () => void;
  onOpenImport: () => void;
}) {
  const C = useTheme();
  const { band, hc } = useBand();
  const { t } = useT();
  return (
    <div data-band={band || undefined} style={band ? { background: C.headerBg, paddingBottom: isDraft ? 6 : undefined } : undefined}>
      <div style={{ display: "flex", alignItems: "center", padding: "8px 10px", gap: 6 }}>
        <button onClick={onBack} aria-label={t("Back")} style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex" }}>
          <Ico d="M19 12H5m0 0l7 7m-7-7l7-7" size={18} color={hc(C.headerInk, C.text)} />
        </button>
        <div style={{ display: "flex", background: hc(tint(C.headerInk, 0.14), C.chip), borderRadius: 14, padding: 2, flex: 1, border: "none" }}>
          {(["expense", "income", "transfer"] as Tab[]).map((tb) => (
            <button
              key={tb}
              onClick={() => onTabSelect(tb)}
              style={{
                flex: 1,
                padding: "8px 0",
                borderRadius: 11,
                border: "none",
                fontSize: 12,
                fontWeight: 650,
                cursor: "pointer",
                background: tab === tb ? (band ? "var(--cta)" : C.text) : "transparent",
                color: tab === tb ? (band ? C.headerBg : C.card) : band ? C.headerMute : C.soft,
              }}
            >
              {t(({ expense: msg("Expense"), income: msg("Income"), transfer: msg("Transfer") } as const)[tb])}
            </button>
          ))}
        </div>
        {isEdit ? (
          <>
            <button
              onClick={onDelete}
              aria-label={t("Delete")}
              style={{
                width: 34,
                height: 34,
                borderRadius: 10,
                border: "none",
                background: hc(tint(C.headerInk, 0.13), C.surface),
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              {/* trash: lid + bucket */}
              <Ico
                d="M4 7h16M9 7V5a1 1 0 011-1h6a1 1 0 011 1v2m3 0l-.9 12.1A2 2 0 0115.1 21H8.9a2 2 0 01-2-1.9L6 7m4 4v6m4-6v6"
                size={17}
                color={hc(C.headerNeg, CORAL)}
                sw={2}
              />
            </button>
            <div style={{ position: "relative", flexShrink: 0 }}>
              <button
                onClick={onToggleMenu}
                aria-label={t("Duplicate")}
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 10,
                  border: "none",
                  background: hc(tint(C.headerInk, 0.13), C.surface),
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {/* kebab: 3 dots */}
                <svg width="17" height="17" viewBox="0 0 24 24" fill={hc(C.headerInk, C.text)}>
                  <circle cx="12" cy="5" r="2" />
                  <circle cx="12" cy="12" r="2" />
                  <circle cx="12" cy="19" r="2" />
                </svg>
              </button>
              {menuOpen && (
                <div
                  style={{
                    position: "absolute",
                    top: 38,
                    right: 0,
                    background: C.card,
                    border: `1px solid ${C.line}`,
                    borderRadius: 10,
                    boxShadow: "0 6px 18px rgba(0,0,0,0.16)",
                    zIndex: 30,
                    minWidth: 150,
                    overflow: "hidden",
                  }}
                >
                  <button
                    onClick={onDuplicate}
                    style={{
                      display: "block",
                      width: "100%",
                      padding: "11px 14px",
                      background: "none",
                      border: "none",
                      color: C.text,
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: "pointer",
                      textAlign: "left",
                      fontFamily: font,
                    }}
                  >
                    {t("Duplicate")}
                  </button>
                </div>
              )}
            </div>
          </>
        ) : isDraft ? (
          <div style={{ width: 26 }} />
        ) : (
          <button
            onClick={onOpenImport}
            aria-label={t("Import from a file")}
            style={{ background: "none", border: "none", cursor: "pointer", padding: 4, display: "flex", flexShrink: 0 }}
          >
            <Ico
              d="M4 8.5A1.5 1.5 0 015.5 7H8l1.6-2.4a1 1 0 01.9-.6h3a1 1 0 01.9.6L16 7h2.5A1.5 1.5 0 0120 8.5v9a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 17.5v-9zM12 16a3.5 3.5 0 100-7 3.5 3.5 0 000 7z"
              size={19}
              color={hc(C.headerInk, C.soft)}
              sw={1.7}
            />
          </button>
        )}
      </div>

      {isDraft && (
        <div style={{ textAlign: "center", fontSize: 12, fontWeight: 600, color: hc(C.headerMute, C.soft), padding: "0 10px 4px" }}>{t("Imported item")}</div>
      )}
    </div>
  );
}
