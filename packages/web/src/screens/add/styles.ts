import type { CSSProperties } from "react";
import { font, P, type Theme } from "../../lib/theme";




 
export const gridCardStyle = (C: Theme, selected: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 7,
  background: C.card,
  textAlign: "left",
  width: "100%",
  border: `${selected ? 2 : 1}px solid ${selected ? "var(--accent)" : C.line}`,
  borderRadius: 11,
  padding: selected ? "7px 9px" : "8px 10px",
  cursor: "pointer",
});

 
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
