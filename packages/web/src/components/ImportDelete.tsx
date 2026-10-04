import { useTheme } from "../lib/contexts";
import { useT } from "../lib/i18n";
import { font, tint } from "../lib/theme";

/** The in-place confirmation a destructive import action asks for, the same shape as deleting a
 *  transaction in the side panel: no browser dialog, no popup over the list. */
export function ImportDeleteConfirm({
  title,
  body,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const C = useTheme();
  const { t } = useT();
  return (
    <div
      data-import-delete-confirm
      role="alertdialog"
      aria-label={title}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 9,
        border: `1px solid ${C.neg}`,
        borderRadius: 12,
        padding: "12px 13px",
        background: tint(C.neg, 0.06),
        textAlign: "left",
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 650, color: C.text }}>{title}</span>
      <span style={{ fontSize: 11.5, color: C.soft, lineHeight: 1.45 }}>{body}</span>
      <div style={{ display: "flex", gap: 8, width: "100%", maxWidth: 320, marginLeft: "auto" }}>
        <button type="button" onClick={onCancel} disabled={busy} style={{ ...importPill(C.line, C.soft), background: C.card }}>
          {t("Cancel")}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          style={{ ...importPill("transparent", "#fff"), border: "none", background: C.neg, fontWeight: 650, opacity: busy ? 0.6 : 1 }}
        >
          {t("Delete")}
        </button>
      </div>
    </div>
  );
}

export const importPill = (border: string, color: string) =>
  ({
    flex: 1,
    textAlign: "center",
    padding: "10px 0",
    minHeight: 36,
    boxSizing: "border-box",
    borderRadius: 11,
    border: `1px solid ${border}`,
    background: "transparent",
    color,
    fontSize: 13,
    cursor: "pointer",
    fontFamily: font,
  }) as const;
