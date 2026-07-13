/**
 * apiErrorMessage — the ONLY place a server error becomes text a user reads.
 *
 * Contract: the API answers with a stable machine CODE (never prose, never Polish — see
 * api/routes/*.ts), the client turns it into a sentence in the UI language, and anything it does
 * not know still degrades to something readable instead of an empty error.
 */
import { describe, expect, it } from "bun:test";
import { apiErrorMessage } from "./api";
import { en } from "./i18n.en";

/** How lib/sync.ts and lib/api.ts surface a failed request: "<status> <body>". */
const httpError = (status: number, body: unknown) => new Error(`${status} ${JSON.stringify(body)}`);

describe("apiErrorMessage", () => {
  // no localStorage in the test env → uiLang() falls back to the browser language (en)
  it("turns a server error code into a localized sentence", () => {
    expect(apiErrorMessage(httpError(503, { error: "ai_unavailable" }))).toBe(en["err.aiUnavailable"]);
    expect(apiErrorMessage(httpError(502, { error: "ai_upstream_error", status: 401 }))).toBe(en["err.aiUpstream"]);
    expect(apiErrorMessage(httpError(400, { error: "backup_invalid", detail: "ledger: Required" }))).toBe(en["err.backupInvalid"]);
    expect(apiErrorMessage(httpError(400, { error: "foreign_ref" }))).toBe(en["err.foreignRef"]);
    expect(apiErrorMessage(httpError(409, { error: "budget_mismatch", budgetId: "b1" }))).toBe(en["err.budgetMismatch"]);
  });

  it("localizes the client-side foreign_replica sentinel (thrown bare by the multi-tenant guard)", () => {
    expect(apiErrorMessage(new Error("foreign_replica"))).toBe(en["sync.notOwner"]);
  });

  it("degrades gracefully: an unknown code (older/newer server) stays readable", () => {
    expect(apiErrorMessage(httpError(418, { error: "brand_new_code" }))).toBe("brand_new_code");
    expect(apiErrorMessage(new Error("Failed to fetch"))).toBe("Failed to fetch");
  });
});
