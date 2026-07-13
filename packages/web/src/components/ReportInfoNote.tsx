import { useState } from "react";
import { useTheme } from "../lib/contexts";
import { useT, type Message } from "../lib/i18n";
import { isNoteDismissed, setNoteDismissed } from "../lib/reportNotes";

/**
 * Collapsible ⓘ "how to read" note for a report (spec 2026-07-11-raporty-b-design).
 *
 * - Expanded: a box on C.inset with an "i" icon and dictionary text; `**...**`
 *   in the content renders as <b> (bold in C.text color). ✕ on the right
 *   collapses the note.
 * - Collapsed: just the "i" chip (24px) aligned right; tap → expand.
 * - Per-report state in localStorage `enveo.reportNotes` (lib/reportNotes.ts),
 *   per device, outside sync. The caller places the component BELOW the title.
 * - Colors EXCLUSIVELY neutral (C.inset/C.line/C.mute/C.soft/C.text) — zero
 *   var(--accent)/var(--danger); in reports red means overspending.
 */
export function ReportInfoNote({ id, textKey }: { id: string; textKey: Message }) {
  const C = useTheme();
  const { t } = useT();
  const [dismissed, setDismissed] = useState(() => isNoteDismissed(id));

  const toggle = (v: boolean) => {
    setNoteDismissed(id, v);
    setDismissed(v);
  };

  if (dismissed) {
    return (
      <div style={{ display: "flex", justifyContent: "flex-end", margin: "0 0 10px" }}>
        <button
          type="button"
          aria-label={t("Show hint")}
          onClick={() => toggle(false)}
          style={{
            width: 24,
            height: 24,
            borderRadius: 12,
            border: `1px solid ${C.line}`,
            background: "transparent",
            color: C.mute,
            fontSize: 11.5,
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            cursor: "pointer",
          }}
        >
          i
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        gap: 9,
        alignItems: "flex-start",
        background: C.inset,
        border: `1px solid ${C.line}`,
        borderRadius: 10,
        padding: "9px 12px",
        fontSize: 11.5,
        color: C.soft,
        lineHeight: 1.55,
        margin: "0 0 14px",
      }}
    >
      <span
        aria-hidden
        style={{
          flexShrink: 0,
          width: 16,
          height: 16,
          borderRadius: 8,
          border: `1.5px solid ${C.mute}`,
          color: C.mute,
          fontSize: 10.5,
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          marginTop: 1,
        }}
      >
        i
      </span>
      <span style={{ flex: 1 }}>{renderBold(t(textKey), C.text)}</span>
      <button
        type="button"
        aria-label={t("Collapse hint")}
        onClick={() => toggle(true)}
        style={{
          flexShrink: 0,
          border: "none",
          background: "transparent",
          color: C.mute,
          fontSize: 13,
          lineHeight: 1,
          padding: "1px 2px",
          marginLeft: 2,
          cursor: "pointer",
        }}
      >
        ✕
      </button>
    </div>
  );
}

/** Dictionary text with `**...**` markers → <b> fragments (odd indices after split). */
function renderBold(text: string, boldColor: string) {
  return text.split("**").map((part, i) =>
    i % 2 === 1 ? (
      <b key={i} style={{ color: boldColor, fontWeight: 600 }}>
        {part}
      </b>
    ) : (
      part
    ),
  );
}
