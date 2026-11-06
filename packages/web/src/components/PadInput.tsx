import type React from "react";
import { useEffect, useRef, useState } from "react";
import { fmtSignedTrim } from "../lib/amount";
import { evalExpression } from "../lib/format";
import { useWideHost } from "../lib/shellContext";
import type { AmountPadTarget } from "./AmountPadSheet";

/**
 * The amount input of a sheet or panel form. On phone and foldable layouts it is read-only and a
 * tap or focus opens the shared amount pad (`onPad(target())`). On desktop there is a keyboard,
 * so it is typed in directly, like a Budget allocation cell: focus starts an edit from the
 * target's value, + − × ÷ work, Enter or leaving the field commits, Escape discards, and Tab
 * moves to the next field (committing this one).
 */
export function PadInput<T extends AmountPadTarget>({
  value,
  target,
  onPad,
  style,
  ...input
}: {
  /** The resting display (already localized by the caller). */
  value: string;
  target: () => T;
  onPad: (target: T) => void;
  style?: React.CSSProperties;
} & Pick<React.InputHTMLAttributes<HTMLInputElement>, "aria-label" | "placeholder" | "tabIndex" | "disabled">) {
  const desktop = useWideHost()?.mode === "desktop";
  const [draft, setDraft] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  // Escape blurs the field to end the edit; that blur must not commit what Escape discarded.
  const cancelingRef = useRef(false);
  // A draft started on desktop does not survive a switch to the pad layouts.
  useEffect(() => {
    if (!desktop) {
      setDraft(null);
      setErr(false);
    }
  }, [desktop]);

  if (!desktop) {
    const open = () => onPad(target());
    return <input {...input} value={value} readOnly onClick={open} onFocus={open} style={style} />;
  }

  const editing = draft !== null;
  return (
    <input
      {...input}
      inputMode="decimal"
      value={draft ?? value}
      aria-invalid={err || undefined}
      onFocus={(ev) => {
        if (draft === null) {
          const initial = target().initial;
          setDraft(initial === 0 ? "" : fmtSignedTrim(initial));
        }
        const el = ev.currentTarget;
        requestAnimationFrame(() => el.select());
      }}
      onChange={(ev) => {
        setDraft(ev.target.value);
        setErr(false);
      }}
      onKeyDown={(ev) => {
        if (ev.key === "Enter") ev.currentTarget.blur();
        else if (ev.key === "Escape") {
          // Inside a side panel, Escape would otherwise reach WideShell and close the whole surface.
          ev.stopPropagation();
          cancelingRef.current = true;
          ev.currentTarget.blur();
        }
      }}
      onBlur={() => {
        if (cancelingRef.current) {
          cancelingRef.current = false;
          setDraft(null);
          setErr(false);
          return;
        }
        if (draft === null) return;
        const t = target();
        const minor = draft.trim() === "" ? 0 : evalExpression(draft);
        if (minor === null || (minor < 0 && !t.allowNegative)) {
          setErr(true);
          return;
        }
        t.onCommit(minor);
        setDraft(null);
        setErr(false);
      }}
      style={{
        ...style,
        cursor: "text",
        ...(editing
          ? {
              background: "var(--card)",
              borderRadius: 6,
              outline: `2px solid ${err ? "var(--danger)" : "var(--accent)"}`,
              outlineOffset: 3,
              color: err ? "var(--danger)" : style?.color,
            }
          : null),
      }}
    />
  );
}
