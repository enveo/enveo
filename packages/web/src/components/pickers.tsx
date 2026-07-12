import { useEffect, useRef } from "react";
import { useTheme } from "../lib/contexts";
import { haptic } from "../lib/haptics";
import { TEAL, font } from "../lib/theme";

export function ScrollPicker<T extends string | number>({
  items,
  selected,
  onSelect,
  width,
}: {
  items: T[];
  selected: T;
  onSelect: (v: T) => void;
  width?: string;
}) {
  const C = useTheme();
  const ref = useRef<HTMLDivElement | null>(null);
  const IH = 40,
    VIS = 5,
    PADH = IH * Math.floor(VIS / 2);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const idx = items.indexOf(selected);
    if (idx >= 0) el.scrollTop = idx * IH;
  }, [selected, items]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const idx = Math.round(e.currentTarget.scrollTop / IH);
    if (idx >= 0 && idx < items.length && items[idx] !== selected) onSelect(items[idx]!);
  };

  return (
    <div style={{ height: IH * VIS, overflow: "hidden", position: "relative", width: width ?? "auto" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: PADH, background: `linear-gradient(${C.sheet},transparent)`, zIndex: 3, pointerEvents: "none" }} />
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: PADH, background: `linear-gradient(transparent,${C.sheet})`, zIndex: 3, pointerEvents: "none" }} />
      <div style={{ position: "absolute", top: PADH, left: 4, right: 4, height: IH, background: C.bg, borderRadius: 8, zIndex: 1, border: `1px solid ${C.line}` }} />
      <div ref={ref} className="gs" onScroll={onScroll} style={{ height: "100%", overflowY: "auto", scrollSnapType: "y mandatory", paddingTop: PADH, paddingBottom: PADH, position: "relative", zIndex: 2, WebkitOverflowScrolling: "touch" }}>
        {items.map((it, i) => {
          const s = it === selected;
          return (
            <div key={i} onClick={() => onSelect(it)} style={{ height: IH, scrollSnapAlign: "center", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: s ? 18 : 14, fontWeight: s ? 700 : 400, color: s ? C.text : C.mute, opacity: s ? 1 : 0.55 }}>
              {it}
            </div>
          );
        })}
      </div>
    </div>
  );
}

type Key = [string, "n" | "o" | "f" | "k" | ""];
const KEYS: Key[] = [
  ["1", "n"], ["2", "n"], ["3", "n"], ["DEL", "f"],
  ["4", "n"], ["5", "n"], ["6", "n"], ["+", "o"],
  ["7", "n"], ["8", "n"], ["9", "n"], ["−", "o"],
  ["×", "o"], ["0", "n"], [",", "n"], ["OK", "k"],
];

export function Numpad({ onKey, onOk, okGlyph = "check" }: { onKey: (k: string) => void; onOk: () => void; okGlyph?: "check" | "equals" }) {
  const C = useTheme();
  return (
    // env(safe-area-inset-bottom): the bottom row must not slide under the iOS home indicator (viewport-fit=cover)
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 1, background: C.keybg, paddingBottom: "env(safe-area-inset-bottom)" }}>
      {KEYS.map((k, i) => (
        <button
          key={i}
          onClick={() => {
            haptic(6);
            if (k[0] === "OK") onOk();
            else if (k[0] === "DEL") onKey("DEL");
            else onKey(k[0]);
          }}
          style={{ padding: "15px 0", background: k[0] === "OK" ? "var(--accent-22)" : C.key, border: "none", color: k[0] === "OK" ? TEAL : k[1] === "o" || k[0] === "DEL" ? C.mute : C.text, fontSize: k[0] === "DEL" ? 16 : 19, fontWeight: 500, fontFamily: font, cursor: "pointer" }}
        >
          {k[0] === "DEL" ? "⌫" : k[0] === "OK" ? (okGlyph === "equals" ? "=" : "✓") : k[0]}
        </button>
      ))}
    </div>
  );
}
