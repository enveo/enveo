/**
 * apiErrorMessage — the ONLY place a server error becomes text a user reads.
 *
 * Contract: the API answers with a stable machine CODE (never prose, never Polish — see
 * api/routes/*.ts), the client turns it into a sentence in the UI language, and anything it does
 * not know still degrades to something readable instead of an empty error.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { apiErrorMessage } from "./api";
import { en } from "./i18n.en";
import { pl } from "./i18n.pl";

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

/**
 * The client throws CODES too. lib/* must never build a sentence (it cannot know the UI language,
 * and a hardcoded one leaks the author's locale into a foreign user's screen) — it throws a code
 * and lib/api.ts owns the wording, in every locale.
 */
describe("client-side error codes", () => {
  const CLIENT_CODES: Record<string, keyof typeof en> = {
    no_local_replica: "err.noLocalReplica", // sync.ts — pushLocalToServer/resetServerE2ee, mirror not booted
    no_encryption_key: "err.noEncryptionKey", // sync.ts — resetServerE2ee with no DEK on this device
    empty_unbound_replica: "err.emptyUnboundReplica", // sync.ts — refused: it could only wipe the budget
    bad_ciphertext: "err.badCiphertext", // crypto.ts — an envelope this build cannot read
    bad_pairing_code: "err.badPairingCode", // crypto.ts — decodePairing on a code that is not ours
    ai_consent_required: "err.aiNotConfigured", // ai.ts — AiConsentRequired: no usable model on this device
  };

  it("localizes every code lib/* throws (Settings → backup import, disable local mode, Unlock)", () => {
    for (const [code, key] of Object.entries(CLIENT_CODES)) {
      expect(apiErrorMessage(new Error(code))).toBe(en[key]);
      expect(en[key]).not.toBe(code); // mapped, not the raw code falling through
    }
  });

  it("carries a sentence in BOTH locales — a missing PL/EN key would surface the key itself", () => {
    for (const key of Object.values(CLIENT_CODES)) {
      for (const dict of [en, pl] as const) {
        expect(dict[key]).toBeTruthy();
        expect(dict[key]).not.toBe(key);
      }
    }
  });
});

/**
 * REGRESSION GUARD (the release blocker this replaced): raw Polish sentences were thrown here and
 * rendered verbatim, because apiErrorMessage passes an unknown message through unchanged. Every
 * plain-string throw in the two libs a user can reach must be a snake_case CODE.
 */
describe("no prose thrown from the UI-reachable libs", () => {
  /** Internal control-flow aborts: thrown INSIDE doCycle, swallowed by its catch-all (the sync
   *  state goes to "error"/"locked"), so they are never rendered as text. Not user-facing. */
  const INTERNAL_ABORTS = new Set([
    "e2ee: no DEK — waiting for unlock", // doFullResync → the Unlock screen takes over
    "push: response without batch results", // loop defense against a buggy server
    "unauthorized: 401", // UnauthorizedError → enterUnauthed() puts the Login screen on screen (sync.ts)
  ]);

  const LIB_DIR = fileURLToPath(new URL(".", import.meta.url)); // this file's dir (portable, TS-clean)

  // ai.ts joined the scan after AiConsentRequired shipped with the message "ai consent required":
  // a custom Error subclass hides its message in super(...), which the `new Error("…")` pattern
  // never saw — so the prose reached the Add screen's error line verbatim. Both shapes are scanned.
  for (const file of ["sync.ts", "crypto.ts", "ai.ts"]) {
    it(`${file} throws codes, not sentences`, () => {
      const src = readFileSync(join(LIB_DIR, file), "utf8");
      // Double-quoted literals only: `throw new Error(\`pull: ${res.status}\`)` is a technical
      // status line the UI never shows as prose, and apiErrorMessage parses the {error} out of it.
      const thrown = [...src.matchAll(/(?:new Error|super)\("([^"]+)"\)/g)].map((m) => m[1]!);
      expect(thrown.length).toBeGreaterThan(0); // the scan must actually see the throws
      for (const msg of thrown) {
        if (INTERNAL_ABORTS.has(msg)) continue;
        expect(msg).toMatch(/^[a-z0-9_]+$/); // a code — no spaces, no locale, no punctuation
      }
    });
  }
});
