import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { formatMoney } from "./format";
import { store } from "./store";
import { light, themeTokens, type AccentTheme, type Theme } from "./theme";

export type ThemeMode = "light" | "dark" | "auto";
export type AiMode = "off" | "server" | "byok";
export type OpenAiModel = "gpt-5.5" | "gpt-5.5-mini";
export interface Settings {
  themeMode: ThemeMode;
  /** Color theme (per device, like themeMode). */
  accentTheme: AccentTheme;
  discreet: boolean;
  lang: "pl" | "en";
  /** AI mode (a DEVICE setting — never synchronized). */
  aiMode: AiMode;
  /** OpenAI key (byok) — lives EXCLUSIVELY in this browser's localStorage. */
  openaiKey: string;
  openaiModel: OpenAiModel;
  /** Dismissed subscription proposals (group keys) — deliberately per DEVICE. */
  subsDismissed: string[];
  /** Custom "Suggest" profiles (per DEVICE — no synchronization, MVP). */
  customProfiles: Array<{ id: string; name: string; prompt: string }>;
}

/** Default language from the browser (no i18n import — avoids a cycle). */
const detectLang = (): "pl" | "en" =>
  typeof navigator !== "undefined" && (navigator.language || "").toLowerCase().startsWith("pl") ? "pl" : "en";

const DEFAULT_SETTINGS: Settings = {
  themeMode: "light",
  accentTheme: "koral",
  discreet: false,
  lang: detectLang(),
  aiMode: "off",
  openaiKey: "",
  openaiModel: "gpt-5.5-mini",
  subsDismissed: [],
  customProfiles: [],
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem("enveo.settings");
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return DEFAULT_SETTINGS;
}

const ThemeCtx = createContext<Theme>(light);
const SettingsCtx = createContext<{ settings: Settings; setSettings: (s: Settings) => void }>({
  settings: DEFAULT_SETTINGS,
  setSettings: () => {},
});

export const useTheme = () => useContext(ThemeCtx);
export const useSettings = () => useContext(SettingsCtx);

/** Subscription proposal dismissals (per device — localStorage settings). */
export function useSubsDismissed() {
  const { settings, setSettings } = useContext(SettingsCtx);
  const dismiss = (key: string) => {
    if (settings.subsDismissed.includes(key)) return;
    setSettings({ ...settings, subsDismissed: [...settings.subsDismissed, key] });
  };
  const isDismissed = (key: string) => settings.subsDismissed.includes(key);
  return { dismissed: settings.subsDismissed, dismiss, isDismissed };
}

/** The budget currency from the replica (PLN fallback before boot/on old replicas). */
export function useCurrency(): string {
  useSyncExternalStore(store.subscribe, store.getVersion);
  return store.getLedger()?.budgets?.[0]?.currency ?? "PLN";
}

/** Masks amounts; returns the FULL string with a currency symbol per language. */
export function useMask() {
  const { settings } = useSettings();
  const currency = useCurrency();
  return (minor: number) => (settings.discreet ? "••••" : formatMoney(minor, currency, settings.lang));
}

export function AppProviders({ children }: { children: ReactNode }) {
  const [settings, setSettingsState] = useState<Settings>(loadSettings);
  const [prefersDark, setPrefersDark] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const fn = (e: MediaQueryListEvent) => setPrefersDark(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);

  const setSettings = (s: Settings) => {
    setSettingsState(s);
    try {
      localStorage.setItem("enveo.settings", JSON.stringify(s));
    } catch {
      /* ignore */
    }
  };

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
