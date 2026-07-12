import { useRef, useState } from "react";
import { haptic } from "./haptics";

/**
 * Drag-to-reorder (pointer events, mobile-first).
 *  - hang `itemRef(i)` on the item element (slot hit-testing + the "ghost" follows the finger),
 *  - spread `bind(i)` on the drag handle (can be the whole tile),
 *  - `dragging` / `over` are indexes for highlighting the dragged item and the target slot.
 * Commit(from → to) only on release — the DOM stays stable during the move,
 * so pointer capture doesn't lose the element. At screen edges it scrolls the
 * nearest `.gs` container, compensating the transform by the scrolled distance.
 */
export function useDragReorder(onCommit: (from: number, to: number) => void) {
  const items = useRef(new Map<number, HTMLElement>());
  const drag = useRef<{ from: number; x: number; y: number; el: HTMLElement; r0: DOMRect; sc: HTMLElement | null; scroll0: number } | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);

  const itemRef = (i: number) => (el: HTMLElement | null) => {
    if (el) items.current.set(i, el);
    else items.current.delete(i);
  };

  const slotAt = (x: number, y: number): number | null => {
    const d = drag.current;
    if (d && x >= d.r0.left && x <= d.r0.right && y >= d.r0.top && y <= d.r0.bottom) return d.from;
    for (const [i, el] of items.current) {
      if (d && i === d.from) continue;
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return i;
    }
    return null;
  };

  const reset = () => {
    const d = drag.current;
    if (d) {
      d.el.style.transform = "";
      d.el.style.zIndex = "";
      d.el.style.opacity = "";
      d.el.style.boxShadow = "";
    }
    drag.current = null;
    setDragging(null);
    setOver(null);
  };

  const bind = (i: number) => ({
    onPointerDown: (e: React.PointerEvent) => {
      const el = items.current.get(i);
      if (!el) return;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      const sc = el.closest(".gs") as HTMLElement | null;
      drag.current = { from: i, x: e.clientX, y: e.clientY, el, r0: el.getBoundingClientRect(), sc, scroll0: sc?.scrollTop ?? 0 };
      el.style.zIndex = "60";
      el.style.opacity = "0.93";
      el.style.boxShadow = "0 10px 26px rgba(0,0,0,0.3)";
      setDragging(i);
      setOver(i);
      haptic(8);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      if (d.sc) {
        if (e.clientY > window.innerHeight - 90) d.sc.scrollTop += 10;
        else if (e.clientY < 130) d.sc.scrollTop -= 10;
      }
      const sd = (d.sc?.scrollTop ?? 0) - d.scroll0;
      d.el.style.transform = `translate(${e.clientX - d.x}px, ${e.clientY - d.y + sd}px) scale(1.03)`;
      const t = slotAt(e.clientX, e.clientY);
      if (t !== null) setOver(t);
    },
    onPointerUp: (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const t = slotAt(e.clientX, e.clientY);
      reset();
      if (t !== null && t !== d.from) {
        haptic([6, 20, 8]);
        onCommit(d.from, t);
      }
    },
    onPointerCancel: reset,
    // don't trigger the sheet's swipe-down or other parent gestures while dragging
    onTouchStart: (e: React.TouchEvent) => e.stopPropagation(),
    style: {
      touchAction: "none" as const,
      WebkitUserSelect: "none" as const,
      userSelect: "none" as const,
      WebkitTouchCallout: "none" as const,
      cursor: "grab" as const,
    },
  });

  return { itemRef, bind, dragging, over };
}
