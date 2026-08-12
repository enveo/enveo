import { useEffect, useRef } from "react";
import { useTheme } from "../lib/contexts";
import { haptic } from "../lib/haptics";
import { font, TEAL } from "../lib/theme";

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
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: PADH,
          background: `linear-gradient(${C.sheet},transparent)`,
          zIndex: 3,
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: PADH,
          background: `linear-gradient(transparent,${C.sheet})`,
          zIndex: 3,
          pointerEvents: "none",
        }}
      />
      <div
        style={{ position: "absolute", top: PADH, left: 4, right: 4, height: IH, background: C.bg, borderRadius: 8, zIndex: 1, border: `1px solid ${C.line}` }}
      />
      {/* height:IH (NOT "100%"): the outer wrapper's overflow:hidden already IS the IH*VIS peep-hole —
          this div only needs ONE row's worth of content box, so clientHeight (content+padding) lands
          at exactly IH+2*PADH. That makes scrollHeight-clientHeight == (items.length-1)*IH, i.e. the
          LAST item's centered scrollTop is reachable. Measured root cause (not scroll chaining): with
          height:"100%" this div's content box matched the full IH*VIS window, inflating clientHeight by
          IH*(VIS-1) (160px at VIS=5) and capping the browser's native max scrollTop that far short of
          (n-1)*IH — so the last VIS-1 items (and the ENTIRE wheel whenever items.length<=VIS, e.g. the
          5-year list) could never be scrolled to center, confirmed via CDP touch simulation showing the
          wheel pinned at its own (too-small) max with no scrollTop change anywhere else in the tree.
          overscrollBehavior contain + touchAction pan-y (bd7f924) are kept — they are still correct
          hygiene for a nested wheel, they just weren't the actual bug. */}
      <div
        ref={ref}
        className="gs"
        onScroll={onScroll}
        style={{
          height: IH,
          overflowY: "auto",
          overscrollBehavior: "contain",
          touchAction: "pan-y",
          scrollSnapType: "y mandatory",
          paddingTop: PADH,
          paddingBottom: PADH,
          position: "relative",
          zIndex: 2,
          WebkitOverflowScrolling: "touch",
        }}
      >
        {items.map((it, i) => {
          const s = it === selected;
          return (
            <div
              key={i}
              onClick={() => onSelect(it)}
              style={{
                height: IH,
                scrollSnapAlign: "center",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                fontSize: s ? 18 : 14,
                fontWeight: s ? 700 : 400,
                color: s ? C.text : C.mute,
                opacity: s ? 1 : 0.55,
              }}
            >
              {it}
            </div>
          );
        })}
      </div>
    </div>
  );
}

type Key = [string, "n" | "o" | "f" | "k" | ""];
/** Same key order as the docked variant's rows: [1 2 3 ⌫][4 5 6 +][7 8 9 −][× 0 , ✓] —
 * both variants share it (digits 1-2-3 on top, comma under 9, contextual OK bottom-right). */
const KEYS: Key[] = [
  ["1", "n"],
  ["2", "n"],
  ["3", "n"],
  ["DEL", "f"],
  ["4", "n"],
  ["5", "n"],
  ["6", "n"],
  ["+", "o"],
  ["7", "n"],
  ["8", "n"],
  ["9", "n"],
  ["−", "o"],
  ["×", "o"],
  ["0", "n"],
  [",", "n"],
  ["OK", "k"],
];

export function Numpad({
  onKey,
  onOk,
  okGlyph = "check",
  variant = "docked",
}: {
  onKey: (k: string) => void;
  /** Both variants have a contextual OK cell now — required in practice, optional only
   * so a caller mid-migration doesn't hard-crash. */
  onOk?: () => void;
  okGlyph?: "check" | "equals";
  variant?: "docked" | "sheet";
}) {
  const C = useTheme();

  if (variant === "sheet") {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 7, padding: "8px 14px 0", background: "transparent" }}>
        {KEYS.map((k, i) => {
          const isOk = k[0] === "OK";
          const op = k[1] === "o" || k[0] === "DEL";
          if (variant === "sheet" && k[0] === "×") {
            return <span key={i} />;
          }
          return (
            <button
              key={i}
              onClick={() => {
                haptic(6);
                if (isOk) onOk?.();
                else onKey(k[0] === "DEL" ? "DEL" : k[0]);
              }}
              style={{
                padding: "10px 0",
                background: isOk ? "var(--accent-22)" : op ? C.chip : C.key,
                border: "none",
                borderRadius: 10,
                color: isOk ? TEAL : op ? C.soft : C.text,
                fontSize: op ? 13.5 : 16,
                fontWeight: 600,
                fontFamily: font,
                cursor: "pointer",
                boxShadow: op || isOk ? "none" : "0 1px 2px rgba(30,30,40,0.08)",
              }}
            >
              {k[0] === "DEL" ? "⌫" : isOk ? (okGlyph === "equals" ? "=" : "✓") : k[0]}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    // env(safe-area-inset-bottom): the bottom row must not slide under the iOS home indicator (viewport-fit=cover)
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 1, background: C.keybg, paddingBottom: "env(safe-area-inset-bottom)" }}>
      {KEYS.map((k, i) => (
        <button
          key={i}
          onClick={() => {
            haptic(6);
            if (k[0] === "OK") onOk?.();
            else if (k[0] === "DEL") onKey("DEL");
            else onKey(k[0]);
          }}
          style={{
            padding: "15px 0",
            background: k[0] === "OK" ? "var(--accent-22)" : k[1] === "o" || k[0] === "DEL" ? C.chip : C.key,
            border: "none",
            color: k[0] === "OK" ? TEAL : k[1] === "o" || k[0] === "DEL" ? C.mute : C.text,
            fontSize: k[0] === "DEL" ? 16 : 19,
            fontWeight: 500,
            fontFamily: font,
            cursor: "pointer",
          }}
        >
          {k[0] === "DEL" ? "⌫" : k[0] === "OK" ? (okGlyph === "equals" ? "=" : "✓") : k[0]}
        </button>
      ))}
    </div>
  );
}
