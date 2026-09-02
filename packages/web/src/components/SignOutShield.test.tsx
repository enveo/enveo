import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { accountContentAccessibility, SignOutShieldContent } from "./SignOutShield";

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

  it("offers only local cleanup retry after the server session has ended", () => {
    const html = renderToStaticMarkup(createElement(SignOutShieldContent, { phase: "cleanup-failed", onRetry: () => {} }));

    expect(html).toContain('role="alert"');
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain("Retry local cleanup");
    expect(html).not.toContain("Try signing out again");
  });

  it("makes the authenticated subtree hidden and inert for every active phase", () => {
    expect(accountContentAccessibility("idle")).toEqual({ "aria-hidden": undefined, inert: false });
    expect(accountContentAccessibility("blocking")).toEqual({ "aria-hidden": true, inert: true });
    expect(accountContentAccessibility("cleanup-failed")).toEqual({ "aria-hidden": true, inert: true });
  });
});
