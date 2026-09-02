import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SignOutShieldContent } from "./SignOutShield";

describe("SignOutShield", () => {
  it("renders no surface while sign-out is idle", () => {
    expect(renderToStaticMarkup(createElement(SignOutShieldContent, { phase: "idle" }))).toBe("");
  });

  it("covers account data with an accessible progress status while blocking", () => {
    const html = renderToStaticMarkup(createElement(SignOutShieldContent, { phase: "blocking" }));

    expect(html).toContain('role="status"');
    expect(html).toContain("Signing out…");
    expect(html).not.toContain("<button");
  });

  it("offers only retry when the terminal server phase is exposed", () => {
    const html = renderToStaticMarkup(createElement(SignOutShieldContent, { phase: "server-failed", onRetry: () => {} }));

    expect(html).toContain('role="alert"');
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain("Try signing out again");
  });
});
