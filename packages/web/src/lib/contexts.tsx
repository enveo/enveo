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
export type OpenAiModel = "gpt-5.5" | "gpt-5.5-mini";

 
export type WidgetId = "quickActions" | "accounts" | "envelopes" | "envelopesSavings" | "reportCashflow" | "reportNetWorth";
export interface WidgetOpts {
   
  collapsed?: boolean;
  count?: number;
   
  picked?: string[];
   
  mode?: string;
   
  actions?: string[];
}
export interface WidgetConfig {
  id: WidgetId;
  enabled: boolean;
  opts?: WidgetOpts;
}

export interface Settings {
  themeMode: ThemeMode;
   
  accentTheme: AccentTheme;
  discreet: boolean;
  lang: Lang;
  /** AI mode (a DEVICE setting — never synchronized). */
  aiMode: AiMode;
  /** OpenAI key (byok) — this browser's localStorage ONLY, and never persisted in guest mode. */
  openaiKey: string;
  openaiModel: OpenAiModel;
   
  customProfiles: Array<{ id: string; name: string; prompt: string }>;
   
  startWidgets: WidgetConfig[];
}





const defaultStartWidgets = (): WidgetConfig[] => [
  { id: "quickActions", enabled: true, opts: { actions: ["expense", "transfer", "import", "suggest"] } },
  { id: "accounts", enabled: true, opts: { collapsed: true, count: 4 } },
  { id: "envelopes", enabled: true, opts: { mode: "all" } },
   
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
  openaiModel: "gpt-5.5-mini",
  customProfiles: [],
  startWidgets: defaultStartWidgets(),
};

function loadSettings(): Settings {
  const raw = loadPersistedSettings();  
  const s = raw ? { ...DEFAULT_SETTINGS, ...raw } : { ...DEFAULT_SETTINGS };
  


  if (s.accentTheme === "koral" || s.accentTheme === "atrament") s.accentTheme = "teal";
   
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
    persistSettings(s);  
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
