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
/** System stack — yields SF Pro on iOS (native look on the primary platform). */
export const font = `-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif`;
export const P = 14;

export interface Theme {
  bg: string;
  surface: string;
  card: string;
  line: string;
  inset: string;
  band: string;
  text: string;
  soft: string;
  mute: string;
  sheet: string;
  key: string;
  keybg: string;
  /** Positive/confirmation state (income arrows, reconciled check, goal-met). */
  pos: string;
  /** Attention state (>80% of budget, back-dated entry). */
  warn: string;
  /** Negative/overspent state for TEXT (contrast-checked per mode; spec §2). */
  neg: string;
  /** Quiet chip/input surface (allocation pills, icon chips in Settings). */
  chip: string;
  /** Screen header: Cisza paints on the background ("plain"), Duet paints a navy band. */
  headerStyle: "plain" | "band";
  headerBg: string;
  headerInk: string;
  /** Muted/positive/negative TEXT on the header surface (≡ mute/pos/neg on plain themes; duet needs on-navy variants). */
  headerMute: string;
  headerPos: string;
  headerNeg: string;
}

export const light: Theme = {
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
  pos: "#3e7d5c",
  warn: "#c98f2e",
  neg: "#d14b3e",
  chip: "#f1efe9",
  headerStyle: "plain",
  headerBg: "#f4f3ef",
  headerInk: "#2b2a27",
  headerMute: "#a6a59c",
  headerPos: "#3e7d5c",
  headerNeg: "#d14b3e",
};
export const dark: Theme = {
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
  // warn/neg lightened off the C3 contrast audit (dark-mode accent audit backlog note): the
  // originals read AA (≥4.5:1) against `bg` but NOT against the lighter `card`/`surface`/`sheet`
  // that near-limit pills and negative amounts actually sit on in practice (measured 3.96–4.29:1).
  // neg's target has a bit of extra headroom (4.75:1 on card, not just 4.5) — it's also read as
  // TEXT on a `var(--danger-14)`-tinted pill fill (Reports "N over" pill), which composites
  // slightly lighter than flat card and eats into the margin.
  pos: "#7fc9a2",
  warn: "#deb462",
  neg: "#f5a297",
  chip: "#353b45",
  headerStyle: "plain",
  headerBg: "#3b414b",
  headerInk: "#eef0f2",
  headerMute: "#7f868f",
  headerPos: "#7fc9a2",
  headerNeg: "#f5a297",
};

export const ENV_PALETTE = ["#f3c45f", "#7ca968", "#cc4a4a", "#3a3a52", "#4a5a5e", "#8f84a8", "#f1dca0", "#ccd9b6", "#f0c84f", "#aed6ea", "#f0a8c4", "#a8dce0"];

export const ACCOUNT_COLORS = ["#4f86bd", "#7ca968", "#cc4a4a", "#a86b40", "#3a3a52", "#d4506e", "#54c6bd"];

/**
 * Extended picker palette (the "Other" section): 48 colors laid out in rows
 * by hue — yellows → oranges → reds → pinks → purples → blues
 * → teals → greens → neutrals. Enveo's muted aesthetic (no neons).
 */
export const EXT_PALETTE = [
  "#f6d365",
  "#f0c84f",
  "#e8b93e",
  "#d9a441",
  "#c98f2e",
  "#f1dca0",
  "#f2a65a",
  "#e8853b",
  "#d96f32",
  "#b85c38",
  "#a86b40",
  "#8a5a33",
  "#e0574f",
  "#cc4a4a",
  "#b03a3a",
  "#ff7e6b",
  "#f2836b",
  "#d9776b",
  "#f0a8c4",
  "#e087a8",
  "#d4506e",
  "#b84a72",
  "#9c3d63",
  "#f4c2d7",
  "#8f84a8",
  "#7a6b9e",
  "#635387",
  "#4d3f6e",
  "#b3a8cc",
  "#d1c9e3",
  "#aed6ea",
  "#7fb3d4",
  "#4f86bd",
  "#3d6a9e",
  "#2e4f7a",
  "#1d2a47",
  "#a8dce0",
  "#6cc5c9",
  "#54c6bd",
  "#3fa39b",
  "#2f7d77",
  "#4fa583",
  "#ccd9b6",
  "#a3c48a",
  "#7ca968",
  "#5d8a4e",
  "#456b3a",
  "#33502b",
  "#e8e4d8",
  "#c9c2b2",
  "#9a9284",
  "#6b655a",
  "#4a5a5e",
  "#3a3a52",
];

/* ------------------------------- Themes ---------------------------------- */

export type AccentTheme = "teal" | "koral" | "atrament" | "duet";

interface NavTokens {
  /** Navigation bar background. */
  bg: string;
  /** Active icon/label color. */
  on: string;
  /** Inactive icon/label color. */
  mute: string;
  /** Indicator color (the bar under the active tab). */
  ind: string;
}

interface ThemeDef {
  /** Accent in light / dark mode (hex — alphas are computed from it). */
  accent: string;
  accentDark: string;
  danger: string;
  dangerDark: string;
  /** CTA (FAB/primary) — defaults to the mode's accent. */
  cta?: string;
  ctaDark?: string;
  /** Navigation bar — defaults to the mode palette's surface/accent/mute. */
  nav?: NavTokens;
  navDark?: NavTokens;
  /** Mode palette overrides (e.g. duet dark = a navy world). */
  overrides?: Partial<Theme>;
  overridesDark?: Partial<Theme>;
}

export const THEMES: Record<AccentTheme, ThemeDef> = {
  /** Sage — a custom shade (the old teal retired). */
  teal: {
    accent: "#4fa583",
    // C3 contrast audit: #6cbf9b measured 4.33:1 as TEXT on `dark.card`/`surface` (outline
    // chips, "details ›" links, GoalRing) — under the 4.5:1 AA floor. Lightened in place
    // (same hue/saturation, +L only) to 4.6:1+ on card/surface/bg/chip; light mode untouched.
    accentDark: "#77c4a2",
    danger: "#c22e3d",
    dangerDark: "#ef4b58",
    cta: "#f0685c",
    ctaDark: "#ff8d7d",
  },
  /** A deliberate split of "available" (coral) vs "overspent" (a deepened red). */
  koral: {
    accent: "#f0685c",
    // C3 contrast audit: #ff8d7d measured 4.23:1 as TEXT on `dark.card` — under 4.5:1 AA.
    // Lightened to 4.6:1+ (same hue). ctaDark is pinned below so the FAB/primary-button
    // color (spec: "CTA is always coral") does NOT drift with this accent-only bump.
    accentDark: "#ff998a",
    danger: "#c22e3d",
    dangerDark: "#ef4b58",
    ctaDark: "#ff8d7d",
  },
  atrament: {
    accent: "#1d2a47",
    // C3 contrast audit: #8fa2cc (navy, lightened for dark mode) measured only 3.71:1 as TEXT
    // on `dark.card` — well under 4.5:1 AA (the worst of the three Cisza-palette accents,
    // since atrament has no navy-world overridesDark the way duet does). Lightened further
    // (same hue) to 4.6:1+ on card/surface/bg/chip; duet's own #8fa2cc is untouched — it
    // already clears AA there because duet dark paints a darker navy world (bg #131b2e).
    accentDark: "#a5b5d6",
    danger: "#c22e3d",
    dangerDark: "#ef4b58",
    cta: "#f0685c",
    ctaDark: "#ff8d7d",
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
    overrides: {
      headerStyle: "band",
      headerBg: "#1d2a47",
      headerInk: "#edeff5",
      card: "#fcf8ef",
      bg: "#f4efe4",
      line: "#e8e0cc",
      chip: "#efe8d8",
      neg: "#c2372e",
      headerMute: "#8fa2cc",
      headerPos: "#8fe0b0",
      headerNeg: "#f28b7d",
      surface: "#fcf8ef",
      sheet: "#fcf8ef",
      key: "#fcf8ef",
      keybg: "#e9e0cb",
      inset: "#efe8d8",
      band: "#ece5d3",
    },
    overridesDark: {
      bg: "#131b2e",
      surface: "#1d2a47",
      card: "#1d2a47",
      line: "#2b3a5e",
      headerStyle: "band",
      headerBg: "#1d2a47",
      headerInk: "#edeff5",
      chip: "#243356",
      neg: "#f28b7d",
      headerMute: "#8fa2cc",
      headerPos: "#8fe0b0",
      headerNeg: "#f28b7d",
      sheet: "#1d2a47",
      key: "#243356",
      keybg: "#131b2e",
      inset: "#243356",
      band: "#1a2440",
    },
  },
};

/**
 * Alpha suffixes from the concatenation audit — both forms: `TEAL+"xx"` (14/18/1a/22)
 * and template literals `${TEAL}xx` / `${CORAL}xx` (40/44/55/66).
 */
const ALPHA_SUFFIXES = ["14", "18", "1a", "22", "40", "44", "55", "66"] as const;

/** "#46c4ba" + "1a" → "rgba(70,196,186,0.102)" (alpha rounded to 3 places). */
function hexAlpha(hex: string, suffix: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const a = Math.round((parseInt(suffix, 16) / 255) * 1000) / 1000;
  return `rgba(${r},${g},${b},${a})`;
}

/** rgba() from hex + numeric alpha — the ONLY sanctioned way to tint an entity color. */
export function tint(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
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
  // Nav defaults = EXACTLY today's BottomNav (bg C.bg, active C.text,
  // indicator = accent, inactive C.mute) — a teal regression guard.
  const nav = (isDark ? def.navDark : def.nav) ?? { bg: palette.bg, on: palette.text, mute: palette.mute, ind: accent };
  // C3 follow-up: on a "band" theme (Duet), `--accent` IS the band color (headerBg/nav bg are
  // both the same navy #1d2a47 in both modes) — a `:focus-visible{outline:2px solid var(--accent)}`
  // ring is then invisible (1.000:1) on the Header/BottomNav. `headerInk` is the token every band
  // theme already uses for on-band text/icons, and it measures ≥12:1 against headerBg/nav bg in
  // both modes (Duet), so it doubles as a high-contrast on-band ring. Plain themes (headerStyle
  // "plain") paint the band the same color as `bg`, so the ordinary accent ring is already correct
  // there — `--focus-ring-band` is just `--accent` for them (no behavior change).
  const focusRingBand = palette.headerStyle === "band" ? palette.headerInk : accent;
  const vars: Record<string, string> = {
    "--accent": accent,
    "--danger": danger,
    "--cta": cta,
    "--nav-bg": nav.bg,
    "--nav-on": nav.on,
    "--nav-mute": nav.mute,
    "--nav-ind": nav.ind,
    "--focus-ring-band": focusRingBand,
  };
  for (const s of ALPHA_SUFFIXES) {
    vars[`--accent-${s}`] = hexAlpha(accent, s);
    vars[`--danger-${s}`] = hexAlpha(danger, s);
    vars[`--cta-${s}`] = hexAlpha(cta, s);
  }
  return { vars, palette };
}
