/**
 * apiErrorMessage — the ONLY place a server error becomes text a user reads.
 *
 * Contract: the API answers with a stable machine CODE (never prose, never Polish — see
 * api/routes/*.ts), the client turns it into a sentence in the UI language, and anything it does
 * not know still degrades to something readable instead of an empty error.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { api, apiErrorMessage } from "./api";
import type { Message } from "./i18n";
import { pl } from "./i18n/locales/pl";

/** How lib/sync.ts and lib/api.ts surface a failed request: "<status> <body>". */
const httpError = (status: number, body: unknown) => new Error(`${status} ${JSON.stringify(body)}`);

const IMPORT_JOB = {
  id: "11111111-1111-4111-8111-111111111111",
  budgetId: "22222222-2222-4222-8222-222222222222",
  accountId: "33333333-3333-4333-8333-333333333333",
  provider: { provider: "enveo", model: "gpt-5.6-luna" },
  tier: "plain",
  status: "queued",
  phase: "queued",
  resumePhase: null,
  cancelRequested: false,
  attempt: 0,
  errorCode: null,
  retryAt: null,
  createdAt: "2026-08-24T12:00:00.000Z",
  updatedAt: "2026-08-24T12:00:00.000Z",
  expiresAt: "2026-08-31T12:00:00.000Z",
  proposalCount: 0,
  locale: "pl-PL",
  epoch: 0,
  result: null,
  appliedCount: 0,
  skippedCount: 0,
} as const;

const IMPORT_JOB_SUMMARY = {
  id: IMPORT_JOB.id,
  budgetId: IMPORT_JOB.budgetId,
  accountId: IMPORT_JOB.accountId,
  provider: IMPORT_JOB.provider,
  tier: IMPORT_JOB.tier,
  status: IMPORT_JOB.status,
  phase: IMPORT_JOB.phase,
  resumePhase: IMPORT_JOB.resumePhase,
  cancelRequested: IMPORT_JOB.cancelRequested,
  attempt: IMPORT_JOB.attempt,
  errorCode: IMPORT_JOB.errorCode,
  retryAt: IMPORT_JOB.retryAt,
  createdAt: IMPORT_JOB.createdAt,
  updatedAt: IMPORT_JOB.updatedAt,
  expiresAt: IMPORT_JOB.expiresAt,
  proposalCount: IMPORT_JOB.proposalCount,
} as const;

describe("account preferences API client", () => {
  it("sends the verified user assertion with a strict field patch", async () => {
    const originalFetch = globalThis.fetch;
    let request: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      request = { url: String(input), init };
      return Response.json({ schemaVersion: 1, lang: "pl", themeMode: "light", accentTheme: "teal", revision: 1 });
    }) as typeof fetch;
    try {
      await api.accountPreferencesPatch("user-a", { lang: "pl" });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(request?.url).toBe("/api/preferences/account");
    expect(request?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(request?.init?.body))).toEqual({ userId: "user-a", patch: { lang: "pl" } });
  });
});

describe("screenshot recognition API client", () => {
  it("uses the versioned operator and vaulted-BYOK recognition routes", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ rows: [], proposals: [] });
    }) as typeof fetch;
    try {
      await api.importExtract("11111111-1111-1111-1111-111111111111", ["data:image/png;base64,AA=="], "pl");
      await api.byokImportExtract(
        "22222222-2222-2222-2222-222222222222",
        "gpt-5.6-luna",
        "11111111-1111-1111-1111-111111111111",
        ["data:image/png;base64,AA=="],
        "pl",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests.map((request) => request.url)).toEqual(["/api/import/recognize", "/api/ai/byok/import/recognize"]);
    expect(requests[0]!.body).toMatchObject({ accountId: "11111111-1111-1111-1111-111111111111" });
    expect(requests[1]!.body).toMatchObject({
      budgetId: "22222222-2222-2222-2222-222222222222",
      accountId: "11111111-1111-1111-1111-111111111111",
    });
  });
});

describe("durable import job API client", () => {
  it("uses the job collection and tenant-asserted mutation routes", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      return Response.json(url === "/api/import/jobs" && (init?.method ?? "GET") === "GET" ? [IMPORT_JOB_SUMMARY] : IMPORT_JOB);
    }) as typeof fetch;
    const id = "11111111-1111-4111-8111-111111111111";
    const budgetId = "22222222-2222-4222-8222-222222222222";
    const accountId = "33333333-3333-4333-8333-333333333333";
    try {
      await api.importJobs.create({ id, budgetId, accountId, locale: "pl-PL", images: ["data:image/png;base64,iVBORw0KGgo="] });
      await api.importJobs.list();
      await api.importJobs.get(id);
      await api.importJobs.cancel(id, budgetId);
      await api.importJobs.retry(id, budgetId);
      await api.importJobs.complete(id, { budgetId, appliedCount: 2, skippedCount: 1 });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests.map(({ url, method }) => [method, url])).toEqual([
      ["POST", "/api/import/jobs"],
      ["GET", "/api/import/jobs"],
      ["GET", `/api/import/jobs/${id}`],
      ["POST", `/api/import/jobs/${id}/cancel`],
      ["POST", `/api/import/jobs/${id}/retry`],
      ["POST", `/api/import/jobs/${id}/complete`],
    ]);
    expect(requests.slice(3).map((request) => request.body)).toEqual([{ budgetId }, { budgetId }, { budgetId, appliedCount: 2, skippedCount: 1 }]);
  });

  it("rejects a wire detail whose lifecycle fields contradict each other", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ ...IMPORT_JOB, status: "ready", phase: "ready", result: null })) as typeof fetch;
    try {
      await expect(api.importJobs.get(IMPORT_JOB.id)).rejects.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("apiErrorMessage", () => {
  // no localStorage in the test env → uiLang() falls back to the browser language (en), and English
  // IS the message: the expected sentence below is literally the key lib/api.ts maps the code to.
  it("turns a server error code into a localized sentence", () => {
    expect(apiErrorMessage(httpError(503, { error: "ai_unavailable" }))).toBe(
      "The server has no OpenAI key configured — server mode is unavailable. Use an existing own key or keep AI on rules.",
    );
    expect(apiErrorMessage(httpError(502, { error: "ai_upstream_error", status: 401 }))).toBe(
      "OpenAI rejected the request — check the key and the model, then try again.",
    );
    expect(apiErrorMessage(httpError(400, { error: "backup_invalid", detail: "ledger: Required" }))).toBe(
      "This is not a valid backup file — nothing was loaded.",
    );
    expect(apiErrorMessage(httpError(400, { error: "foreign_ref" }))).toBe(
      "The data references records that do not exist here (a corrupted or foreign file). Nothing was changed.",
    );
    expect(apiErrorMessage(httpError(409, { error: "budget_mismatch", budgetId: "b1" }))).toBe(
      "The signed-in account changed while the data was being sent — nothing was written. Reload the app and try again.",
    );
    expect(apiErrorMessage(httpError(409, { error: "credential_move_required", budgetId: "b1" }))).toBe(
      "Re-enter your OpenAI API key so it can move into the encrypted budget.",
    );
    expect(apiErrorMessage(httpError(409, { error: "credential_move_invalid", budgetId: "b1" }))).toBe(
      "The OpenAI key changed on another device. Refresh its status and try again.",
    );
  });

  it("localizes the client-side foreign_replica sentinel (thrown bare by the multi-tenant guard)", () => {
    expect(apiErrorMessage(new Error("foreign_replica"))).toBe(
      "This device's local copy could not be confirmed to belong to the signed-in account — nothing was sent to the server. Settings → Sync explains what happened and what you can do.",
    );
  });

  it("does not expose sign-out control codes as UI copy", () => {
    expect(apiErrorMessage(new Error("server_sign_out_failed"))).toBe("The server session could not be ended. You are still signed in — try again.");
    expect(apiErrorMessage(new Error("sign_out_in_progress"))).toBe("Sign-out is already in progress.");
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
  const CLIENT_CODES: Record<string, Message> = {
    no_local_replica: "The local copy of the budget has not loaded yet — nothing was sent. Reload the app and try again.", // sync.ts — pushLocalToServer/resetServerE2ee, mirror not booted
    no_encryption_key: "This device has no encryption key — unlock the budget with your password (or a pairing code) and try again.", // sync.ts — resetServerE2ee with no DEK on this device
    empty_unbound_replica: "There is no data on this device to send — nothing was sent to the server. Reload the app to fetch your budget first.", // sync.ts — refused: it could only wipe the budget
    bad_ciphertext: "The encrypted data could not be read on this device — nothing was changed. Make sure the app is up to date, or restore from a backup.", // crypto.ts — an envelope this build cannot read
    bad_pairing_code: "This is not a valid pairing code — copy it again from the device where the budget is already unlocked.", // crypto.ts — decodePairing on a code that is not ours
    legacy_ciphertext:
      "This data uses an older encryption format that this version no longer reads — run the encryption upgrade in Settings → Privacy on the device that holds the budget.", // crypto.ts — a pre-AAD "v1." value reached a normal decrypt (fail-closed by design)
    ai_consent_required: "AI is not configured. Choose server AI or an existing own key in Settings → Artificial intelligence.", // ai.ts — AiConsentRequired: no usable model on this device
    ai_offline: "You are offline — screenshot import needs a connection. Manual entry works without one.", // openai.ts — fetch never left the device (offline PWA)
    ai_key_invalid: "OpenAI rejected your key — check it in Settings → Artificial intelligence.", // openai.ts — byok: OpenAI rejected the user's key (401/403)
  };

  it("localizes every code lib/* throws (Settings → backup import and Unlock)", () => {
    for (const [code, message] of Object.entries(CLIENT_CODES)) {
      expect(apiErrorMessage(new Error(code))).toBe(message); // in English the message IS the answer
      expect(message).not.toBe(code); // mapped, not the raw code falling through
    }
  });

  it("carries a sentence in Polish too — an untranslated code would show a stranger English prose", () => {
    for (const message of Object.values(CLIENT_CODES)) {
      expect(pl[message]).toBeTruthy();
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
    "e2ee: replica names no budget", // v2 fail-closed push/pull without an op AAD context — cycle error, never rendered
  ]);

  const LIB_DIR = fileURLToPath(new URL(".", import.meta.url)); // this file's dir (portable, TS-clean)

  // ai.ts joined the scan after AiConsentRequired shipped with the message "ai consent required":
  // a custom Error subclass hides its message in super(...), which the `new Error("…")` pattern
  // never saw — so the prose reached the Add screen's error line verbatim. Both shapes are scanned.
  // openai.ts joined it after `throw new Error(\`OpenAI ${res.status}\`)` printed "OpenAI 503" in a
  // Polish UI: screenshot import is AI-only, so the model transport's errors stopped being
  // swallowed by a rules fallback and became text a user reads.
  //
  // The sync engine is ONE unit split across lib/sync.ts + lib/sync/*.ts (workflow §3c-3), all of
  // it reachable through the facade — so its entry lists the whole directory: moving a throw into
  // a submodule must not move it out of this gate (that is exactly what the split would otherwise
  // have done to no_local_replica/no_encryption_key/empty_unbound_replica & co. in transport.ts).
  const SYNC_ENGINE_SOURCES = [
    "sync.ts",
    ...readdirSync(join(LIB_DIR, "sync"))
      .filter((f) => f.endsWith(".ts") && !f.includes(".test"))
      .map((f) => `sync/${f}`),
  ];
  const SCANNED: Array<[label: string, files: string[]]> = [
    ["sync engine (sync.ts + sync/*.ts)", SYNC_ENGINE_SOURCES],
    ["crypto.ts", ["crypto.ts"]],
    ["ai.ts", ["ai.ts"]],
    ["openai.ts", ["openai.ts"]],
  ];
  for (const [label, files] of SCANNED) {
    it(`${label} throws codes, not sentences`, () => {
      const src = files.map((f) => readFileSync(join(LIB_DIR, f), "utf8")).join("\n");
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

  /**
   * The scan above is blind to `new Error(\`…\`)` — and that is exactly the shape the "OpenAI 503"
   * regression wore. sync.ts is allowed its technical status lines (they end up in the sync state,
   * and apiErrorMessage digs the {error} out of them); the AI path is NOT: everything it throws is
   * rendered verbatim in the Add screen's error line, so no interpolation may leave these two files.
   */
  for (const file of ["ai.ts", "openai.ts"]) {
    it(`${file} throws no template literals (an interpolated status is prose on screen)`, () => {
      const src = readFileSync(join(LIB_DIR, file), "utf8");
      expect(src).not.toMatch(/(?:new Error|super)\(\s*`/);
    });
  }
});
