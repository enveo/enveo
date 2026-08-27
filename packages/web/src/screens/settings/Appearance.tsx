import { type ReactNode, useState } from "react";
import { EditWidgetsSheet } from "../../components/EditWidgetsSheet";
import { useStateQuery } from "../../lib/api";
import { useCurrency, useSettings, useTheme } from "../../lib/contexts";
import { SUPPORTED_CURRENCIES } from "../../lib/currency";
import { todayISO } from "../../lib/dates";
import { type Lang, LOCALES, loadLocale, type Message, msg, useT } from "../../lib/i18n";
import { local } from "../../lib/mutate";
import { store } from "../../lib/store";
import { font, TEAL, themeTokens } from "../../lib/theme";
import { ActionGroup, ActionRow, Helper, Row, Seg } from "./ui";

/** Where a translator reports a bad string. Community locales are labelled, not hidden — honest, and
 *  it is the only route a reader of a wrong sentence has back to us. */
/** The dedicated translation-fix issue form (.github/ISSUE_TEMPLATE/translation_fix.yml), not the
 *  generic issue list: it asks for locale / source message / current / proposed / context and
 *  warns against pasting financial data, which a blank issue does not. */
const TRANSLATION_ISSUES_URL = "https://github.com/enveo/enveo/issues/new?template=translation_fix.yml";

/** Order of theme tiles in Settings, and the name of each (the ids are historical).
 *  Reduced to two tiles (redesign 06) — "koral"/"atrament" are unreachable from the
 *  picker now (contexts.tsx normalizes any stored value to "teal") but the AccentTheme
 *  type and THEMES entries stay so settings persisted by older devices remain parseable. */
const THEME_IDS: Array<"teal" | "duet"> = ["teal", "duet"];
const THEME_LABEL: Record<"teal" | "duet", Message> = {
  teal: msg("Cisza"),
  duet: msg("Duet"),
};

/**
 * Color theme picker tiles (v3:697-706 `skinTiles`): the CARD is white/`C.card` on both swatches —
 * the theme only shows through the small preview strip (bg + accent dot, duet's dot is its CTA
 * coral) and the label underneath, never as a tint on the whole card. Selection is an accent
 * border plus a matching 1px ring, not a filled background (owner ruling round 1, item 11).
 */
function ThemeTiles() {
  const C = useTheme();
  const { settings, setSettings } = useSettings();
  const { t } = useT();
  const isDark =
    settings.themeMode === "auto" ? typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches : settings.themeMode === "dark";
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, padding: "14px 0", borderBottom: `1px solid ${C.line}` }}>
      {THEME_IDS.map((id) => {
        const tk = themeTokens(id, isDark);
        const accent = tk.vars["--accent"];
        const dot = id === "duet" ? tk.vars["--cta"] : accent;
        // Themes with a band header (duet) preview their band color, not the plain surface —
        // otherwise duet's light-mode bg (cream) reads near-identical to koral's.
        const previewBg = tk.palette.headerStyle === "band" ? tk.palette.headerBg : tk.palette.bg;
        const active = settings.accentTheme === id;
        return (
          <button
            key={id}
            onClick={() => setSettings({ ...settings, accentTheme: id })}
            aria-pressed={active}
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              padding: 10,
              borderRadius: 12,
              cursor: "pointer",
              background: C.card,
              border: `1.5px solid ${active ? accent : C.line}`,
              boxShadow: active ? `0 0 0 1px ${accent}` : "none",
            }}
          >
            <div
              style={{
                height: 44,
                borderRadius: 8,
                background: previewBg,
                border: `1px solid ${C.line}`,
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
                padding: "0 9px",
              }}
            >
              <div style={{ width: 9, height: 9, borderRadius: "50%", background: dot }} />
            </div>
            <span style={{ textAlign: "center", fontSize: 12, fontWeight: 650, color: C.text }}>{t(THEME_LABEL[id])}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Section-level description under an Appearance eyebrow (v3:696/814/830: 12px, `T.soft`,
 *  line-height 1.5) — distinct from `Helper`'s smaller 11px/`mute` field-caption role, which the
 *  design uses for captions nested under a single row (e.g. the discreet-mode sub-line below). */
function SectionDesc({ children }: { children: ReactNode }) {
  const C = useTheme();
  return <div style={{ fontSize: 12, color: C.soft, lineHeight: 1.5, marginTop: 8 }}>{children}</div>;
}

/** Appearance-pane section eyebrow (v3:695/720/733: 9.5px/750/0.16em) — a LOCAL override, not a
 *  restyle of the shared `Eyebrow`. `Eyebrow` is used by every other Settings section (Ai/DataTools/
 *  DataSection/SyncSection) on both phone and wide; this pane's owner-mandated redesign (round 1,
 *  item 11) covers only Appearance, so it must not silently reskin those other sections' headers,
 *  which have no such ruling yet. Same pattern as `SectionDesc` above vs. `Helper`. */
function AppearanceEyebrow({ children }: { children: ReactNode }) {
  const C = useTheme();
  return <div style={{ fontSize: 9.5, fontWeight: 750, color: C.mute, textTransform: "uppercase", letterSpacing: "0.16em", marginBottom: 8 }}>{children}</div>;
}

/** Selectable currencies (ISO 4217) — display only, no amount conversion. Shared with onboarding. */
const CURRENCIES = SUPPORTED_CURRENCIES;

/**
 * A native `<select>` styled as the design's pill — "{value} ⌄" (v3:716-723) — on BOTH phone and
 * wide (`WideSettings` renders this SAME component; design parity wave E task 3's own direction:
 * "keep the native `<select>` semantics but style it as the design pill"). `appearance: none`
 * (+ vendor prefixes for older WebKit) hides the OS chrome; the ⌄ is a decorative overlay
 * (`pointerEvents: none`) so every click still lands on the real `<select>` underneath it —
 * keyboard nav, screen readers and `onChange` are all untouched.
 */
function PillSelect({ children }: { children: ReactNode }) {
  const C = useTheme();
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      {children}
      <span
        aria-hidden
        style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", fontSize: 10, color: C.text }}
      >
        ⌄
      </span>
    </span>
  );
}

/** Appearance: color themes, light/dark mode, language, currency, discreet mode. */
export function AppearanceSection() {
  const C = useTheme();
  const { settings, setSettings } = useSettings();
  const { t } = useT();
  const currency = useCurrency();
  const [widgetsOpen, setWidgetsOpen] = useState(false);
  const { data: currentState } = useStateQuery(todayISO().slice(0, 7));
  // guard: without a booted replica / a budgets entity there is nothing to update
  const budgetId = store.getLedger()?.budgets?.[0]?.id;
  // Design parity wave E task 3 (v3:716-723): radius 9 and the border/background/font-size were
  // already correct — padding grows to 7px 30px (room for the `PillSelect` ⌄ overlay) 7px 14px,
  // weight to 650, and the native chrome is hidden (`appearance: none` + prefixes) since the
  // control now draws its own ⌄.
  const selectStyle = {
    appearance: "none",
    WebkitAppearance: "none",
    MozAppearance: "none",
    padding: "7px 30px 7px 14px",
    minHeight: 30,
    borderRadius: 9,
    border: `1px solid ${C.line}`,
    background: C.bg,
    color: C.text,
    fontSize: 12.5,
    fontWeight: 650,
    fontFamily: font,
    cursor: "pointer",
  } as const;
  const community = LOCALES.find((l) => l.code === settings.lang)?.community;

  return (
    <div style={{ marginTop: 4 }}>
      <AppearanceEyebrow>{t("Account preferences")}</AppearanceEyebrow>
      <SectionDesc>{t("Theme and language follow your account on every device.")}</SectionDesc>
      <ThemeTiles />
      <Row label={t("Theme")}>
        <Seg
          value={settings.themeMode}
          onChange={(id) => setSettings({ ...settings, themeMode: id })}
          options={[
            { id: "light", label: t("Light") },
            { id: "dark", label: t("Dark") },
            { id: "auto", label: t("Auto") },
          ]}
        />
      </Row>
      <Row label={t("Language")}>
        <PillSelect>
          {/* Rendered FROM the registry: adding a locale must never mean remembering to edit a picker. */}
          <select
            value={settings.lang}
            /* the locale chunk is fetched BEFORE the switch — otherwise the UI flashes English */
            onChange={(e) => {
              const id = e.target.value as Lang;
              void loadLocale(id).then(() => setSettings({ ...settings, lang: id }));
            }}
            style={selectStyle}
          >
            {LOCALES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.endonym}
              </option>
            ))}
          </select>
        </PillSelect>
      </Row>
      {community && (
        <Helper>
          {t("Community translation — it may be incomplete.")}{" "}
          <a href={TRANSLATION_ISSUES_URL} target="_blank" rel="noreferrer" style={{ color: TEAL, fontWeight: 600 }}>
            {t("Report a fix")}
          </a>
        </Helper>
      )}
      <div style={{ marginTop: 18 }}>
        <AppearanceEyebrow>{t("Budget preferences")}</AppearanceEyebrow>
        <SectionDesc>{t("Currency and dashboard widgets follow this budget on every device.")}</SectionDesc>
      </div>
      <Row label={t("Currency")}>
        <PillSelect>
          <select
            value={currency}
            disabled={!budgetId}
            onChange={(e) => {
              if (budgetId) local.updateBudget(budgetId, e.target.value);
            }}
            // `selectStyle`'s own `cursor: "pointer"` is an inline style — it would otherwise beat
            // the UA stylesheet's `:disabled` cursor, showing a clickable pointer over a control
            // that (absent a budget) cannot actually be changed.
            style={{ ...selectStyle, cursor: budgetId ? "pointer" : "default" }}
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </PillSelect>
      </Row>
      <ActionGroup>
        <ActionRow
          label={t("Edit dashboard widgets")}
          desc={t("Choose their order, visibility, and options.")}
          onClick={() => setWidgetsOpen(true)}
          disabled={!currentState}
          chevron
        />
      </ActionGroup>
      <div style={{ marginTop: 18 }}>
        <AppearanceEyebrow>{t("This device")}</AppearanceEyebrow>
      </div>
      {/* The design nests this row's caption under its own label (v3:735-738) rather than as a
       *  separate section-level line above it — the only Appearance row with a per-row sub-caption. */}
      <Row
        label={
          <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span>{t("Discreet mode")}</span>
            <span style={{ fontSize: 11, fontWeight: 400, color: C.mute }}>{t("Hides amounts; stays on this device only.")}</span>
          </span>
        }
      >
        <button
          onClick={() => setSettings({ ...settings, discreet: !settings.discreet })}
          style={{
            width: 44,
            height: 25,
            borderRadius: 13,
            background: settings.discreet ? TEAL : C.line,
            position: "relative",
            border: "none",
            cursor: "pointer",
            transition: "background .2s",
          }}
        >
          <div
            style={{
              width: 21,
              height: 21,
              borderRadius: "50%",
              background: "#fff",
              position: "absolute",
              top: 2,
              left: settings.discreet ? 21 : 2,
              transition: "left .2s",
              boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
            }}
          />
        </button>
      </Row>
      {currentState && <EditWidgetsSheet show={widgetsOpen} state={currentState} onClose={() => setWidgetsOpen(false)} />}
    </div>
  );
}
