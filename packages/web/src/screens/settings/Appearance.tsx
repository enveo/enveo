import { useCurrency, useSettings, useTheme } from "../../lib/contexts";
import { SUPPORTED_CURRENCIES } from "../../lib/currency";
import { useT } from "../../lib/i18n";
import { local } from "../../lib/mutate";
import { store } from "../../lib/store";
import { font, TEAL, THEMES, type AccentTheme } from "../../lib/theme";
import { Row, Seg } from "./ui";

/** Order of theme tiles in Settings. */
const THEME_IDS: AccentTheme[] = ["teal", "koral", "atrament", "duet"];

/** Color theme picker tiles: an 18px circle in the theme accent (duet = two half-circles), name, accent border on the selected one. */
function ThemeTiles() {
  const C = useTheme();
  const { settings, setSettings } = useSettings();
  const { t } = useT();
  const isDark = settings.themeMode === "auto"
    ? typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
    : settings.themeMode === "dark";
  return (
    <div style={{ display: "flex", gap: 8, padding: "14px 0", borderBottom: `1px solid ${C.line}` }}>
      {THEME_IDS.map((id) => {
        const def = THEMES[id];
        const accent = isDark ? def.accentDark : def.accent;
        const cta = (isDark ? def.ctaDark : def.cta) ?? accent;
        const active = settings.accentTheme === id;
        return (
          <button
            key={id}
            onClick={() => setSettings({ ...settings, accentTheme: id })}
            aria-pressed={active}
            style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "10px 4px", borderRadius: 10, cursor: "pointer", background: C.bg, border: `2px solid ${active ? accent : C.line}` }}
          >
            {id === "duet" ? (
              <svg width={18} height={18} viewBox="0 0 18 18" aria-hidden>
                <path d="M9 0a9 9 0 0 0 0 18Z" fill={accent} />
                <path d="M9 0a9 9 0 0 1 0 18Z" fill={cta} />
              </svg>
            ) : (
              <div style={{ width: 18, height: 18, borderRadius: "50%", background: accent }} />
            )}
            <span style={{ fontSize: 11, fontWeight: 600, color: active ? C.text : C.soft }}>{t(`theme.${id}`)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Selectable currencies (ISO 4217) — display only, no amount conversion. Shared with onboarding. */
const CURRENCIES = SUPPORTED_CURRENCIES;

/** Appearance: color themes, light/dark mode, language, currency, discreet mode. */
export function AppearanceSection() {
  const C = useTheme();
  const { settings, setSettings } = useSettings();
  const { t } = useT();
  const currency = useCurrency();
  // guard: without a booted replica / a budgets entity there is nothing to update
  const budgetId = store.getLedger()?.budgets?.[0]?.id;

  return (
    <div style={{ marginTop: 4 }}>
      <ThemeTiles />
      <Row label={t("settings.theme")}>
        <Seg
          value={settings.themeMode}
          onChange={(id) => setSettings({ ...settings, themeMode: id })}
          options={[
            { id: "light", label: t("settings.themeLight") },
            { id: "dark", label: t("settings.themeDark") },
            { id: "auto", label: t("settings.themeAuto") },
          ]}
        />
      </Row>
      <Row label={t("settings.language")}>
        <Seg
          value={settings.lang}
          onChange={(id) => setSettings({ ...settings, lang: id })}
          options={[
            { id: "pl", label: "PL" },
            { id: "en", label: "EN" },
          ]}
        />
      </Row>
      <Row label={t("settings.currency")}>
        <select
          value={currency}
          disabled={!budgetId}
          onChange={(e) => {
            if (budgetId) local.updateBudget(budgetId, e.target.value);
          }}
          style={{ padding: "7px 10px", borderRadius: 9, border: `1px solid ${C.line}`, background: C.bg, color: C.text, fontSize: 12.5, fontWeight: 600, fontFamily: font, outline: "none" }}
        >
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </Row>
      <Row label={t("settings.discreet")}>
        <button onClick={() => setSettings({ ...settings, discreet: !settings.discreet })} style={{ width: 44, height: 25, borderRadius: 13, background: settings.discreet ? TEAL : C.line, position: "relative", border: "none", cursor: "pointer", transition: "background .2s" }}>
          <div style={{ width: 21, height: 21, borderRadius: "50%", background: "#fff", position: "absolute", top: 2, left: settings.discreet ? 21 : 2, transition: "left .2s", boxShadow: "0 1px 2px rgba(0,0,0,0.2)" }} />
        </button>
      </Row>
    </div>
  );
}
