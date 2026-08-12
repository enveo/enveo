/**
 * Security-middleware tests (origin-guard CSRF + CORS allowlist). They run
 * without a DB: a mutation with a foreign Origin gets a 403 BEFORE touching the
 * handler/database. The remaining cases (no Origin / allowlisted / GET / health)
 * only check that the guard does NOT return 403 — a further validation/DB error
 * (400/404/500) is OK.
 *
 * The default test env has an empty WEB_DIST → the allowlist contains http://localhost:5173.
 */
import { describe, expect, it } from "bun:test";
import app from "./index";

const EVIL = "https://evil.example";
const ALLOWED = "http://localhost:5173";

function post(path: string, origin?: string, body = "{}") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin) headers.origin = origin;
  return app.fetch(new Request(`http://localhost${path}`, { method: "POST", headers, body }));
}

function get(path: string, origin?: string) {
  const headers: Record<string, string> = {};
  if (origin) headers.origin = origin;
  return app.fetch(new Request(`http://localhost${path}`, { method: "GET", headers }));
}

describe("origin-guard (CSRF)", () => {
  it("POST with a foreign Origin → 403 bad_origin (before the handler, no DB)", async () => {
    const res = await post("/api/sync/replace", EVIL);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "bad_origin" });
  });

  it("POST without Origin (native/curl) → non-403 (the guard lets it through)", async () => {
    const res = await post("/api/sync/replace");
    expect(res.status).not.toBe(403);
  });

  it("POST with an allowlisted Origin (localhost:5173) → non-403", async () => {
    const res = await post("/api/sync/replace", ALLOWED);
    expect(res.status).not.toBe(403);
  });

  it("POST same-origin (Origin.host == request Host) → non-403 (PWA sync)", async () => {
    // a real browser always attaches Host; a synthetic Request does not, so explicitly.
    const res = await app.fetch(
      new Request("http://enveo.example/api/sync/replace", {
        method: "POST",
        headers: { origin: "http://enveo.example", host: "enveo.example", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).not.toBe(403);
  });

  it("GET /api/state with a foreign Origin → non-403 (the guard skips GET)", async () => {
    const res = await get("/api/state", EVIL);
    expect(res.status).not.toBe(403);
  });

  it("POST /api/health with a foreign Origin → non-403 (health skipped)", async () => {
    const res = await post("/api/health", EVIL);
    expect(res.status).not.toBe(403);
  });

  // The generic onError 500 case is deliberately omitted: without a live DB there is
  // no environment-independent way to deterministically force an exception in a handler.
});

describe("better-auth trusted origins (login CSRF)", () => {
  // better-auth validates browser auth POSTs against ITS OWN trustedOrigins,
  // not the app origin-guard above (which skips /api/auth/*). These run the
  // REAL better-auth check: auth.ts sets advanced.disableOriginCheck: false,
  // because better-auth silently disables the check under NODE_ENV=test —
  // the exact gap that let a baseURL-only trust list pass unit tests while
  // 403-ing every real browser whose origin differed from BETTER_AUTH_URL.
  // Origin validation rejects BEFORE the handler → no DB needed for the 403;
  // the non-403 cases may hit the DB and fail later (401/500), which is fine.
  function signIn(headers: Record<string, string>, host = "localhost") {
    return app.fetch(
      new Request(`http://${host}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", host, ...headers },
        body: JSON.stringify({ email: "a@example.com", password: "password123" }),
      }),
    );
  }

  it("foreign Origin → 403 (better-auth INVALID_ORIGIN)", async () => {
    const res = await signIn({ origin: EVIL, "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" });
    expect(res.status).toBe(403);
  });

  it("same-host Origin (host ≠ BETTER_AUTH_URL, e.g. LAN IP) → non-403", async () => {
    const res = await signIn({ origin: "http://192.168.1.7:8081", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" }, "192.168.1.7:8081");
    expect(res.status).not.toBe(403);
  });

  it("allowlisted origin (dev vite) on a different host → non-403", async () => {
    const res = await signIn({ origin: ALLOWED, "sec-fetch-site": "same-site", "sec-fetch-mode": "cors" });
    expect(res.status).not.toBe(403);
  });
});
