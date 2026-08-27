import {
  type AccentTheme,
  type AccountPreferencesPatch,
  type BudgetPreferencesPatch,
  createDefaultBudgetPreferences,
  OPENAI_MODELS,
  type OpenAiModel,
  type ThemeMode,
  type WidgetConfig,
  type WidgetId,
  type WidgetOpts,
} from "@enveo/shared";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { accountPreferences } from "./accountPreferences";
import { budgetPreferences } from "./budgetPreferences";
import { browserLocales, currencyForLocales } from "./currency";
import { type DevicePreferencesPatch, devicePreferences } from "./devicePreferences";
import { compactMoney, formatMoney } from "./format";
// the REGISTRY, not lib/i18n: that one reads useSettings() from here — importing it would close the cycle
import { detectLang, type Lang } from "./i18n/registry";
import { startupPresentation } from "./startupSplash";
import { store } from "./store";
import { light, type Theme, themeTokens } from "./theme";

export type AiMode = "off" | "server" | "byok";
/** BYOK model registry. `gpt-5.6-luna` is the default for FRESH settings only — a persisted
 *  legacy choice (`gpt-5.5`/`gpt-5.5-mini`) survives loadSettings' merge and stays selectable.
 *  Since §1b the pickers render quality/cost TIERS (lib/aiModelTiers.ts) over the GPT-5.6
 *  family; this union stays the authority on what may be PERSISTED in settings. */
export const DEFAULT_OPENAI_MODEL: OpenAiModel = "gpt-5.6-luna";
export type { OpenAiModel, ThemeMode, WidgetConfig, WidgetId, WidgetOpts };
export { OPENAI_MODELS };

export interface Settings {
  themeMode: ThemeMode;
  /** Account-scoped color theme, synchronized by the preference resource. */
  accentTheme: AccentTheme;
  discreet: boolean;
  lang: Lang;
  /** Compatibility view over the budget-scoped AI provider. */
  aiMode: AiMode;
  openaiModel: OpenAiModel;
  /** Budget-scoped custom "Suggest" profiles. */
  customProfiles: Array<{ id: string; name: string; prompt: string }>;
  /** Budget-scoped start screen widget stack. */
  startWidgets: WidgetConfig[];
}

/** Which of the two overridable fields is currently shadowed by a per-device override — i.e.
 *  whether `devicePreferences.themeModeOverride`/`accentThemeOverride` is non-null right now.
 *  `splitSettingsPatch` needs this to decide WHERE a change goes: a change made while overridden
 *  must keep updating the override (or it would silently vanish, since the effective value is
 *  `override ?? account` and the override would keep winning) — this is what lets the SAME
 *  `setSettings` call site work for both the Appearance pane's own controls and the header's
 *  quick dark-mode toggle without either needing to know about overrides itself. */
export interface DeviceOverrideActive {
  themeMode: boolean;
  accentTheme: boolean;
}

export function splitSettingsPatch(
  previous: Settings,
  next: Settings,
  deviceOverrides: DeviceOverrideActive,
): {
  account: AccountPreferencesPatch;
  budget: BudgetPreferencesPatch;
  device: DevicePreferencesPatch;
} {
  const account: AccountPreferencesPatch = {};
  const device: DevicePreferencesPatch = {};
  if (next.lang !== previous.lang) account.lang = next.lang;
  if (next.themeMode !== previous.themeMode) {
    if (deviceOverrides.themeMode) device.themeModeOverride = next.themeMode;
    else account.themeMode = next.themeMode;
  }
  if (next.accentTheme !== previous.accentTheme) {
    if (deviceOverrides.accentTheme) device.accentThemeOverride = next.accentTheme;
    else account.accentTheme = next.accentTheme;
  }

  const budget: BudgetPreferencesPatch = {};
  if (next.aiMode !== previous.aiMode) budget.aiProvider = next.aiMode === "server" ? "enveo" : next.aiMode === "byok" ? "openai" : "rules";
  if (next.openaiModel !== previous.openaiModel) budget.openaiModel = next.openaiModel;
  if (next.customProfiles !== previous.customProfiles) budget.customProfiles = next.customProfiles;
  if (next.startWidgets !== previous.startWidgets) budget.startWidgets = next.startWidgets;

  if (next.discreet !== previous.discreet) device.discreet = next.discreet;
  return { account, budget, device };
}

/** The one place `themeMode`/`accentTheme` are resolved from account + device — every consumer of
 *  `useSettings()` sees the already-resolved value, so a wide-rail card, a report axis or the
 *  header's dark-mode toggle need no override-awareness of their own. */
export function effectiveThemeMode(account: ThemeMode, deviceOverride: ThemeMode | null): ThemeMode {
  return deviceOverride ?? account;
}

export function effectiveAccentTheme(account: AccentTheme, deviceOverride: AccentTheme | null): AccentTheme {
  return deviceOverride ?? account;
}

/** Order mirrors the "Edit widgets" sheet and the board mockup; reportNetWorth ships OFF
 *  (Cashflow is the more broadly useful default report — most budgets have few/no savings
 *  envelopes yet). A fresh copy every time: callers replace the array wholesale on edit,
 *  but nothing here should ever risk mutating the shared default in place. */
const defaultStartWidgets = (): WidgetConfig[] => createDefaultBudgetPreferences().startWidgets;

const DEFAULT_SETTINGS: Settings = {
  themeMode: "light",
  accentTheme: "teal",
  discreet: false,
  lang: detectLang(),
  aiMode: "off",
  openaiModel: DEFAULT_OPENAI_MODEL,
  customProfiles: [],
  startWidgets: defaultStartWidgets(),
};

const ThemeCtx = createContext<Theme>(light);
const SettingsCtx = createContext<{ settings: Settings; setSettings: (s: Settings) => void }>({
  settings: DEFAULT_SETTINGS,
  setSettings: () => {},
});

export const useTheme = () => useContext(ThemeCtx);
export const useSettings = () => useContext(SettingsCtx);

export function useAccountPreferences() {
  const preferences = useSyncExternalStore(accountPreferences.subscribe, accountPreferences.getSnapshot, accountPreferences.getSnapshot);
  const update = useCallback((patch: AccountPreferencesPatch) => {
    void accountPreferences.update(patch).catch((error) => console.warn("account preference update failed", error));
  }, []);
  return useMemo(() => ({ preferences, update }), [preferences, update]);
}

export function useBudgetPreferences() {
  const preferences = useSyncExternalStore(budgetPreferences.subscribe, budgetPreferences.getSnapshot, budgetPreferences.getSnapshot);
  const update = useCallback((patch: BudgetPreferencesPatch) => budgetPreferences.update(patch), []);
  return useMemo(() => ({ preferences, update }), [preferences, update]);
}

export function useDevicePreferences() {
  const preferences = useSyncExternalStore(devicePreferences.subscribe, devicePreferences.getSnapshot, devicePreferences.getSnapshot);
  const update = useCallback((patch: DevicePreferencesPatch) => {
    void devicePreferences.update(patch).catch((error) => console.warn("device preference update failed", error));
  }, []);
  return useMemo(() => ({ preferences, update }), [preferences, update]);
}

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

/** Masks amounts like `useMask`, in the short form chart axes need. Shares the discreet check —
 *  an axis label or a tooltip that bypassed it would keep displaying the amount discreet mode
 *  exists to hide. */
export function useCompactMask() {
  const { settings } = useSettings();
  const currency = useCurrency();
  return (minor: number) => (settings.discreet ? "••••" : compactMoney(minor, currency, settings.lang));
}

export function AppProviders({ children }: { children: ReactNode }) {
  const { preferences: account, update: updateAccount } = useAccountPreferences();
  const { preferences: budget, update: updateBudget } = useBudgetPreferences();
  const { preferences: device, update: updateDevice } = useDevicePreferences();
  const [prefersDark, setPrefersDark] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const bootStatus = useSyncExternalStore(store.subscribe, store.getBootStatus);

  useEffect(() => {
    void devicePreferences.hydrate();
  }, []);

  const settings: Settings = useMemo(
    () => ({
      themeMode: effectiveThemeMode(account.themeMode, device.themeModeOverride),
      accentTheme: effectiveAccentTheme(account.accentTheme, device.accentThemeOverride),
      lang: account.lang,
      discreet: device.discreet,
      aiMode: budget.aiProvider === "enveo" ? "server" : budget.aiProvider === "openai" ? "byok" : "off",
      openaiModel: budget.openaiModel,
      customProfiles: budget.customProfiles,
      startWidgets: budget.startWidgets,
    }),
    [account, budget, device],
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const fn = (e: MediaQueryListEvent) => setPrefersDark(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);

  const setSettings = (s: Settings) => {
    const patch = splitSettingsPatch(settings, s, {
      themeMode: device.themeModeOverride !== null,
      accentTheme: device.accentThemeOverride !== null,
    });
    if (Object.keys(patch.account).length > 0) updateAccount(patch.account);
    if (Object.keys(patch.budget).length > 0) updateBudget(patch.budget);
    if (Object.keys(patch.device).length > 0) updateDevice(patch.device);
  };

  // <html lang> must follow the UI language (screen-reader pronunciation, hyphenation, :lang()
  // and browser translate prompts). index.html ships lang="en" only as the pre-boot default;
  // this is the single writer once React is up — on mount (init/reload) and on every switch.
  useEffect(() => {
    document.documentElement.lang = settings.lang;
  }, [settings.lang]);

  const isDark = settings.themeMode === "auto" ? prefersDark : settings.themeMode === "dark";
  const { vars, palette: theme } = useMemo(() => themeTokens(settings.accentTheme, isDark), [settings.accentTheme, isDark]);

  useLayoutEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (startupPresentation(bootStatus) === "splash") {
      document.documentElement.style.background = "#1d2a47";
      if (meta) meta.setAttribute("content", "#1d2a47");
      return;
    }
    for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
    document.documentElement.style.background = theme.bg;
    if (meta) meta.setAttribute("content", isDark ? theme.surface : theme.bg);
  }, [bootStatus, vars, theme, isDark]);

  const ctx = useMemo(() => ({ settings, setSettings }), [settings]);

  return (
    <ThemeCtx.Provider value={theme}>
      <SettingsCtx.Provider value={ctx}>{children}</SettingsCtx.Provider>
    </ThemeCtx.Provider>
  );
}
