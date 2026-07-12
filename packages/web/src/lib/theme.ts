/**
 * Color themes + palettes. Accent/danger/CTA live as CSS variables set by
 * ThemeProvider (themeTokens) — the TEAL/CORAL constants keep their NAMES (21
 * importing files unchanged) but point to var(). The "teal" theme id stays for
 * settings compatibility, but since 1.15.0 the palette is "Sage" (#4fa583).
 */
export const TEAL = "var(--accent)";
export const CORAL = "var(--danger)";
export const CTA = "var(--cta)";
export const INCOME = "#67b86c";
export const TRANSFER = "#4a86c4";
export const SAGE_BG = "#b1c98d";
export const SAGE_TX = "#3c5526";
 
export const font = `-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif`;
export const P = 14;

export const light = {
  bg: "#f4f3ef",
  surface: "#ffffff",
  card: "#ffffff",
  line: "#ece9e2",
  inset: "#eceae3",
  band: "#eae8e0",
  text: "#2b2a27",
  soft: "#6f6e67",
  mute: "#a6a59c",
  sheet: "#ffffff",
  key: "#ffffff",
  keybg: "#e9e7e1",
};
export const dark = {
  bg: "#3b414b",
  surface: "#404650",
  card: "#404650",
  line: "#4b515b",
  inset: "#333944",
  band: "#343a44",
  text: "#eef0f2",
  soft: "#a8aeb6",
  mute: "#7f868f",
  sheet: "#434a54",
  key: "#454b55",
  keybg: "#2f343d",
};

export type Theme = typeof light;

export const ENV_PALETTE = [
  "#f3c45f", "#7ca968", "#cc4a4a", "#3a3a52", "#4a5a5e", "#8f84a8",
  "#f1dca0", "#ccd9b6", "#f0c84f", "#aed6ea", "#f0a8c4", "#a8dce0",
];

export const ACCOUNT_COLORS = [
  "#4f86bd", "#7ca968", "#cc4a4a", "#a86b40", "#3a3a52", "#d4506e", "#54c6bd",
];






export const EXT_PALETTE = [
  "#f6d365", "#f0c84f", "#e8b93e", "#d9a441", "#c98f2e", "#f1dca0",
  "#f2a65a", "#e8853b", "#d96f32", "#b85c38", "#a86b40", "#8a5a33",
  "#e0574f", "#cc4a4a", "#b03a3a", "#ff7e6b", "#f2836b", "#d9776b",
  "#f0a8c4", "#e087a8", "#d4506e", "#b84a72", "#9c3d63", "#f4c2d7",
  "#8f84a8", "#7a6b9e", "#635387", "#4d3f6e", "#b3a8cc", "#d1c9e3",
  "#aed6ea", "#7fb3d4", "#4f86bd", "#3d6a9e", "#2e4f7a", "#1d2a47",
  "#a8dce0", "#6cc5c9", "#54c6bd", "#3fa39b", "#2f7d77", "#4fa583",
  "#ccd9b6", "#a3c48a", "#7ca968", "#5d8a4e", "#456b3a", "#33502b",
  "#e8e4d8", "#c9c2b2", "#9a9284", "#6b655a", "#4a5a5e", "#3a3a52",
];

 

export type AccentTheme = "teal" | "koral" | "atrament" | "duet";

interface NavTokens {
   
  bg: string;
   
  on: string;
   
  mute: string;
   
  ind: string;
}

interface ThemeDef {
   
  accent: string;
  accentDark: string;
  danger: string;
  dangerDark: string;
   
  cta?: string;
  ctaDark?: string;
   
  nav?: NavTokens;
  navDark?: NavTokens;
   
  overrides?: Partial<Theme>;
  overridesDark?: Partial<Theme>;
}

export const THEMES: Record<AccentTheme, ThemeDef> = {
   
  teal: {
    accent: "#4fa583",
    accentDark: "#6cbf9b",
    danger: "#ec6d62",
    dangerDark: "#ec6d62",
  },
  /** A deliberate split of "available" (coral) vs "overspent" (a deepened red). */
  koral: {
    accent: "#f0685c",
    accentDark: "#ff8d7d",
    danger: "#c22e3d",
    dangerDark: "#ef4b58",
  },
  atrament: {
    accent: "#1d2a47",
    accentDark: "#8fa2cc", // navy must lighten in dark mode
    danger: "#ec6d62",
    dangerDark: "#ec6d62",
  },
  duet: {
    accent: "#1d2a47",
    accentDark: "#8fa2cc",
    danger: "#c22e3d",
    dangerDark: "#ef4b58",
    cta: "#f0685c",
    ctaDark: "#ff8d7d",
    nav: { bg: "#1d2a47", on: "#ff8d7d", mute: "#8fa2cc", ind: "#ff8d7d" },
    navDark: { bg: "#1d2a47", on: "#ff8d7d", mute: "#8fa2cc", ind: "#ff8d7d" },
    overridesDark: { bg: "#131b2e", surface: "#1d2a47", card: "#1d2a47", line: "#2b3a5e" },
  },
};





const ALPHA_SUFFIXES = ["14", "18", "1a", "22", "40", "44", "55", "66"] as const;

 
function hexAlpha(hex: string, suffix: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const a = Math.round((parseInt(suffix, 16) / 255) * 1000) / 1000;
  return `rgba(${r},${g},${b},${a})`;
}

/**
 * The full set of theme tokens for a mode: CSS variables (accent/danger/cta/nav +
 * precomputed alphas) plus the mode palette merged with the theme's overrides.
 */
export function themeTokens(t: AccentTheme, isDark: boolean): { vars: Record<string, string>; palette: Theme } {
  const def = THEMES[t];
  const base = isDark ? dark : light;
  const overrides = isDark ? def.overridesDark : def.overrides;
  const palette: Theme = overrides ? { ...base, ...overrides } : base;
  const accent = isDark ? def.accentDark : def.accent;
  const danger = isDark ? def.dangerDark : def.danger;
  const cta = (isDark ? def.ctaDark : def.cta) ?? accent;
  

  const nav = (isDark ? def.navDark : def.nav) ?? { bg: palette.bg, on: palette.text, mute: palette.mute, ind: accent };
  const vars: Record<string, string> = {
    "--accent": accent,
    "--danger": danger,
    "--cta": cta,
    "--nav-bg": nav.bg,
    "--nav-on": nav.on,
    "--nav-mute": nav.mute,
    "--nav-ind": nav.ind,
  };
  for (const s of ALPHA_SUFFIXES) {
    vars[`--accent-${s}`] = hexAlpha(accent, s);
    vars[`--danger-${s}`] = hexAlpha(danger, s);
    vars[`--cta-${s}`] = hexAlpha(cta, s);
  }
  return { vars, palette };
}
