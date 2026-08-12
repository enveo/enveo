import { createContext, type ReactNode, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { browserLocales, currencyForLocales } from "./currency";
import { formatMoney } from "./format";
// the REGISTRY, not lib/i18n: that one reads useSettings() from here — importing it would close the cycle
import { detectLang, type Lang } from "./i18n/registry";
import { loadPersistedSettings, persistSettings } from "./settingsPersist";
import { store } from "./store";
import { type AccentTheme, light, type Theme, themeTokens } from "./theme";

export type ThemeMode = "light" | "dark" | "auto";
export type AiMode = "off" | "server" | "byok";
/** BYOK model registry. `gpt-5.6-luna` is the default for FRESH settings only — a persisted
 *  legacy choice (`gpt-5.5`/`gpt-5.5-mini`) survives loadSettings' merge and stays selectable.
 *  Since §1b the pickers render quality/cost TIERS (lib/aiModelTiers.ts) over the GPT-5.6
 *  family; this union stays the authority on what may be PERSISTED in settings. */
export type OpenAiModel = "gpt-5.6-luna" | "gpt-5.6-terra" | "gpt-5.6-sol" | "gpt-5.5" | "gpt-5.5-mini";
export const OPENAI_MODELS: readonly OpenAiModel[] = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.5", "gpt-5.5-mini"];
export const DEFAULT_OPENAI_MODEL: OpenAiModel = "gpt-5.6-luna";

/** Start-screen widget stack (per DEVICE — like themeMode, no synchronization). */
export type WidgetId = "quickActions" | "accounts" | "envelopes" | "envelopesSavings" | "reportCashflow" | "reportNetWorth";
export interface WidgetOpts {
  /** accounts: start folded to `count` (default 4) with a "show all" toggle. */
  collapsed?: boolean;
  count?: number;
  /** accounts: when defined (even empty), only these account ids show — mirrors envelopes' `picked:` mode. */
  picked?: string[];
  /** envelopes: "all" | "savings" | `group:${groupId}` | `picked:${id,id,...}`. */
  mode?: string;
  /** quickActions: chosen action keys in display order, from the fixed pool (see widgets.tsx QUICK_ACTION_DEFS). */
  actions?: string[];
}
export interface WidgetConfig {
  id: WidgetId;
  enabled: boolean;
  opts?: WidgetOpts;
}

export interface Settings {
  themeMode: ThemeMode;
  /** Color theme (per device, like themeMode). */
  accentTheme: AccentTheme;
  discreet: boolean;
  lang: Lang;
  /** AI mode (a DEVICE setting — never synchronized). */
  aiMode: AiMode;
  /** OpenAI key (byok) — this browser's localStorage ONLY, and never persisted in guest mode. */
  openaiKey: string;
  openaiModel: OpenAiModel;
  /** Custom "Suggest" profiles (per DEVICE — no synchronization, MVP). */
  customProfiles: Array<{ id: string; name: string; prompt: string }>;
  /** Start screen widget stack — order, enablement, per-widget options (per DEVICE). */
  startWidgets: WidgetConfig[];
}

/** Order mirrors the "Edit widgets" sheet and the board mockup; reportNetWorth ships OFF
 *  (Cashflow is the more broadly useful default report — most budgets have few/no savings
 *  envelopes yet). A fresh copy every time: callers replace the array wholesale on edit,
 *  but nothing here should ever risk mutating the shared default in place. */
const defaultStartWidgets = (): WidgetConfig[] => [
  { id: "quickActions", enabled: true, opts: { actions: ["expense", "transfer", "import", "suggest"] } },
  { id: "accounts", enabled: true, opts: { collapsed: true, count: 4 } },
  { id: "envelopes", enabled: true, opts: { mode: "all" } },
  // opt-in: lets a user run "envelopes" as everyday-only elsewhere while still surfacing savings here.
  { id: "envelopesSavings", enabled: false },
  { id: "reportCashflow", enabled: true },
  { id: "reportNetWorth", enabled: false },
];

const DEFAULT_SETTINGS: Settings = {
  themeMode: "light",
  accentTheme: "teal",
  discreet: false,
  lang: detectLang(),
  aiMode: "off",
  openaiKey: "",
  openaiModel: DEFAULT_OPENAI_MODEL,
  customProfiles: [],
  startWidgets: defaultStartWidgets(),
};

function loadSettings(): Settings {
  const raw = loadPersistedSettings(); // null in guest mode — a guest inherits nothing
  const s = raw ? { ...DEFAULT_SETTINGS, ...raw } : { ...DEFAULT_SETTINGS };
  // The theme picker was reduced to two tiles (Cisza/Duet) — a device that still has the
  // retired "koral"/"atrament" tile selected (pre-redesign-06) normalizes to the new default.
  // The AccentTheme type and THEMES entries stay so this remains parseable either way.
  if (s.accentTheme === "koral" || s.accentTheme === "atrament") s.accentTheme = "teal";
  // Migration for devices from before the widget stack existed (or a corrupted/empty array).
  if (!Array.isArray(s.startWidgets) || s.startWidgets.length === 0) {
    s.startWidgets = defaultStartWidgets();
  } else {
    // Reconcile an already-persisted stack against the current defaults: a widget added in a
    // later release (e.g. envelopesSavings) must still reach upgrading devices — appended in
    // default order, disabled/opts as shipped — while preserving the user's existing order and
    // per-widget enabled/opts. Also drops any entry whose id is no longer known (forward-safety
    // against a downgrade or a corrupted persist).
    const defaults = defaultStartWidgets();
    const known = new Set(defaults.map((w) => w.id));
    const present = new Set(s.startWidgets.map((w) => w.id));
    const missing = defaults.filter((w) => !present.has(w.id));
    s.startWidgets = s.startWidgets.filter((w) => known.has(w.id)).concat(missing);
  }
  return s;
}

const ThemeCtx = createContext<Theme>(light);
const SettingsCtx = createContext<{ settings: Settings; setSettings: (s: Settings) => void }>({
  settings: DEFAULT_SETTINGS,
  setSettings: () => {},
});

export const useTheme = () => useContext(ThemeCtx);
export const useSettings = () => useContext(SettingsCtx);

/**
 * The budget currency from the replica. The fallback (before the replica boots, or on an old
 * replica with no `budgets` entity) follows the BROWSER LOCALE rather than a fixed code — it is a
 * display unit for the boot flash only, so guessing per locale beats showing everyone złoty.
 * Computed once: navigator.language cannot change without a reload (same idiom as detectLang).
 */
const LOCALE_CURRENCY = currencyForLocales(browserLocales());

export function useCurrency(): string {
  useSyncExternalStore(store.subscribe, store.getVersion);
  return store.getLedger()?.budgets?.[0]?.currency ?? LOCALE_CURRENCY;
}

/** Masks amounts; returns the FULL string with a currency symbol per language. */
export function useMask() {
  const { settings } = useSettings();
  const currency = useCurrency();
  return (minor: number) => (settings.discreet ? "••••" : formatMoney(minor, currency, settings.lang));
}

export function AppProviders({ children }: { children: ReactNode }) {
  const [settings, setSettingsState] = useState<Settings>(loadSettings);
  const [prefersDark, setPrefersDark] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const fn = (e: MediaQueryListEvent) => setPrefersDark(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);

  const setSettings = (s: Settings) => {
    setSettingsState(s);
    persistSettings(s); // no-op in guest mode — settings live in React state only
  };

  // <html lang> must follow the UI language (screen-reader pronunciation, hyphenation, :lang()
  // and browser translate prompts). index.html ships lang="en" only as the pre-boot default;
  // this is the single writer once React is up — on mount (init/reload) and on every switch.
  useEffect(() => {
    document.documentElement.lang = settings.lang;
  }, [settings.lang]);

  const isDark = settings.themeMode === "auto" ? prefersDark : settings.themeMode === "dark";
  const { vars, palette: theme } = useMemo(() => themeTokens(settings.accentTheme, isDark), [settings.accentTheme, isDark]);

  useEffect(() => {
    for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
    document.documentElement.style.background = theme.bg;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", isDark ? theme.surface : theme.bg);
  }, [vars, theme, isDark]);

  const ctx = useMemo(() => ({ settings, setSettings }), [settings]);

  return (
    <ThemeCtx.Provider value={theme}>
      <SettingsCtx.Provider value={ctx}>{children}</SettingsCtx.Provider>
    </ThemeCtx.Provider>
  );
}
