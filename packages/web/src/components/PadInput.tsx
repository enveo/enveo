import type React from "react";
import { useEffect, useRef, useState } from "react";
import { fmtSignedTrim } from "../lib/amount";
import { useTheme } from "../lib/contexts";
import { evalExpression, localizePadExpression } from "../lib/format";
import { useT } from "../lib/i18n";
import { useWideHost } from "../lib/shellContext";
import { type AmountPadTarget, useDockedPadLine } from "./AmountPadSheet";

/**
 * The amount input of a sheet or panel form. On phone and foldable layouts it is read-only and a
 * tap or focus opens the shared amount pad (`onPad(target())`); while a docked pad (foldable)
 * edits it, it shows that pad's expression. On desktop there is a keyboard, so it is typed in
 * directly, like a Budget allocation cell: focus starts an edit from the target's value, + − × ÷
 * work, Enter or leaving the field commits, Escape discards, and Tab moves to the next field
 * (committing this one).
 *
 * The active field is marked with `data-pad-active` (`data-pad-error` on a bad value). Inside a
 * caller's `data-pad-box` container (pass `boxed`) the box draws the ring (PAD_BOX_CSS), so the
 * sign and currency symbol beside the input sit inside it; otherwise the input draws it.
 */
export function PadInput<T extends AmountPadTarget>({
  value,
  target,
  onPad,
  boxed = false,
  style,
  ...input
}: {
  /** The resting display (already localized by the caller). */
  value: string;
  target: () => T;
  onPad: (target: T) => void;
  boxed?: boolean;
  style?: React.CSSProperties;
} & Pick<React.InputHTMLAttributes<HTMLInputElement>, "aria-label" | "placeholder" | "tabIndex" | "disabled">) {
  const C = useTheme();
  const { lang } = useT();
  const desktop = useWideHost()?.mode === "desktop";
  const [draft, setDraft] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  // Escape blurs the field to end the edit; that blur must not commit what Escape discarded.
  const cancelingRef = useRef(false);
  const openedRef = useRef<T | null>(null);
  const docked = useDockedPadLine(openedRef.current);
  // A draft started on desktop does not survive a switch to the pad layouts.
  useEffect(() => {
    if (!desktop) {
      setDraft(null);
      setErr(false);
    }
  }, [desktop]);

  const active = desktop ? draft !== null : docked !== null;
  const activeStyle = (bad: boolean): React.CSSProperties => ({
    color: bad ? "var(--danger)" : C.text,
    ...(boxed ? null : { background: "var(--card)", borderRadius: 6, outline: `2px solid ${bad ? "var(--danger)" : "var(--accent)"}`, outlineOffset: 3 }),
  });
  const marks = { "data-pad-active": active ? "" : undefined, "data-pad-error": active && err ? "" : undefined };

  if (!desktop) {
    const open = () => {
      const t = target();
      openedRef.current = t;
      onPad(t);
    };
    return (
      <input
        {...input}
        {...marks}
        value={docked !== null ? localizePadExpression(docked, lang) || "0" : value}
        readOnly
        onClick={open}
        onFocus={open}
        style={active ? { ...style, ...activeStyle(false) } : style}
      />
    );
  }

  return (
    <input
      {...input}
      {...marks}
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
      style={{ ...style, cursor: "text", ...(active ? activeStyle(err) : null) }}
    />
  );
}
