import { describe, expect, it } from "bun:test";
import { CSP_REPORT_MAX_BYTES, parseCspReports } from "./cspReports";

const CHROME_UA = "Mozilla/5.0 Chrome/128.0.0.0 Safari/537.36";
const legacy = {
  "csp-report": {
    "document-uri": "https://app.example/transactions?account=secret#row",
    "blocked-uri": "https://evil.example/steal?budget=secret",
    "effective-directive": "script-src-elem",
    disposition: "enforce",
    "script-sample": "secret ledger text",
    "source-file": "https://app.example/assets/index.js?token=secret",
  },
};

describe("parseCspReports", () => {
  it("sanitizes the legacy CSP report envelope", () => {
    expect(parseCspReports("application/csp-report", JSON.stringify(legacy), CHROME_UA)).toEqual([
      {
        directive: "script-src-elem",
        disposition: "enforce",
        documentOrigin: "https://app.example",
        documentPathClass: "/transactions",
        blockedKind: "cross-origin",
        blockedOrigin: "https://evil.example",
        browser: "chromium",
      },
    ]);
  });

  it("sanitizes Reporting API reports and reduces browser identity", () => {
    const report = [
      {
        type: "csp-violation",
        body: {
          documentURL: "https://app.example/settings/private?token=secret",
          blockedURL: "data:text/javascript,secret",
          effectiveDirective: "style-src",
          disposition: "report",
        },
      },
    ];
    expect(parseCspReports("application/reports+json; charset=utf-8", JSON.stringify(report), "Mozilla/5.0 Firefox/130")).toEqual([
      {
        directive: "style-src",
        disposition: "report",
        documentOrigin: "https://app.example",
        documentPathClass: "/settings",
        blockedKind: "data",
        browser: "firefox",
      },
    ]);
  });

  it("rejects unsupported, malformed, and unknown bodies", () => {
    expect(parseCspReports("text/plain", "{}", null)).toEqual([]);
    expect(parseCspReports("application/csp-report", "{", null)).toEqual([]);
    expect(parseCspReports("application/csp-report", JSON.stringify({ nope: {} }), null)).toEqual([]);
  });

  it("caps reports and fields while keeping secrets out of output", () => {
    const report = {
      "csp-report": {
        "document-uri": "https://app.example/transactions?secret=query",
        "blocked-uri": "blob:https://app.example/secret-value",
        "effective-directive": "script-src",
        disposition: "unexpected",
        "script-sample": "secret-sample",
        "source-file": "https://app.example/source?secret=file",
      },
    };
    const many = JSON.stringify(
      Array.from({ length: 25 }, () => ({
        type: "csp-violation",
        body: {
          documentURL: report["csp-report"]["document-uri"],
          blockedURL: report["csp-report"]["blocked-uri"],
          effectiveDirective: "script-src",
          disposition: "unexpected",
        },
      })),
    );
    const result = parseCspReports("application/reports+json", many, "Safari/17");
    expect(result).toHaveLength(20);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("sample");
    expect(result[0]).toMatchObject({ directive: "script-src", disposition: "report", blockedKind: "blob", browser: "safari" });
    expect(
      parseCspReports("application/csp-report", JSON.stringify({ "csp-report": { ...report["csp-report"], "effective-directive": "x".repeat(129) } }), null),
    ).toEqual([]);
  });

  it("classifies missing and invalid blocked URLs without retaining values", () => {
    const body = (blockedURL: string) =>
      JSON.stringify([
        {
          type: "csp-violation",
          body: {
            documentURL: "not a url",
            blockedURL,
            effectiveDirective: "connect-src",
            disposition: "enforce",
          },
        },
      ]);
    expect(parseCspReports("application/reports+json", body(""), null)[0]).toMatchObject({
      documentOrigin: "unknown",
      documentPathClass: "/unknown",
      blockedKind: "none",
    });
    expect(parseCspReports("application/reports+json", body("blob:secret"), null)[0]).toMatchObject({ blockedKind: "blob" });
    expect(parseCspReports("application/reports+json", body("data:secret"), null)[0]).toMatchObject({ blockedKind: "data" });
  });

  it("exports the body limit used by the endpoint", () => {
    expect(CSP_REPORT_MAX_BYTES).toBe(16_384);
  });
});
