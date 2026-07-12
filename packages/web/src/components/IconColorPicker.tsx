import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTheme } from "../lib/contexts";
import { isLight } from "../lib/format";
import { useT, type TKey } from "../lib/i18n";
import { Glyph, ICON_CATEGORIES, Ico } from "../lib/icons";
import { EXT_PALETTE, font } from "../lib/theme";
import { Sheet } from "./chrome";

/** Hex normalization: "4fa583"/"#4FA583"/"#fa5" → "#4fa583"; null when invalid. */
export function normHex(raw: string): string | null {
  const s = raw.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{6}$/.test(s)) return `#${s}`;
  if (/^[0-9a-f]{3}$/.test(s)) return `#${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`;
  return null;
}

/**
 * Color + icon picker for account/envelope sheets. Inline: quick swatches
 * (base palette) and the current icon tile; full pickers open as
 * separate sheets via a PORTAL to body — a sheet-in-a-sheet would break
 * position:fixed through the parent panel's transform (known pitfall).
 */
export function IconColorPicker({
  palette,
  color,
  icon,
  onColor,
  onIcon,
}: {
  palette: readonly string[];
  color: string;
  icon: string;
  onColor: (c: string) => void;
  onIcon: (i: string) => void;
}) {
  const C = useTheme();
  const { t } = useT();
  const [colorSheet, setColorSheet] = useState(false);
  const [iconSheet, setIconSheet] = useState(false);
  const label = { fontSize: 10.5, color: C.mute, fontWeight: 600, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.6 } as const;
  const onGlyph = isLight(color) ? "#33312c" : "#fff";

  return (
    <>
      <div style={label}>{t("budget.colorLabel")}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 9, marginBottom: 18 }}>
        {palette.map((col) => (
          <button key={col} onClick={() => onColor(col)} aria-label={t("budget.colorAria", { color: col })} style={{ width: 32, height: 32, borderRadius: "50%", background: col, border: color === col ? `3px solid ${C.text}` : `1px solid rgba(0,0,0,0.1)`, cursor: "pointer", padding: 0 }} />
        ))}
        {/* color outside the base palette (from the sheet) — show as the selected swatch */}
        {!palette.includes(color) && (
          <button onClick={() => setColorSheet(true)} style={{ width: 32, height: 32, borderRadius: "50%", background: color, border: `3px solid ${C.text}`, cursor: "pointer", padding: 0 }} />
        )}
        <button onClick={() => setColorSheet(true)} aria-label={t("picker.moreColors")} style={{ width: 32, height: 32, borderRadius: "50%", background: C.inset, border: `1px dashed ${C.mute}`, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
          <Ico d="M12 5v14m-7-7h14" size={14} color={C.soft} sw={2} />
        </button>
      </div>

      <div style={label}>{t("common.iconLabel")}</div>
      <button onClick={() => setIconSheet(true)} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
        <div style={{ width: 44, height: 44, borderRadius: 12, background: color, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Glyph name={icon} size={20} color={onGlyph} />
        </div>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--accent)" }}>{t("picker.changeIcon")} ›</span>
      </button>

      {createPortal(
        <Sheet show={colorSheet} onClose={() => setColorSheet(false)}>
          {(S) => (
            <>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
                <span style={{ fontSize: 17, fontWeight: 700, color: S.text }}>{t("picker.colorTitle")}</span>
                <div style={{ width: 40, height: 40, borderRadius: 11, background: color, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Glyph name={icon} size={18} color={onGlyph} />
                </div>
              </div>
              <PickSection title={t("picker.palette")} colors={palette} color={color} onPick={(c) => { onColor(c); setColorSheet(false); }} S={S} />
              <CustomColor open={colorSheet} color={color} onPick={(c) => { onColor(c); setColorSheet(false); }} S={S} />
              <PickSection title={t("picker.others")} colors={EXT_PALETTE.filter((c) => !palette.includes(c))} color={color} onPick={(c) => { onColor(c); setColorSheet(false); }} S={S} />
            </>
          )}
        </Sheet>,
        document.body,
      )}

      {createPortal(
        <Sheet show={iconSheet} onClose={() => setIconSheet(false)}>
          {(S) => (
            <>
              <div style={{ fontSize: 17, fontWeight: 700, color: S.text, marginBottom: 4 }}>{t("picker.iconTitle")}</div>
              {ICON_CATEGORIES.map((cat) => (
                <div key={cat.label}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: S.soft, margin: "14px 0 8px" }}>{t(cat.label as TKey)}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
                    {cat.icons.map((ic) => {
                      const sel = icon === ic;
                      return (
                        <button key={ic} onClick={() => { onIcon(ic); setIconSheet(false); }} aria-label={ic} style={{ width: 42, height: 42, borderRadius: "50%", background: sel ? color : S.inset, border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
                          <Glyph name={ic} size={19} color={sel ? onGlyph : S.soft} sw={1.5} />
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </>
          )}
        </Sheet>,
        document.body,
      )}
    </>
  );
}

/**
 * Arbitrary color: the system <input type=color> (on iOS a full color wheel
 * with an eyedropper) synced with the hex field; "Use" confirms and closes.
 */
function CustomColor({ open, color, onPick, S }: { open: boolean; color: string; onPick: (c: string) => void; S: { text: string; soft: string; line: string; bg: string } }) {
  const { t } = useT();
  const [hex, setHex] = useState(color);
  useEffect(() => { if (open) setHex(color); }, [open, color]);
  const valid = normHex(hex);
  return (
    <>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: S.soft, margin: "12px 0 8px" }}>{t("picker.custom")}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <div style={{ position: "relative", width: 46, height: 46, borderRadius: 12, overflow: "hidden", border: `1px solid ${S.line}`, background: valid ?? color, flexShrink: 0 }}>
          {/* the native picker covers the tile (opacity 0) — tap opens the system color wheel */}
          <input type="color" value={valid ?? "#4fa583"} onChange={(e) => setHex(e.target.value)} aria-label={t("picker.custom")} style={{ position: "absolute", inset: -6, width: "calc(100% + 12px)", height: "calc(100% + 12px)", opacity: 0, cursor: "pointer" }} />
        </div>
        <input
          value={hex}
          onChange={(e) => setHex(e.target.value)}
          placeholder="#4fa583"
          inputMode="text"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          style={{ flex: 1, minWidth: 0, padding: "11px 12px", borderRadius: 10, border: `1px solid ${valid || !hex.trim() ? S.line : "var(--danger)"}`, background: S.bg, color: S.text, fontSize: 14, fontFamily: font, outline: "none", fontVariantNumeric: "tabular-nums" }}
        />
        <button onClick={() => valid && onPick(valid)} disabled={!valid} style={{ padding: "11px 18px", borderRadius: 10, border: "none", background: "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", opacity: valid ? 1 : 0.4, flexShrink: 0 }}>
          {t("picker.use")}
        </button>
      </div>
    </>
  );
}

/** Color-sheet section: title + a grid of square swatches with ✓ on the selected one. */
function PickSection({ title, colors, color, onPick, S }: { title: string; colors: readonly string[]; color: string; onPick: (c: string) => void; S: { text: string; soft: string } }) {
  if (colors.length === 0) return null;
  return (
    <>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: S.soft, margin: "12px 0 8px" }}>{title}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 10, marginBottom: 6 }}>
        {colors.map((c) => {
          const sel = color === c;
          return (
            <button key={c} onClick={() => onPick(c)} aria-label={c} style={{ aspectRatio: "1", width: "100%", borderRadius: 12, background: c, border: sel ? `2.5px solid ${S.text}` : "1px solid rgba(0,0,0,0.12)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
              {sel && <Ico d="M5 13l4 4L19 7" size={16} color={isLight(c) ? "#33312c" : "#fff"} sw={2.4} />}
            </button>
          );
        })}
      </div>
    </>
  );
}
