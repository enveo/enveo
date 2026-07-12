import { serveStatic } from "hono/bun";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { ZodError } from "zod";
import { auth } from "./auth";
import { TierMismatch } from "./context";
import { env } from "./env";
import { crudRoutes } from "./routes/crud";
import { extraRoutes } from "./routes/extras";
import { importRoutes } from "./routes/import";
import { stateRoutes } from "./routes/state";
import { syncRoutes } from "./routes/sync";
import { sync2Routes } from "./routes/sync2";
import { txnRoutes } from "./routes/transactions";
import { budgetSuggestRoutes } from "./routes/budgetSuggest";
import { demoRoutes } from "./routes/demo";

const app = new Hono<{ Variables: { userId?: string } }>();

// gzip/deflate ALL responses (JSON API + web static assets). Critical for the
// first load: the replica snapshot (~3.3 MB JSON) and the JS bundle download
// ~7× smaller. The middleware skips already-compressed, HEAD and <1 KB. Must be
// OUTERMOST (before cors/routes) to wrap the final response.
app.use("*", compress());

// App origin allowlist: ALLOWED_ORIGINS (CSV) + origin from BETTER_AUTH_URL;
// in dev (no WEB_DIST) we append vite localhost:5173. Drives CORS + origin-guard.
const allowedOrigins = new Set<string>([
  ...env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
  ...(env.BETTER_AUTH_URL ? [new URL(env.BETTER_AUTH_URL).origin] : []),
  ...(env.WEB_DIST ? [] : ["http://localhost:5173"]), // dev
]);

// secure-headers + CSP. connect-src MUST include api.openai.com (BYOK mode calls
// OpenAI directly from the browser); style-src 'unsafe-inline' because inline
// styles + StyleInjector + QR generate styles on the fly.
app.use(
  "*",
  secureHeaders({
    xFrameOptions: "DENY",
    xContentTypeOptions: "nosniff",
    referrerPolicy: "same-origin",
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "https://api.openai.com"],
      workerSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
    },
  })
);

app.use(
  "/api/*",
  bodyLimit({
    maxSize: 16 * 1024 * 1024,
    onError: (c) => c.json({ error: "too_large" }, 413),
  })
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
  let sameOrigin = false;
  try { sameOrigin = new URL(origin).host === c.req.header("host"); } catch { /* malformed Origin → treat as foreign */ }
  if (!sameOrigin && !allowedOrigins.has(origin)) return c.json({ error: "bad_origin" }, 403);
  return next();
});

app.use("/api/*", cors({ origin: (o) => (allowedOrigins.has(o) ? o : "") }));

// AUTH_MODE=multi: better-auth handler + session middleware — MUST be
// mounted BEFORE the API routes. With AUTH_MODE=none `auth` is null and
// nothing changes (behavior identical to before auth was introduced).
if (auth) {
  const authApp = auth; // local const: TS does not narrow imports inside closures
  app.on(["POST", "GET"], "/api/auth/*", (c) => authApp.handler(c.req.raw));
  app.use("/api/*", async (c, next) => {
    if (c.req.path.startsWith("/api/auth/") || c.req.path === "/api/health") return next();
    const session = await authApp.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "unauthorized" }, 401);
    c.set("userId", session.user.id);
    return next();
  });
}

const api = new Hono();
api.get("/health", (c) => c.json({ ok: true }));
api.route("/", stateRoutes);
api.route("/", crudRoutes);
api.route("/", txnRoutes);
api.route("/", extraRoutes);
api.route("/", importRoutes);
api.route("/", syncRoutes);
api.route("/", sync2Routes);
api.route("/", budgetSuggestRoutes);
api.route("/", demoRoutes);
app.route("/api", api);

app.onError((err, c) => {
  if (err instanceof ZodError) {
    return c.json({ error: "validation", issues: err.issues }, 400);
  }
  // wrong tier for the route (v1 requires plain, sync2 e2ee) — client switches channel
  if (err instanceof TierMismatch) {
    return c.json({ error: "tier_mismatch", tier: err.meta.tier, epoch: err.meta.epoch }, 409);
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
