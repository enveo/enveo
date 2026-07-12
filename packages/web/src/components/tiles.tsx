import { useMask, useTheme } from "../lib/contexts";
import { isLight } from "../lib/format";
import { goalProgress } from "../lib/goals";
import { Glyph } from "../lib/icons";
import type { AccountView, EnvelopeView } from "../lib/api";

export function EnvTile({ e, onClick }: { e: EnvelopeView; onClick: () => void }) {
  const M = useMask();
  const bg = e.color;
  const txt = isLight(bg) ? "#33312c" : "#fff";
  const neg = e.available < 0;
  // Goal bar in the tile's text color (NOT accent/sage — unreadable on colored backgrounds).
  const gp = goalProgress(e);
  return (
    <button
      onClick={onClick}
      className="fu"
      style={{ position: "relative", background: bg, borderRadius: 11, padding: "7px 7px 6px", border: "none", cursor: "pointer", boxShadow: "0 1px 4px rgba(0,0,0,0.18)", overflow: "hidden", textAlign: "center", minHeight: 62, display: "flex", flexDirection: "column", justifyContent: "center", gap: 0 }}
    >
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
        <polygon points="0,0 100,0 50,34" fill="rgba(0,0,0,0.05)" />
        <line x1="0" y1="0" x2="50" y2="34" stroke="rgba(0,0,0,0.13)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <line x1="100" y1="0" x2="50" y2="34" stroke="rgba(0,0,0,0.13)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      </svg>
      <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", gap: 4, marginTop: 2 }}>
        <Glyph name={e.icon} size={12} color={txt} sw={1.6} />
        <span style={{ fontSize: 10, fontWeight: 600, color: txt, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
      </div>
      <div style={{ position: "relative", fontSize: 13, fontWeight: 700, color: txt, fontVariantNumeric: "tabular-nums", lineHeight: 1.3 }}>
        {neg ? "-" : ""}
        {M(Math.abs(e.available))}
      </div>
      {e.spent !== 0 && (
        <div style={{ position: "relative", fontSize: 9, color: txt, opacity: 0.7, fontVariantNumeric: "tabular-nums", lineHeight: 1.25 }}>
          {e.spent < 0 ? "+" : "-"}
          {M(Math.abs(e.spent))}
        </div>
      )}
      {gp && (
        <div style={{ position: "relative", height: 3, borderRadius: 2, background: txt === "#fff" ? "rgba(255,255,255,0.25)" : "rgba(51,49,44,0.2)", marginTop: 3, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${gp.pct}%`, background: txt, borderRadius: 2 }} />
        </div>
      )}
      {neg && (
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
          <line x1="8" y1="12" x2="92" y2="88" stroke="#d94f42" strokeWidth="2.4" strokeLinecap="round" vectorEffect="non-scaling-stroke" opacity="0.75" />
          <line x1="92" y1="12" x2="8" y2="88" stroke="#d94f42" strokeWidth="2.4" strokeLinecap="round" vectorEffect="non-scaling-stroke" opacity="0.75" />
        </svg>
      )}
    </button>
  );
}

const lightChip = (c: string) => c === "#e9e3d7" || c === "#cdeede";

export function AccCard({ a, onClick }: { a: AccountView; onClick: () => void }) {
  const M = useMask();
  const txt = isLight(a.color) ? "#3a3a36" : "#fff";
  return (
    <button
      onClick={onClick}
      className="fu"
      style={{ background: a.color, border: "none", borderRadius: 13, padding: "7px 10px", cursor: "pointer", display: "flex", alignItems: "center", gap: 9, boxShadow: "0 1px 4px rgba(0,0,0,0.16)", textAlign: "left" }}
    >
      <div style={{ width: 32, height: 32, borderRadius: "50%", background: "rgba(255,255,255,0.94)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Glyph name={a.icon} size={16} color={lightChip(a.color) ? "#8a8576" : a.color} sw={1.7} />
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 11.5, fontWeight: 500, color: txt, opacity: 0.92, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: 1.3 }}>{a.name}</div>
        <div style={{ fontSize: 14, fontWeight: 700, color: txt, fontVariantNumeric: "tabular-nums", lineHeight: 1.25 }}>{M(a.balance)}</div>
      </div>
    </button>
  );
}

export const accountIconColor = (color: string) => (lightChip(color) ? "#8a8576" : color);
