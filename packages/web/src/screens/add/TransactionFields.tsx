import { useTheme } from "../../lib/contexts";
import { useT } from "../../lib/i18n";
import { Ico } from "../../lib/icons";
import { font, P } from "../../lib/theme";

/** Common name field (all three tabs) and the read-only note row with its ✕
 *  clear. Presentational — state lives in the controller. */
export function TransactionFields({
  name,
  note,
  onNameChange,
  onFieldFocus,
  onClearNote,
}: {
  name: string;
  note: string;
  onNameChange: (value: string) => void;
  onFieldFocus: () => void;
  onClearNote: () => void;
}) {
  const C = useTheme();
  const { t } = useT();
  return (
    <>
      {/* Name — the transaction title, kept from the shipped Add as one slim underline field
          (shared across all three tabs now that it no longer sits beside the category chip). */}
      <div style={{ padding: `0 ${P}px 4px` }}>
        <input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          onFocus={onFieldFocus}
          placeholder={t("Name")}
          style={{
            width: "100%",
            boxSizing: "border-box",
            background: "none",
            border: "none",
            borderBottom: `1px solid ${C.line}`,
            color: C.text,
            fontSize: 14,
            fontFamily: font,
            padding: "5px 2px",
          }}
        />
      </div>

      {/* An existing note is shown read-only (new notes can no longer be added) — ✕ clears it,
          taking effect when the transaction is saved. */}
      {note && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: `0 ${P}px 4px` }}>
          <Ico d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" size={14} color={C.mute} />
          <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: C.soft, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {note}
          </span>
          <button onClick={onClearNote} style={{ background: "none", border: "none", color: C.mute, fontSize: 11, cursor: "pointer", flexShrink: 0 }}>
            ✕
          </button>
        </div>
      )}
    </>
  );
}
