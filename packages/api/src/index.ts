import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { ZodError } from "zod";
import { loadVaultMasterKeyProvider } from "./aiCredentials/keyProvider";
import { assertAiSpendEnv } from "./aiSpend/transport";
import { auth, hasCredentialedUser } from "./auth";
import { authMetaBody } from "./authPolicy";
import { TierMismatch } from "./context";
import { assertAuthEnv, assertDbEnv, env } from "./env";
import { isSameHostOrigin, staticAllowedOrigins } from "./origins";
import { createAiCredentialRoutes } from "./routes/aiCredentials";
import { budgetSuggestRoutes } from "./routes/budgetSuggest";
import { crudRoutes } from "./routes/crud";
import { demoRoutes } from "./routes/demo";
import { extraRoutes } from "./routes/extras";
import { importRoutes } from "./routes/import";
import { preferencesRoutes } from "./routes/preferences";
import { stateRoutes } from "./routes/state";
import { syncRoutes } from "./routes/sync";
import { createSync2Routes } from "./routes/sync2";
import { txnRoutes } from "./routes/transactions";
import { AutomaticEnvelopeViolation, ScopeViolation } from "./sync/apply";

/** Loaded exactly once. `null` disables user BYOK only; ordinary budgeting still boots. */
export const vaultMasterKeyProvider = loadVaultMasterKeyProvider({
  nodeEnv: process.env.NODE_ENV ?? "development",
  filePath: env.AI_VAULT_KEY_RING_FILE,
  devKeyRingJson: env.ENVEO_DEV_AI_VAULT_KEY_RING_JSON,
});

// Fail fast on real boot (entrypoint run — dev, Docker CMD): accounts are
// mandatory (BETTER_AUTH_SECRET), and production needs explicit database config.
// Guarded by import.meta.main so the test suite can import the app without a
// configured secret (better-auth itself skips secret validation under NODE_ENV=test).
if (import.meta.main) {
  assertAuthEnv();
  assertDbEnv();
  // Cloud spend budget (backlog §1): an unpriced OPENAI_MODEL override cannot silently spend
  // at Luna's prices, and the safety-identifier secret must be dedicated (never the auth secret).
  assertAiSpendEnv();
}

const app = new Hono<{ Variables: { userId?: string } }>();

// gzip/deflate ALL responses (JSON API + web static assets). Critical for the
// first load: the replica snapshot (~3.3 MB JSON) and the JS bundle download
// ~7× smaller. The middleware skips already-compressed, HEAD and <1 KB. Must be
// OUTERMOST (before cors/routes) to wrap the final response.
app.use("*", compress());

// App origin allowlist: ALLOWED_ORIGINS (CSV) + origin from BETTER_AUTH_URL;
// in dev (no WEB_DIST) we append vite localhost:5173. Drives CORS + origin-guard,
// and (via origins.ts) better-auth's trustedOrigins — keep them in ONE place.
const allowedOrigins = staticAllowedOrigins();

// secure-headers + CSP. connect-src MUST include api.openai.com (BYOK mode calls
// OpenAI directly from the browser); style-src 'unsafe-inline' because inline
// styles + StyleInjector + QR generate styles on the fly.
// script-src carries 'wasm-unsafe-eval': the E2EE key derivation is Argon2id via
// hash-wasm, and current Chromium refuses WebAssembly.compile() under a bare
// 'self' — without it EVERY prod-served E2EE flow (enable, unlock, password
// change, the v1→v2 upgrade ceremony) dies at deriveKek. The directive allows
// WASM COMPILATION ONLY; JS eval()/new Function() stay blocked ('unsafe-eval'
// remains deliberately absent — the amount calculator stays eval-free).
app.use(
  "*",
  secureHeaders({
    xFrameOptions: "DENY",
    xContentTypeOptions: "nosniff",
    referrerPolicy: "same-origin",
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "https://api.openai.com"],
      workerSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
    },
  }),
);

app.use(
  "/api/*",
  bodyLimit({
    maxSize: 16 * 1024 * 1024,
    onError: (c) => c.json({ error: "too_large" }, 413),
  }),
);

// Origin-guard (CSRF): rejects mutations from a FOREIGN Origin. Same-origin is
// always safe — the app is served and queried from the same host (whatever the
// deployment origin is), so we compare Origin.host with the request Host and let
// it through when equal (this fixes PWA sync, whose origin cannot be known up
// front). Skips safe methods, better-auth and health; requests WITHOUT Origin
// (native/curl) pass — their perimeter is the private network (e.g. VPN).
app.use("/api/*", async (c, next) => {
  const m = c.req.method;
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();
  if (c.req.path.startsWith("/api/auth/") || c.req.path === "/api/health") return next();
  const origin = c.req.header("origin");
  if (!origin) return next();
  if (!isSameHostOrigin(origin, c.req.header("host")) && !allowedOrigins.has(origin)) {
    return c.json({ error: "bad_origin" }, 403);
  }
  return next();
});

app.use("/api/*", cors({ origin: (o) => (allowedOrigins.has(o) ? o : "") }));

// Accounts are always on: better-auth handler + session middleware — MUST be
// mounted BEFORE the API routes.
// Public: the login screen asks what to render. Must be registered BEFORE the
// better-auth wildcard — Hono matches in registration order.
app.get("/api/auth/meta", async (c) => {
  const hasUser = await hasCredentialedUser();
  return c.json(
    authMetaBody(
      { deployment: env.DEPLOYMENT, allowSignups: env.ALLOW_SIGNUPS, hasCredentialedUser: hasUser },
      Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    ),
  );
});
app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));
// Session middleware: protects ALL /api/* (including the AI proxy) except
// the auth endpoints themselves and the health check.
app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth/") || c.req.path === "/api/health") return next();
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: "unauthorized" }, 401);
  c.set("userId", session.user.id);
  return next();
});

const api = new Hono();
api.get("/health", (c) => c.json({ ok: true }));
api.route("/", stateRoutes);
api.route("/", crudRoutes);
api.route("/", txnRoutes);
api.route("/", extraRoutes);
api.route("/", importRoutes);
api.route("/", preferencesRoutes);
api.route("/", syncRoutes);
api.route("/", createSync2Routes({ masterKeys: vaultMasterKeyProvider }));
api.route("/", budgetSuggestRoutes);
api.route("/", createAiCredentialRoutes({ masterKeys: vaultMasterKeyProvider }));
api.route("/", demoRoutes);
app.route("/api", api);

app.onError((err, c) => {
  if (err instanceof ZodError) {
    return c.json({ error: "validation", issues: err.issues }, 400);
  }
  // wrong tier for the route (v1 requires plain, sync2 e2ee) — client switches channel
  if (err instanceof TierMismatch) {
    // cipherVersion rides along (round 3): an authoritative tier_mismatch is one of the ways a
    // device stuck on stale "format 1" meta re-learns that the budget is v2 now.
    return c.json({ error: "tier_mismatch", tier: err.meta.tier, epoch: err.meta.epoch, cipherVersion: err.meta.cipherVersion }, 409);
  }
  // cross-budget FK in a request body (REST/import/e2ee-disable restore paths;
  // push maps it per-op, /sync/replace maps it to its own 400 message)
  if (err instanceof ScopeViolation) {
    return c.json({ error: "foreign_ref" }, 400);
  }
  if (err instanceof AutomaticEnvelopeViolation) {
    return c.json({ error: err.code }, 409);
  }
  console.error(err);
  return c.json({ error: "internal" }, 500);
});

// Production: serve the built frontend + SPA fallback to index.html
if (env.WEB_DIST) {
  app.use("/*", serveStatic({ root: env.WEB_DIST }));
  app.notFound(async (c) => {
    if (c.req.path.startsWith("/api")) return c.json({ error: "not found" }, 404);
    const file = Bun.file(`${env.WEB_DIST}/index.html`);
    return new Response(file, { headers: { "content-type": "text/html; charset=utf-8" } });
  });
}

console.log(`Enveo API → http://localhost:${env.PORT}`);
export default { port: env.PORT, fetch: app.fetch };
