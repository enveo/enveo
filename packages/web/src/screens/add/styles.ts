import type { CSSProperties } from "react";
import { font, P, type Theme } from "../../lib/theme";

/** Collapsed single-row summary under a section eyebrow (the reconcile widget's envelope row). */
export const collapsedRowStyle = (C: Theme, accent: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 9,
  textAlign: "left",
  width: `calc(100% - ${2 * P}px)`,
  background: accent ? C.card : "none",
  border: accent ? `2px solid var(--accent)` : `1.3px dashed ${C.line}`,
  borderRadius: 12,
  padding: "9px 12px",
  margin: `0 ${P}px`,
  cursor: "pointer",
});

/** The small accent link in a section eyebrow ("Other ›" / "Collapse ›"). */
export const linkBtnStyle: CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  color: "var(--accent)",
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: font,
};
