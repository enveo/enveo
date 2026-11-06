import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("StyleInjector's shared `.fi` fade class", () => {
  it("carries NO fill-forwards — unlike `.fu`, which keeps it on purpose", () => {
    // `.fi` wraps content that can host a `position:fixed` Sheet (Settings.tsx's active
    // sub-screen and its Hub) — `both`/`forwards` keeps a CSS *animation* affecting its target
    // property forever (the animation-name is never removed), and per the CSS Animations spec
    // that means the element stays a stacking context forever too, trapping any descendant
    // Sheet's z-index inside it. That is exactly how the wide side panel's own always-on
    // `transform` (a stacking context by construction, WideShell's `data-wide-panel`) painted
    // OVER the E2EE-enable Sheet regardless of the Sheet's z-index: `elementFromPoint` inside the
    // overlap at 1104/1440 resolved to the panel, not the Sheet. Dropping the fill mode here fixes
    // it — verified live in the browser, since bun:test has no real layout/paint engine to observe
    // stacking context directly. See the comment above this rule in chrome.tsx and Settings.tsx's
    // own comment on its `.fi` wrapper for the full story.
    const source = readFileSync(join(import.meta.dir, "chrome.tsx"), "utf8");
    expect(source).toContain(".fi{animation:fi .25s ease-out}");
    expect(source).not.toContain(".fi{animation:fi .25s ease-out both}");

    expect(source).toContain(".fu{animation:fu .4s ease-out both}");
  });
});

describe("Sheet hosted in the wide side panel", () => {
  it("portals into the sign-out boundary's host with the app font, <body> only without a boundary", () => {
    // given: the panel branch leaves the panel's transformed layer; <body> sits outside the
    // sign-out boundary's aria-hidden/inert and outside the app container's font
    const source = readFileSync(join(import.meta.dir, "chrome.tsx"), "utf8");
    const branch = source.slice(source.indexOf("return hostedInPanel"), source.indexOf(": body;"));

    // then
    expect(source).toContain("const portalTarget = useAccountPortalTarget();");
    expect(branch).toContain('<div data-wide-panel-portal style={{ display: "contents", fontFamily: font');
    expect(branch).toMatch(/<\/div>,\s*portalTarget \?\? document\.body,\s*\)/);
  });
});

describe("StyleInjector's active amount box", () => {
  it("injects the ring that an active PadInput draws on its data-pad-box", () => {
    const source = readFileSync(join(import.meta.dir, "chrome.tsx"), "utf8");
    const presentation = readFileSync(join(import.meta.dir, "../lib/focusPresentation.ts"), "utf8");

    expect(source).toMatch(/\$\{INPUT_FOCUS_CSS\}\$\{PAD_BOX_CSS\}/);
    expect(presentation).toContain("[data-pad-box]:has(>input[data-pad-active])");
    expect(presentation).toContain("[data-pad-box]:has(>input[data-pad-error])");
  });
});
