import { Children, useState, type ReactNode } from "react";
import { useTheme } from "../../lib/contexts";
import { Ico } from "../../lib/icons";
import { CORAL, TEAL, font } from "../../lib/theme";

/* ── Shared Settings section patterns (moved 1:1 from Settings.tsx) ──
 * Failed writes are rendered with apiErrorMessage (lib/api.ts): it turns every server error CODE
 * — and the client-side "foreign_replica" sentinel the multi-tenant guard throws — into a sentence
 * in the UI language. (A 401 never reaches it: the app routes to the Login screen.) */

export function Eyebrow({ children }: { children: ReactNode }) {
  const C = useTheme();
  return (
    <div style={{ fontSize: 10.5, fontWeight: 600, color: C.mute, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 8 }}>
      {children}
    </div>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  const C = useTheme();
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 0", borderBottom: `1px solid ${C.line}` }}>
      <span style={{ fontSize: 13.5, color: C.text, fontWeight: 500 }}>{label}</span>
      {children}
    </div>
  );
}

/** Helper text below a button — consistent, quiet. */
export function Helper({ children }: { children: ReactNode }) {
  const C = useTheme();
  return <div style={{ fontSize: 11, color: C.mute, lineHeight: 1.5, marginTop: 8 }}>{children}</div>;
}

/** Collapsible section — collapsed by default, the chevron rotates on open. */
export function Collapsible({ title, children }: { title: string; children: ReactNode }) {
  const C = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 24 }}>
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: 0, background: "none", border: "none", cursor: "pointer" }}>
        <span style={{ display: "flex", transform: open ? "rotate(90deg)" : "none", transition: "transform .2s" }}>
          <Ico d="M9 5l7 7-7 7" size={13} color={C.mute} />
        </span>
        <span style={{ fontSize: 10.5, fontWeight: 600, color: C.mute, textTransform: "uppercase", letterSpacing: 0.6 }}>{title}</span>
      </button>
      {open && <div style={{ marginTop: 8 }}>{children}</div>}
    </div>
  );
}

/** Segmented control (Theme / Language) — one active button from the list. */
export function Seg<T extends string>({ value, options, onChange }: { value: T; options: Array<{ id: T; label: string }>; onChange: (id: T) => void }) {
  const C = useTheme();
  return (
    <div style={{ display: "flex", background: C.bg, borderRadius: 9, padding: 2, border: `1px solid ${C.line}` }}>
      {options.map((o) => (
        <button key={o.id} onClick={() => onChange(o.id)} style={{ padding: "6px 12px", borderRadius: 7, border: "none", fontSize: 11.5, fontWeight: 600, cursor: "pointer", background: value === o.id ? TEAL : "transparent", color: value === o.id ? "#fff" : C.soft, whiteSpace: "nowrap" }}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Action row group — a white card like on the Settings hub; children separated by a border. */
export function ActionGroup({ children }: { children: ReactNode }) {
  const C = useTheme();
  const items = Children.toArray(children);
  return (
    <div style={{ background: C.card, borderRadius: 14, boxShadow: "0 1px 3px rgba(0,0,0,0.05)", overflow: "hidden" }}>
      {items.map((child, i) => (
        <div key={i} style={{ borderTop: i > 0 ? `1px solid ${C.line}` : "none" }}>
          {child}
        </div>
      ))}
    </div>
  );
}

/** Action row icon — a stroke 1.8 glyph in the tone color (currentColor from the wrapper span). */
export function ActionIcon({ paths, size = 19 }: { paths: string[]; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ stroke: "currentColor" }} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

/** Action row: icon + colored title + inline description; tone per theme. */
export function ActionRow({
  icon,
  label,
  desc,
  tone = "primary",
  onClick,
  disabled,
  busyLabel,
  chevron,
}: {
  icon?: ReactNode;
  label: string;
  desc?: string;
  tone?: "primary" | "danger" | "neutral";
  onClick: () => void;
  disabled?: boolean;
  busyLabel?: string;
  chevron?: boolean;
}) {
  const C = useTheme();
  const toneColor = tone === "primary" ? "var(--cta)" : tone === "danger" ? "var(--danger)" : C.text;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "13px 14px", background: "none", border: "none", textAlign: "left", fontFamily: font, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1 }}
    >
      {icon && <span style={{ display: "flex", flexShrink: 0, color: toneColor }}>{icon}</span>}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 14, fontWeight: 700, color: toneColor }}>{busyLabel ?? label}</span>
        {desc && <span style={{ display: "block", fontSize: 11, color: C.mute, marginTop: 1, lineHeight: 1.45 }}>{desc}</span>}
      </span>
      {chevron && (
        <span style={{ display: "flex", flexShrink: 0 }}>
          <Ico d="M9 5l7 7-7 7" size={14} color={C.mute} sw={2} />
        </span>
      )}
    </button>
  );
}

/** Full action button (filled / outlined / coral variant) —
 * replaced by rows (ActionRow) in Settings subscreens (including sheets);
 * the export stays for uses outside Settings. */
export function ActionButton({
  label,
  onClick,
  disabled,
  variant = "outline",
  style,
}: {
  label: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: "teal" | "outline" | "coral" | "coralOutline";
  style?: React.CSSProperties;
}) {
  const C = useTheme();
  const base: React.CSSProperties = { width: "100%", padding: "12px 0", borderRadius: 11, fontSize: 13.5, fontWeight: 600, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1 };
  const variants: Record<string, React.CSSProperties> = {
    teal: { border: "none", background: TEAL, color: "#fff" },
    coral: { border: "none", background: CORAL, color: "#fff" },
    outline: { border: `1px solid ${C.line}`, background: C.bg, color: C.text },
    coralOutline: { border: `1px solid ${CORAL}`, background: "transparent", color: CORAL },
  };
  return (
    <button onClick={onClick} disabled={disabled} style={{ ...base, ...variants[variant], ...style }}>
      {label}
    </button>
  );
}
