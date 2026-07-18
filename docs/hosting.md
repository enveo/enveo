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

Channels below split into two tiers, the way other self-hosted budgeting apps structure
their install docs:

- **Official** — channels this repo builds for and the maintainer keeps working: your
  own [`docker compose`](../README.md) install, [Railway](#railway), [Render](#render),
  and [PikaPods](#pikapods) (pending listing — see below). [Other platforms](#other-platforms)
  covers anything else that just runs a Dockerfile plus a Postgres add-on.
- **Community** — third-party app stores nobody on this project maintains, tests, or
  vouches for. Nothing is wired up yet. Umbrel and CasaOS are the most plausible future
  candidates: both define apps as a plain `docker-compose.yml` plus a manifest, which is
  the closest structural match to Enveo's own compose file of any platform surveyed — but
  CasaOS additionally requires pinned image tags (Enveo currently floats `:latest`), and
  neither has an open PR.

---

## Publishing the image (maintainer, one-time)

Everything below — and the README quickstart, and `compose.selfhost.yml` — pulls
`ghcr.io/enveo/enveo`. That image exists only once a **version tag** has been built by
[`.github/workflows/release.yml`](../.github/workflows/release.yml), and only becomes
pullable by strangers once the GHCR package is **public**. GHCR packages default to
**private**, and a private package fails `docker compose pull` with `denied` *even when
the repository is public* — so the visibility flip is a real step, not a formality.

The first *public* image is whichever version tag is newest at publication time —
**v2.3.2 or later** (check `git tag -l`); `v2.0.0` predates the workflow, so nothing was
ever built for it — do not offer it as a tag to pin. Steps, none of which can be
committed:

1. Push `main` and make **`github.com/enveo/enveo` public**.
2. Tag and push the release — the tag must MATCH `APP_VERSION` in
   `packages/web/src/lib/version.ts`, which is bumped by hand:
   `git tag vX.Y.Z && git push origin vX.Y.Z`. To re-publish an existing tag after a
   failed run, use the workflow's `workflow_dispatch` input instead.
3. Watch it: `gh run watch` — the arm64 leg is emulated and slow on a first run.
4. GHCR → the `enveo` package → **Package settings**: change visibility to **Public**, and
   enable **Inherit access from source repository**.
5. Verify from a logged-out machine (this is the check that catches step 4):

   ```bash
   docker logout ghcr.io
   docker pull ghcr.io/enveo/enveo:latest      # must succeed anonymously
   docker manifest inspect ghcr.io/enveo/enveo:2.3.2 | grep architecture   # amd64 + arm64
   ```

6. Drop the "Not published yet" note from the README (it is marked `TODO(maintainer)`).

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
| `OPENAI_API_KEY` / `OPENAI_MODEL` | optional | Only for server-mode AI; without it, budget suggestions fall back to local rules, and quick-add/screenshot import are AI-only and stay hidden. |

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

The README deliberately ships **no** "Deploy on Railway" button: the only deploy-button URL
Railway documents is `https://railway.com/new/template/<TEMPLATE_CODE>`, a code exists only
for a **published template**, and a template can only be generated from a project whose
services are linked to a **public** repository. (Do not substitute
`/new/template?template=<repo-url>` — that legacy repo-composer form is undocumented, and
even where it opens it wires up neither Postgres nor a session secret, so the deploy
migrates and then crash-loops on `BETTER_AUTH_SECRET is required`.) Publishing is UI-only —
it cannot be committed:

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
6. Deploy the published template **once, from its own page**, into a throwaway project —
   that is the first time the one-click path is executed end to end. It must come up
   healthy with a Postgres attached and a generated secret, and let you create the owner
   account. Then delete the throwaway project.
7. Only now add the button to the README (retitling the section, which currently states
   there is none) and drop the `TODO(maintainer)` comment beside it:

   ```md
   [![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/CODE?utm_medium=integration&utm_source=button&utm_campaign=generic)
   ```

Until then the README documents the manual path (steps 1–3 above), because that is the
only Railway path anyone has actually run. A published template is what makes it genuinely
one-click.

What publishing is worth: Railway pays a kickback on a published template — 15% of the
usage costs its deployments generate, rising to 25% for maintainers who actively answer
questions in the Template Queue. Payouts default to Railway credits; cashing out through
Stripe Connect needs a $100 minimum per withdrawal.

### Backups

Railway's Postgres has its own backup settings — turn them on. Note that Enveo is
local-first, so every signed-in device also holds a full replica of the ledger, and
Settings → Data exports JSON. Still: take a dump before a major upgrade.

---

## Render

[`render.yaml`](../render.yaml) at the repo root is Render's Blueprint spec — Render
detects it automatically on a repo connected via their GitHub app and provisions two
resources from one deploy: a `runtime: docker` web service built from this repo's
Dockerfile (health-checked at `/api/health`, `autoDeployTrigger: off` so a release stays
a deliberate tag rather than firing on every push to `main`) and a managed Postgres
instance. `DATABASE_URL` is wired from the database's `connectionString` automatically
(`fromDatabase`), `BETTER_AUTH_SECRET` is generated per deploy (`generateValue: true` —
the same idea as Railway's `secret()` template function, so no two installs share a
session secret), and `DEPLOYMENT=selfhost` is preset so registration closes after the
owner's first account.

The one manual step is the same rule Railway's section above explains: once the first
deploy is healthy, set `BETTER_AUTH_URL=https://<the onrender.com domain>` (or your custom
domain) on the service. It is not strictly required for e-mail+password login — better-auth
trusts whatever origin the request actually arrives on — but it does control the session
cookie's `Secure` attribute (which follows the `baseURL` scheme) and where Google OAuth
sends users back; leaving it unset yields a working but non-`Secure` cookie on Render's own
HTTPS domain.

Create the owner account the moment the deploy comes up healthy — `DEPLOYMENT=selfhost`
closes registration after that first account, so on a public deploy waiting risks a
stranger claiming it first. Render runs no revenue-share or marketplace program for
blueprints, unlike Railway's template kickback; it is listed here as an official channel
not because hosting is free (Render's plans are paid — the web service and the managed
Postgres both bill), but because the one-click deploy *button* costs this project nothing
to offer and maintain.

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
- **Database** — resolved: a pod is a single app container, and PikaPods runs a shared,
  managed Postgres/MySQL backend behind the scenes, injecting connection details into
  that container as `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASS`/`DB_NAME` (confirmed against
  their own `docker-moodle` image — no database process runs in the container itself).
  Enveo supports this natively since **2.3.2**: `env.ts` composes `DATABASE_URL` from
  those variables whenever `DATABASE_URL` itself is not set, so no re-architecture is
  needed to run there.

**How to apply:** PikaPods takes app requests on their
[feedback board](https://feedback.pikapods.com/) ("suggest or vote for it"), and
`hello@pikapods.com` is the direct route for maintainers. Their update policy is worth
knowing up front: they do not ship releases automatically — a release is tested in staging
first and must have been out for **at least 3 days** as a stable release. That means the
published image needs stable, immutable version tags (`2.3.2`), not just `latest`.

Two things are still unresolved and worth asking about in that same e-mail: PikaPods'
exact revenue-share percentage for a newly listed app (their public statements describe
existing partners like Actual Budget in general terms, not a rate card), and whether they
generate a per-pod app secret the way Railway's `secret()` template function does — Enveo
needs its own `BETTER_AUTH_SECRET` at first boot, so if PikaPods does not generate one,
the image needs an entrypoint that does.

---

## Other platforms

Anything that can run a Dockerfile plus a Postgres add-on works the same way: build the
image, give it `DATABASE_URL` and `BETTER_AUTH_SECRET`, let it listen on the injected
`$PORT`, health-check `/api/health`, and point `BETTER_AUTH_URL` at the public origin.
That is the whole contract (Fly.io, Coolify, Dokku, …).
