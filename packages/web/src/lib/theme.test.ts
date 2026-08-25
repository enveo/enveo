import { describe, expect, test } from "bun:test";
import { type AccentTheme, CORAL, CTA, dark, light, TEAL, themeTokens, tint } from "./theme";

/** Alpha suffixes from the concatenation audit — forms `X+"xx"` (14/18/1a/22) and `${X}xx` (40/44/55/66). */
const ALPHA_SUFFIXES = ["14", "18", "1a", "22", "40", "44", "55", "66"] as const;
const ALL_THEMES: AccentTheme[] = ["teal", "koral", "atrament", "duet"];

describe("constant exports → CSS vars (names unchanged)", () => {
  test("TEAL/CORAL/CTA point to CSS variables", () => {
    expect(TEAL).toBe("var(--accent)");
    expect(CORAL).toBe("var(--danger)");
    expect(CTA).toBe("var(--cta)");
  });
});

describe("teal theme = Sage #4fa583 (stability guard since 1.15.0)", () => {
  test("light: Sage accent, deepened Cisza danger, CTA is always coral", () => {
    const { vars } = themeTokens("teal", false);
    expect(vars["--accent"]).toBe("#4fa583");
    expect(vars["--danger"]).toBe("#c22e3d");
    expect(vars["--cta"]).toBe("#f0685c");
  });
  test("dark: accent lightened Sage #77c4a2 (C3 contrast audit — was #6cbf9b, 4.33:1 on card), deepened Cisza danger, CTA is always coral", () => {
    const { vars } = themeTokens("teal", true);
    expect(vars["--accent"]).toBe("#77c4a2");
    expect(vars["--danger"]).toBe("#ef4b58");
    expect(vars["--cta"]).toBe("#ff8d7d");
  });
  test("light palette = exactly today's light object (all hexes)", () => {
    expect(themeTokens("teal", false).palette).toEqual(light);
  });
  test("dark palette = exactly today's dark object (all hexes)", () => {
    expect(themeTokens("teal", true).palette).toEqual(dark);
  });
  test("nav = the existing BottomNav: bg background, active text, accent indicator, inactive mute", () => {
    const { vars } = themeTokens("teal", false);
    expect(vars["--nav-bg"]).toBe(light.bg);
    expect(vars["--nav-on"]).toBe(light.text);
    expect(vars["--nav-ind"]).toBe("#4fa583");
    expect(vars["--nav-mute"]).toBe(light.mute);
    const d = themeTokens("teal", true).vars;
    expect(d["--nav-bg"]).toBe(dark.bg);
    expect(d["--nav-on"]).toBe(dark.text);
    expect(d["--nav-ind"]).toBe("#77c4a2");
    expect(d["--nav-mute"]).toBe(dark.mute);
  });
  test("alpha --accent-1a = Sage rgba with the 1a suffix", () => {
    expect(themeTokens("teal", false).vars["--accent-1a"]).toBe("rgba(79,165,131,0.102)");
  });
  test("remaining alphas from the audit: 14/18/22/40/44/55/66", () => {
    const { vars } = themeTokens("teal", false);
    expect(vars["--accent-14"]).toBe("rgba(79,165,131,0.078)");
    expect(vars["--accent-18"]).toBe("rgba(79,165,131,0.094)");
    expect(vars["--accent-22"]).toBe("rgba(79,165,131,0.133)");
    expect(vars["--accent-44"]).toBe("rgba(79,165,131,0.267)");
    expect(vars["--accent-55"]).toBe("rgba(79,165,131,0.333)");
    expect(vars["--danger-22"]).toBe("rgba(194,46,61,0.133)");
    expect(vars["--danger-66"]).toBe("rgba(194,46,61,0.4)");
    // FAB: a shadow with the 40 suffix on the CTA → --cta-40 (CTA is always coral, not the accent).
    expect(vars["--cta-40"]).toBe("rgba(240,104,92,0.251)");
  });
});

describe("koral (the app default)", () => {
  test("light: accent #f0685c, deepened danger #c22e3d", () => {
    const { vars } = themeTokens("koral", false);
    expect(vars["--accent"]).toBe("#f0685c");
    expect(vars["--danger"]).toBe("#c22e3d");
    expect(vars["--cta"]).toBe("#f0685c");
  });
  test("dark: accent #ff998a (C3 contrast audit — was #ff8d7d, 4.23:1 on card), danger #ef4b58, CTA pinned to coral #ff8d7d", () => {
    const { vars } = themeTokens("koral", true);
    expect(vars["--accent"]).toBe("#ff998a");
    expect(vars["--danger"]).toBe("#ef4b58");
    expect(vars["--cta"]).toBe("#ff8d7d");
  });
  // koral has no `overrides`/`overridesDark`, but its rail alphas still diverge from the base
  // `light`/`dark` objects (task A2: railActive/accentSoft/selBg track koral's OWN accent, not
  // teal's default) — everything else stays exactly the base palette.
  test("palette without overrides = standard light/dark except accent-tracked rail alphas", () => {
    const { vars: lv, palette: lp } = themeTokens("koral", false);
    expect(lp).toEqual({ ...light, railActive: tint(lv["--accent"]!, 0.18), accentSoft: tint(lv["--accent"]!, 0.12), selBg: tint(lv["--accent"]!, 0.1) });
    const { vars: dv, palette: dp } = themeTokens("koral", true);
    expect(dp).toEqual({ ...dark, railActive: tint(dv["--accent"]!, 0.18), accentSoft: tint(dv["--accent"]!, 0.12), selBg: tint(dv["--accent"]!, 0.1) });
  });
});

describe("atrament", () => {
  test("light: navy #1d2a47, danger same deepened Cisza red as teal", () => {
    const { vars } = themeTokens("atrament", false);
    expect(vars["--accent"]).toBe("#1d2a47");
    expect(vars["--danger"]).toBe("#c22e3d");
  });
  test("dark: lightened navy #a5b5d6 (C3 contrast audit — was #8fa2cc, 3.71:1 on card, the worst of the backlog note's 'outline chips')", () => {
    const { vars } = themeTokens("atrament", true);
    expect(vars["--accent"]).toBe("#a5b5d6");
    expect(vars["--danger"]).toBe("#ef4b58");
  });
});

describe("duet", () => {
  test("light: navy accent, coral CTA, navy nav, cream surfaces", () => {
    const { vars, palette } = themeTokens("duet", false);
    expect(vars["--accent"]).toBe("#1d2a47");
    expect(vars["--input-underline"]).toBe(vars["--accent"]);
    expect(vars["--cta"]).toBe("#f0685c");
    expect(vars["--nav-bg"]).toBe("#1d2a47");
    expect(vars["--nav-on"]).toBe("#ff8d7d");
    expect(palette.bg).toBe("#f4efe4");
    expect(palette.card).toBe("#fcf8ef");
    expect(palette.line).toBe("#e8e0cc");
    expect(palette.chip).toBe("#efe8d8");
    expect(palette.headerStyle).toBe("band");
    expect(palette.headerBg).toBe("#1d2a47");
    expect(palette.headerInk).toBe("#edeff5");
  });
  test("dark: a navy world — bg/card/surface/line overrides + CTA #ff8d7d", () => {
    const { vars, palette } = themeTokens("duet", true);
    expect(vars["--input-underline"]).toBe(vars["--accent"]);
    expect(vars["--cta"]).toBe("#ff8d7d");
    expect(palette.bg).toBe("#131b2e");
    expect(palette.card).toBe("#1d2a47");
    expect(palette.surface).toBe("#1d2a47");
    expect(palette.line).toBe("#2b3a5e");
    // the remaining fields inherit from the standard dark
    expect(palette.text).toBe(dark.text);
  });
});

describe("full var set for 4 themes × 2 modes", () => {
  const REQUIRED = [
    "--accent",
    "--danger",
    "--cta",
    "--nav-bg",
    "--nav-on",
    "--nav-mute",
    "--nav-ind",
    "--focus-ring",
    ...ALPHA_SUFFIXES.map((s) => `--accent-${s}`),
    ...ALPHA_SUFFIXES.map((s) => `--danger-${s}`),
    ...ALPHA_SUFFIXES.map((s) => `--cta-${s}`),
  ];
  for (const t of ALL_THEMES) {
    for (const isDark of [false, true]) {
      test(`${t} ${isDark ? "dark" : "light"}: all keys present, alphas in rgba format`, () => {
        const { vars } = themeTokens(t, isDark);
        for (const k of REQUIRED) {
          expect(vars[k]).toBeString();
          expect(vars[k]!.length).toBeGreaterThan(0);
        }
        for (const s of ALPHA_SUFFIXES) {
          expect(vars[`--accent-${s}`]).toMatch(/^rgba\(\d+,\d+,\d+,0\.\d+\)$/);
          expect(vars[`--danger-${s}`]).toMatch(/^rgba\(\d+,\d+,\d+,0\.\d+\)$/);
        }
      });
    }
  }
});

describe("4×2 snapshot of the key fields (accent/danger/cta/nav-bg)", () => {
  test("table matches the spec", () => {
    const table = Object.fromEntries(
      ALL_THEMES.flatMap((t) =>
        [false, true].map((isDark) => {
          const { vars } = themeTokens(t, isDark);
          return [`${t}.${isDark ? "dark" : "light"}`, { accent: vars["--accent"], danger: vars["--danger"], cta: vars["--cta"], navBg: vars["--nav-bg"] }];
        }),
      ),
    );
    expect(table).toEqual({
      // navBg = today's BottomNav background (C.bg), NOT surface — a regression guard.
      // CTA is always coral (spec) — teal/atrament no longer fall back to their accent.
      "teal.light": { accent: "#4fa583", danger: "#c22e3d", cta: "#f0685c", navBg: "#f4f3ef" },
      "teal.dark": { accent: "#77c4a2", danger: "#ef4b58", cta: "#ff8d7d", navBg: "#3b414b" },
      "koral.light": { accent: "#f0685c", danger: "#c22e3d", cta: "#f0685c", navBg: "#f4f3ef" },
      "koral.dark": { accent: "#ff998a", danger: "#ef4b58", cta: "#ff8d7d", navBg: "#3b414b" },
      "atrament.light": { accent: "#1d2a47", danger: "#c22e3d", cta: "#f0685c", navBg: "#f4f3ef" },
      "atrament.dark": { accent: "#a5b5d6", danger: "#ef4b58", cta: "#ff8d7d", navBg: "#3b414b" },
      "duet.light": { accent: "#1d2a47", danger: "#c22e3d", cta: "#f0685c", navBg: "#1d2a47" },
      "duet.dark": { accent: "#8fa2cc", danger: "#ef4b58", cta: "#ff8d7d", navBg: "#1d2a47" },
    });
  });
});

describe("theme screen tokens", () => {
  test("every theme × mode carries state + header tokens", () => {
    for (const t of ALL_THEMES) {
      for (const isDark of [false, true]) {
        const { palette } = themeTokens(t, isDark);
        expect(palette.pos).toMatch(/^#/);
        expect(palette.warn).toMatch(/^#/);
        expect(palette.neg).toMatch(/^#/);
        expect(palette.chip).toMatch(/^#/);
        expect(["plain", "band"]).toContain(palette.headerStyle);
        expect(palette.headerBg).toMatch(/^#/);
        expect(palette.headerInk).toMatch(/^#/);
        expect(palette.headerMute).toMatch(/^#/);
        expect(palette.headerPos).toMatch(/^#/);
        expect(palette.headerNeg).toMatch(/^#/);
        expect(themeTokens(t, isDark).vars["--input-underline"]).toBe(themeTokens(t, isDark).vars["--accent"]);
      }
    }
  });

  test("Cisza themes render a plain header; duet renders a band", () => {
    expect(themeTokens("teal", false).palette.headerStyle).toBe("plain");
    expect(themeTokens("koral", true).palette.headerStyle).toBe("plain");
    expect(themeTokens("duet", false).palette.headerStyle).toBe("band");
    expect(themeTokens("duet", true).palette.headerStyle).toBe("band");
    expect(themeTokens("duet", false).palette.headerBg).toBe("#1d2a47");
  });

  test("duet dark keeps its navy world (regression guard)", () => {
    const { palette } = themeTokens("duet", true);
    expect(palette.bg).toBe("#131b2e");
    expect(palette.card).toBe("#1d2a47");
  });

  test("duet-dark neg is lightened to #f28b7d for contrast on navy cards", () => {
    expect(themeTokens("duet", true).palette.neg).toBe("#f28b7d");
  });

  test("duet headerNeg (light and dark band) is lightened to #f28b7d — #ef4b58 is sub-AA on the navy band", () => {
    expect(themeTokens("duet", false).palette.headerNeg).toBe("#f28b7d");
    expect(themeTokens("duet", true).palette.headerNeg).toBe("#f28b7d");
  });

  test("teal/atrament danger is a deepened Cisza red, distinct from the coral CTA", () => {
    for (const th of ["teal", "atrament"] as const) {
      const { vars } = themeTokens(th, false);
      expect(vars["--danger"]).toBe("#c22e3d");
      const darkVars = themeTokens(th, true).vars;
      expect(darkVars["--danger"]).toBe("#ef4b58");
    }
  });

  test("duet surfaces: cream world in light, navy world in dark (sheets/keys inherit)", () => {
    const l = themeTokens("duet", false).palette;
    expect(l.sheet).toBe("#fcf8ef");
    expect(l.surface).toBe("#fcf8ef");
    expect(l.key).toBe("#fcf8ef");
    expect(l.keybg).toBe("#e9e0cb");
    expect(l.inset).toBe("#efe8d8");
    expect(l.band).toBe("#ece5d3");
    const d = themeTokens("duet", true).palette;
    expect(d.sheet).toBe("#1d2a47");
    expect(d.key).toBe("#243356");
    expect(d.keybg).toBe("#131b2e");
    expect(d.inset).toBe("#243356");
    expect(d.band).toBe("#1a2440");
  });

  test("tint computes rgba from hex without string concatenation", () => {
    expect(tint("#4f86bd", 0.14)).toBe("rgba(79,134,189,0.14)");
    expect(tint("#ffffff", 1)).toBe("rgba(255,255,255,1)");
  });

  test("CTA resolves to coral in every theme (spec: CTA is always coral)", () => {
    for (const th of ["teal", "koral", "atrament", "duet"] as const) {
      expect(themeTokens(th, false).vars["--cta"]).toMatch(/^#(f0685c|ff8d7d)$/i);
      expect(themeTokens(th, true).vars["--cta"]).toMatch(/^#(f0685c|ff8d7d)$/i);
    }
  });
});

/**
 * Wide-layout rail chrome tokens (design parity wave A, task A2 — `Wide App Demo v3.dc.html`
 * §CISZA/DUET). railBg/railCard are static per mode; railActive/accentSoft/selBg track the
 * ACTIVE accent for the Cisza family (teal/koral/atrament) and are Duet's own literal numbers.
 */
describe("rail chrome tokens (design parity wave A, task A2)", () => {
  test("Cisza family: railBg/railCard are the design's neutral pair in both modes", () => {
    for (const th of ["teal", "koral", "atrament"] as const) {
      expect(themeTokens(th, false).palette.railBg).toBe("#efeee9");
      expect(themeTokens(th, false).palette.railCard).toBe("#ffffff");
      expect(themeTokens(th, true).palette.railBg).toBe("#343a44");
      expect(themeTokens(th, true).palette.railCard).toBe("#404650");
    }
  });

  test("Cisza family: railActive/accentSoft/selBg are tinted off the theme's OWN accent, not teal's", () => {
    for (const th of ["teal", "koral", "atrament"] as const) {
      for (const isDark of [false, true]) {
        const { vars, palette } = themeTokens(th, isDark);
        const accent = vars["--accent"]!;
        expect(palette.railActive).toBe(tint(accent, 0.18));
        expect(palette.accentSoft).toBe(tint(accent, 0.12));
        expect(palette.selBg).toBe(tint(accent, 0.1));
      }
    }
  });

  test("koral/atrament diverge from teal's rail alphas (proof the accent, not a fixed default, drives them)", () => {
    const teal = themeTokens("teal", false).palette;
    const koral = themeTokens("koral", false).palette;
    const atrament = themeTokens("atrament", false).palette;
    expect(koral.railActive).not.toBe(teal.railActive);
    expect(atrament.railActive).not.toBe(teal.railActive);
  });

  test("Duet: navy rail with a translucent card overlay, coral highlight — identical light/dark (own chrome, not accent-derived)", () => {
    for (const isDark of [false, true]) {
      const { palette } = themeTokens("duet", isDark);
      expect(palette.railBg).toBe("#1d2a47");
      expect(palette.railCard).toBe("rgba(255,255,255,0.07)");
      expect(palette.railActive).toBe("rgba(255,141,125,0.22)");
      expect(palette.accentSoft).toBe("rgba(29,42,71,0.1)");
      expect(palette.selBg).toBe("rgba(29,42,71,0.07)");
      expect(palette.bandMute).toBe("#8fa2cc");
    }
  });

  test("railOn/railMute: Cisza equals soft/mute; Duet gets its OWN lighter blue-greys (both light and dark duet)", () => {
    for (const th of ["teal", "koral", "atrament"] as const) {
      for (const isDark of [false, true]) {
        const { palette } = themeTokens(th, isDark);
        expect(palette.railOn).toBe(palette.soft);
        expect(palette.railMute).toBe(palette.mute);
      }
    }
    for (const isDark of [false, true]) {
      const { palette } = themeTokens("duet", isDark);
      expect(palette.railOn).toBe("#c9d2e4");
      expect(palette.railMute).toBe("#8fa2cc");
      // NOT the same as `soft`/`mute`, which stay Cisza-calibrated (dark ink) and would be
      // illegible on Duet's navy rail — the bug this pair exists to fix.
      expect(palette.railOn).not.toBe(palette.soft);
      expect(palette.railMute).not.toBe(palette.mute);
    }
  });

  test("railRuler/railBorder: Cisza gets the design's literal numbers (both modes); Duet gets its own near-invisible navy-rail numbers (fix-review)", () => {
    for (const th of ["teal", "koral", "atrament"] as const) {
      expect(themeTokens(th, false).palette.railRuler).toBe("#e2e0d8");
      expect(themeTokens(th, false).palette.railBorder).toBe("#ece9e2");
      expect(themeTokens(th, true).palette.railRuler).toBe("#4b515b");
      expect(themeTokens(th, true).palette.railBorder).toBe("#4b515b");
    }
    for (const isDark of [false, true]) {
      const { palette } = themeTokens("duet", isDark);
      expect(palette.railRuler).toBe("rgba(255,255,255,0.16)");
      expect(palette.railBorder).toBe("transparent");
      // NOT `line` — `line`'s opaque Duet cream (#e8e0cc) is calibrated for Duet's cream content
      // surfaces and rendered a visible tan track/dividers on the near-navy rail card (the bug
      // this pair exists to fix).
      expect(palette.railRuler).not.toBe(palette.line);
      expect(palette.railBorder).not.toBe(palette.line);
    }
  });

  test("bandMute mirrors headerMute (same on-header muted tone) for every theme × mode", () => {
    for (const th of ["teal", "koral", "atrament", "duet"] as const) {
      for (const isDark of [false, true]) {
        const { palette } = themeTokens(th, isDark);
        expect(palette.bandMute).toBe(palette.headerMute);
      }
    }
  });
});

/**
 * C3 dark-mode contrast audit (2026-07-31) — regression guard for the backlog note
 * "dark-mode accent audit — outline chips measure 3.4–3.9:1". WCAG 2.1 relative-luminance
 * contrast, ported inline (no DOM/browser needed) so this runs in `bun test`. The full measured
 * table + before/after screenshots live in the maintainer's review notes for that audit.
 */
describe("C3 contrast audit — dark-mode AA regression guard", () => {
  const hexToRgb = (hex: string) => ({
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  });
  const relLum = (hex: string) => {
    const { r, g, b } = hexToRgb(hex);
    const f = (channel: number) => {
      const v = channel / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (fg: string, bg: string) => {
    const l1 = relLum(fg),
      l2 = relLum(bg);
    const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
    return (hi + 0.05) / (lo + 0.05);
  };
  const AA_TEXT = 4.5;
  const AA_UI = 3.0;

  test("teal/koral/atrament dark accent is AA text-contrast on card/surface/bg/chip (outline chips, 'details ›' links, GoalRing)", () => {
    for (const th of ["teal", "koral", "atrament"] as const) {
      const { vars, palette } = themeTokens(th, true);
      const accent = vars["--accent"]!;
      for (const bg of [palette.card, palette.surface, palette.bg, palette.chip]) {
        expect(ratio(accent, bg)).toBeGreaterThanOrEqual(AA_TEXT);
      }
    }
  });

  test("duet dark accent stays AA on its navy world (reference point, untouched by the audit)", () => {
    const { vars, palette } = themeTokens("duet", true);
    expect(ratio(vars["--accent"]!, palette.card)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(vars["--accent"]).toBe("#8fa2cc"); // unchanged — already AA on the navy overridesDark palette
  });

  test("uses one cross-surface focus ring for both Duet search fields", () => {
    const lightTokens = themeTokens("duet", false);
    const darkTokens = themeTokens("duet", true);
    expect(lightTokens.vars["--focus-ring"]).toBe("#4a86c4");
    expect(darkTokens.vars["--focus-ring"]).toBe("#ff8d7d");
    for (const { vars, palette } of [lightTokens, darkTokens]) {
      for (const bg of [palette.headerBg, palette.bg, palette.card]) {
        expect(ratio(vars["--focus-ring"]!, bg)).toBeGreaterThanOrEqual(AA_UI);
      }
    }
    for (const th of ["teal", "koral", "atrament"] as const) {
      expect(themeTokens(th, false).vars["--focus-ring"]).toBe(themeTokens(th, false).vars["--accent"]);
      expect(themeTokens(th, true).vars["--focus-ring"]).toBe(themeTokens(th, true).vars["--accent"]);
    }
  });

  test("every theme's dark accent clears the 3:1 UI/border floor too (outline chip borders, active filter-chip checkmarks)", () => {
    for (const th of ["teal", "koral", "atrament", "duet"] as const) {
      const { vars, palette } = themeTokens(th, true);
      expect(ratio(vars["--accent"]!, palette.card)).toBeGreaterThanOrEqual(AA_UI);
    }
  });

  test("dark.neg (DeltaTag down-arrows, over-assigned TBB hero, negative amounts) is AA text-contrast on card/bg", () => {
    for (const th of ["teal", "koral", "atrament"] as const) {
      const { palette } = themeTokens(th, true);
      expect(ratio(palette.neg, palette.card)).toBeGreaterThanOrEqual(AA_TEXT);
      expect(ratio(palette.neg, palette.bg)).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  test("dark.warn (near-limit pills) is AA text-contrast on card/sheet", () => {
    for (const th of ["teal", "koral", "atrament"] as const) {
      const { palette } = themeTokens(th, true);
      expect(ratio(palette.warn, palette.card)).toBeGreaterThanOrEqual(AA_TEXT);
      expect(ratio(palette.warn, palette.sheet)).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });
});
