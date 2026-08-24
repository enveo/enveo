import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StartupSplash } from "./StartupSplash";

describe("startup splash", () => {
  it("announces a single loading status without exposing decorative graphics", () => {
    // when: the theme-independent startup screen is rendered
    const html = renderToStaticMarkup(createElement(StartupSplash));

    // then: assistive technology receives one useful status announcement
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Loading Enveo"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("uses the splash color for the browser and installed-PWA launch surfaces", () => {
    // given: the files that paint before the React preference providers can run
    const index = readFileSync(join(import.meta.dir, "..", "..", "index.html"), "utf8");
    const viteConfig = readFileSync(join(import.meta.dir, "..", "..", "vite.config.ts"), "utf8");

    // then: neither browser chrome nor the native PWA launch screen falls back to Silence
    expect(index).toContain('<meta name="theme-color" content="#1d2a47"');
    expect(index).toContain("html { background: #1d2a47; }");
    expect(viteConfig).toContain('theme_color: "#1d2a47"');
    expect(viteConfig).toContain('background_color: "#1d2a47"');
  });

  it("keeps the static first paint and the React handoff on the same visual contract", () => {
    // given: the static shell and its React replacement intentionally duplicate the tiny SVG
    const index = readFileSync(join(import.meta.dir, "..", "..", "index.html"), "utf8");
    const reactMarkup = renderToStaticMarkup(createElement(StartupSplash));

    // then: their stable structural markers and reduced-motion policy cannot drift silently
    for (const marker of ["startupSplash__art", "startupSplash__beam--left", "startupSplash__beam--right", "startupSplash__ring", "startupSplash__mark"])
      expect([index, reactMarkup].every((source) => source.includes(marker))).toBe(true);
    expect(index).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("allows browser zoom while preserving the edge-to-edge safe-area viewport", () => {
    const index = readFileSync(join(import.meta.dir, "..", "..", "index.html"), "utf8");

    expect(index).toContain('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"');
    expect(index).not.toContain("maximum-scale=");
    expect(index).not.toContain("user-scalable=");
  });
});
