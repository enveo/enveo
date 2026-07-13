# Hosting Enveo on a managed platform

The supported way to run Enveo is `docker compose` on your own box (see the README).
This page covers **managed platforms**, where someone else runs the container and the
database for you.

Whatever the platform, three things are always true:

- **One container, one HTTP port.** The image serves the API *and* the built PWA, and
  listens on `$PORT` (default `8080`).
- **Postgres is required.** The container runs migrations on start (`migrate.ts && index.ts`);
  it needs `DATABASE_URL` before it can boot.
- **`BETTER_AUTH_SECRET` is required** (min 32 chars) — the API refuses to start without
  it, because accounts are mandatory.

---

## Railway

### What this repo ships

[`railway.json`](../railway.json) at the repo root — Railway's config-as-code. Railway
supports `railway.json` **or** `railway.toml`; this repo uses **JSON** because Railway
publishes a JSON Schema for it (`https://railway.com/railway.schema.json`), so editors
validate the file and a typo surfaces before a deploy rather than during one. TOML gets
no such validation.

```json
{
  "build":  { "builder": "DOCKERFILE", "dockerfilePath": "Dockerfile" },
  "deploy": { "healthcheckPath": "/api/health", "healthcheckTimeout": 300,
              "restartPolicyType": "ON_FAILURE", "restartPolicyMaxRetries": 10,
              "numReplicas": 1 }
}
```

Why each key:

- **`builder: DOCKERFILE`** — Railway auto-detects a root `Dockerfile`, but pinning it
  means a future change to Railway's build autodetection cannot silently switch us to
  Railpack/Nixpacks.
- **no `startCommand`** — the image's `CMD` already is
  `bun packages/api/src/db/migrate.ts && bun packages/api/src/index.ts` (migrations, then
  the server), and Railway runs the image's `CMD` when no start command is set. Repeating
  it here would only create a second copy to keep in sync.
- **`healthcheckPath: /api/health`** — the health route is deliberately exempt from the
  CSRF origin-guard *and* the session middleware, and it does not touch the database, so
  Railway's internal, cookie-less probe gets a clean `200 {"ok":true}`.
- **`restartPolicyType: ON_FAILURE`** — on the very first deploy the app can win the race
  against the Postgres service. `migrate.ts` then exits non-zero, and Railway restarts it
  until the database accepts connections. Without this, a fresh project can land in a
  failed state that looks like a broken image.
- **`numReplicas: 1`** — migrations run at container start, so one instance means one
  migrator. Enveo is local-first (each device holds the full ledger); one instance is
  plenty.

### Services

A Railway project for Enveo is two services:

1. **Enveo** — deployed from this repo (Dockerfile build).
2. **Postgres** — Railway's managed database.

### Variables

Set these on the **Enveo** service:

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Reference to the managed Postgres service. |
| `BETTER_AUTH_SECRET` | `${{secret(64, "abcdef0123456789")}}` | **Required**, min 32 chars. In a Railway *template*, `secret()` generates it per deploy, so no two installs share a session secret. Setting it by hand: `openssl rand -hex 32`. |
| `BETTER_AUTH_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` | Strongly recommended — see below. |
| `DEPLOYMENT` | `selfhost` | Registration closes after the first (owner) account. |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | optional | Only for server-mode AI; the app works rule-based without it. |

**Do not set `PORT`.** Railway provides and exposes a `PORT` for you *as long as you have
not defined one yourself*, and the app must listen on `0.0.0.0:$PORT`. Enveo does:
`env.ts` reads `process.env.PORT` (falling back to `8080`), and Bun binds all interfaces.
The `ENV PORT=8080` in the Dockerfile is only a default for `docker run`/compose — a
runtime environment variable, which is exactly how Railway injects `PORT`, overrides an
image `ENV`. (Railway ignores `EXPOSE`; it routes to `$PORT`.)

### About `BETTER_AUTH_URL` — the actual rule

It is **not** strictly required for e-mail + password login. better-auth validates the
`Origin` of credentialed POSTs against its own trusted-origins list, and
`packages/api/src/origins.ts` (`authTrustedOrigins`) adds the caller's own origin whenever
it matches the request `Host` — so sign-in works on whatever origin the app is actually
browsed on, Railway domain included.

Two things do depend on it, which is why you should still set it:

1. **The session cookie's `Secure` attribute follows the `baseURL` scheme.** This is
   asserted in `packages/api/src/auth.test.ts`: an `http://` base URL yields a cookie with
   no `Secure`, an `https://` one yields `Secure`. The default is `http://localhost:8080`,
   so leaving it unset on Railway's HTTPS domain issues a session cookie **without**
   `Secure`. Browsers still accept it over HTTPS (login works), but the cookie loses its
   HTTPS-only guarantee.
2. **Google OAuth redirect URIs are derived from it.** With the default, Google sends
   users back to `localhost`.

Setting `BETTER_AUTH_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}` fixes both and additionally
puts the public origin on the static allowlist, so login keeps working even if a proxy
ever rewrites `Host`. `RAILWAY_PUBLIC_DOMAIN` is populated once the service has a domain.
On a **custom domain**, point `BETTER_AUTH_URL` at that origin instead (or list it in
`ALLOWED_ORIGINS`).

### Publishing the one-click template (maintainer, Railway dashboard)

The "Deploy on Railway" button in the README needs a **template code**, and a template can
only be generated from a project whose services are linked to a **public** repository.
That part is UI-only — it cannot be committed:

1. Make `github.com/enveo/enveo` **public** (Railway cannot read a private repo).
2. In Railway: **New Project → Deploy from GitHub repo** → pick `enveo/enveo`; add a
   **Postgres** service to the same project.
3. Set the variables from the table above on the Enveo service, generate a domain, and
   confirm the deploy is healthy (`/api/health`, then create the owner account).
4. **Project Settings → Generate Template from Project.** In the template composer, keep
   the two services, and re-declare the variables — this is where `${{secret(64, …)}}`
   and `https://${{RAILWAY_PUBLIC_DOMAIN}}` belong, so every deploy of the template gets
   its own secret and correct base URL.
5. **Publish** the template (workspace → Templates → Publish). Only then does it get a
   template code and a marketplace listing (and OSS kickback eligibility).
6. Put the code into the README button:

   ```md
   [![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/CODE?utm_medium=integration&utm_source=button&utm_campaign=generic)
   ```

Until step 5 is done, the README button points at Railway's repo-composer form
(`/new/template?template=<repo-url>`), which starts a project from the repo but does
**not** pre-wire Postgres or generate the secret — the user has to add those by hand.
A published template is what makes it genuinely one-click.

### Backups

Railway's Postgres has its own backup settings — turn them on. Note that Enveo is
local-first, so every signed-in device also holds a full replica of the ledger, and
Settings → Data exports JSON. Still: take a dump before a major upgrade.

---

## PikaPods

[PikaPods](https://www.pikapods.com/) hosts open-source apps for a small monthly fee and
shares revenue with the projects it lists. Enveo is **not** listed there yet; this is what
it takes.

Their [stated criteria for adding an app](https://docs.pikapods.com/faq/apps) are that it
must:

- be a web application and **use one HTTPS port only**,
- not use large amounts of CPU or bandwidth by design,
- not have potential for abuse or impact on other pods,
- have a **license that allows self-hosting**,
- not compete with the author's own paid hosting service,
- have an **official (or semi-official) Docker image** available,
- be actively developed, with security issues addressed.

Where Enveo stands against that list:

- **One HTTP port** — yes: a single container serves the API and the PWA on `$PORT`.
- **License** — AGPL-3.0, self-hosting explicitly allowed.
- **Official image** — `ghcr.io/enveo/enveo`, published from this repo (multi-arch).
- **Active development, security fixes** — yes.
- **Open question: the database.** Enveo needs Postgres, and a pod is a single app
  container. Ask PikaPods how they provide a database for an app that requires one (some
  listed apps do run against Postgres) — this is the one thing to settle *before*
  applying, not after.

**How to apply:** PikaPods takes app requests on their
[feedback board](https://feedback.pikapods.com/) ("suggest or vote for it"), and
`hello@pikapods.com` is the direct route for maintainers. Their update policy is worth
knowing up front: they do not ship releases automatically — a release is tested in staging
first and must have been out for **at least 3 days** as a stable release. That means the
published image needs stable, immutable version tags (`2.0.0`), not just `latest`.

---

## Other platforms

Anything that can run a Dockerfile plus a Postgres add-on works the same way: build the
image, give it `DATABASE_URL` and `BETTER_AUTH_SECRET`, let it listen on the injected
`$PORT`, health-check `/api/health`, and point `BETTER_AUTH_URL` at the public origin.
That is the whole contract (Fly.io, Render, Coolify, Dokku, …).
