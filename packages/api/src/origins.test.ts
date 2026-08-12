import { describe, expect, it } from "bun:test";
import { authTrustedOrigins, isSameHostOrigin, staticAllowedOrigins } from "./origins";

describe("staticAllowedOrigins", () => {
  it("collects ALLOWED_ORIGINS + BETTER_AUTH_URL origin (+ vite in dev)", () => {
    const set = staticAllowedOrigins({
      ALLOWED_ORIGINS: "https://app.example.com, https://ts.example.net",
      BETTER_AUTH_URL: "http://localhost:8080/some/path",
      WEB_DIST: "",
    });
    expect(set).toEqual(new Set(["https://app.example.com", "https://ts.example.net", "http://localhost:8080", "http://localhost:5173"]));
  });

  it("prod (WEB_DIST set): no vite origin", () => {
    const set = staticAllowedOrigins({
      ALLOWED_ORIGINS: "",
      BETTER_AUTH_URL: "https://enveo.example",
      WEB_DIST: "/srv/dist",
    });
    expect(set).toEqual(new Set(["https://enveo.example"]));
  });
});

describe("isSameHostOrigin", () => {
  it("matches host incl. port", () => {
    expect(isSameHostOrigin("http://192.168.1.7:8081", "192.168.1.7:8081")).toBe(true);
    expect(isSameHostOrigin("https://enveo.tail.example", "enveo.tail.example")).toBe(true);
  });
  it("rejects a foreign or malformed Origin and missing headers", () => {
    expect(isSameHostOrigin("https://evil.example", "enveo.example")).toBe(false);
    expect(isSameHostOrigin("http://enveo.example:9999", "enveo.example:8080")).toBe(false);
    expect(isSameHostOrigin("not a url", "enveo.example")).toBe(false);
    expect(isSameHostOrigin(null, "enveo.example")).toBe(false);
    expect(isSameHostOrigin("http://a.example", null)).toBe(false);
  });
});

describe("authTrustedOrigins (better-auth callback)", () => {
  it("adds the caller's own origin when it matches the request Host", () => {
    const req = new Request("http://10.0.0.5:8081/api/auth/sign-in/email", {
      headers: { origin: "http://10.0.0.5:8081", host: "10.0.0.5:8081" },
    });
    expect(authTrustedOrigins(req)).toContain("http://10.0.0.5:8081");
  });

  it("does NOT trust a foreign Origin", () => {
    const req = new Request("http://localhost/api/auth/sign-in/email", {
      headers: { origin: "https://evil.example", host: "localhost" },
    });
    expect(authTrustedOrigins(req)).not.toContain("https://evil.example");
  });

  it("no request → static allowlist only", () => {
    expect(authTrustedOrigins()).toEqual([...staticAllowedOrigins()]);
  });
});
