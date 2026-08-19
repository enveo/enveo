import { SectionEyebrow } from "../../components/kit";
import { useTheme } from "../../lib/contexts";
import { INPUT_FOCUS_CLASS } from "../../lib/focusPresentation";
import { useT } from "../../lib/i18n";
import { Ico } from "../../lib/icons";
import { font, P } from "../../lib/theme";

/** Name (all three tabs) and the read-only note row with its ✕ clear. Last in the
 *  scroll column by design: the flow card answers "where does the money go", the
 *  title is the optional afterthought. Presentational — state lives in the controller. */
export function TransactionFields({
  name,
  note,
  placeholder,
  onNameChange,
  onFieldFocus,
  onClearNote,
}: {
  name: string;
  note: string;
  placeholder: string;
  onNameChange: (value: string) => void;
  onFieldFocus: () => void;
  onClearNote: () => void;
}) {
  const C = useTheme();
  const { t } = useT();
  return (
    <>
      <SectionEyebrow label={t("Name")} right={<span>{t("optional · at the end")}</span>} />
      <div style={{ padding: `0 ${P}px 6px` }}>
        <div
          className={INPUT_FOCUS_CLASS}
          style={{ display: "flex", alignItems: "center", gap: 9, background: C.card, border: `1px solid ${C.line}`, borderRadius: 13, padding: "10px 12px" }}
        >
          <Ico d="M16.5 4.5l3 3L9 18l-4 1 1-4z" size={15} color={C.mute} sw={1.8} />
          <input
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            onFocus={onFieldFocus}
            placeholder={placeholder}
            style={{
              flex: 1,
              minWidth: 0,
              background: "none",
              border: "none",
              color: C.text,
              fontSize: 13.5,
              fontFamily: font,
              padding: 0,
            }}
          />
        </div>
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
