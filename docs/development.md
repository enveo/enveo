# Developing Enveo

## Toolchain

Enveo pins **one** Bun version, **Bun 1.3.14**, and uses it everywhere: your machine, CI, the
weekly audit workflow, `@types/bun` and every Docker stage. The image uses two *variants* of
that one version — Debian to build the PWA (native toolchain) and Alpine to run the API (a
pure-JavaScript dependency closure, and a far smaller CVE surface) — each pinned to its own
immutable `@sha256:` digest. `.bun-version` is the single source of truth and
`scripts/lib/bunVersion.test.ts` fails `bun run test` the moment any of those disagree —
`bun audit --json` output is parsed against a known shape and the published image must run the
runtime the gate actually exercised.

Install it with `curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"`, or let a version
manager read `.bun-version`. Upgrading Bun is a deliberate PR that moves the version, **both**
base digests, `@types/bun` and the lockfile together, then reruns `bun run verify:ci`.

The development stack ([`docker-compose.yml`](../docker-compose.yml)) **builds
from source** — that is the only difference from the self-host quickstart.

```bash
cp .env.example .env    # set POSTGRES_PASSWORD and BETTER_AUTH_SECRET (openssl rand -hex 32)
make up                 # build + start db + app → http://127.0.0.1:8081
make logs               # follow logs; `make help` lists every target
```

[`scripts/deploy.sh`](../scripts/deploy.sh) does the same thing unattended on an
**Ubuntu/Debian** server you already administer: generate the two secrets into `.env` if they
are not there, build and start the stack, wait for `/api/health`. It configures **Enveo** and
nothing else — Docker Engine and its Compose v2 plugin are your responsibility, it installs
no packages, downloads nothing and never asks for root. If a prerequisite is missing it stops
before touching anything, with the official documentation link and its own exit code (2 no
`docker`, 3 no Compose v2, 4 daemon unreachable, 5 another tool missing). It does not
provision, update or harden the operating system, and it is not a substitute for doing so.

## Without Docker

`bun` auto-loads `.env` from its own working directory, not the repo root, and
the API's `dev` script always runs with `packages/api` as that directory — so
it never sees the root `.env`, and `BETTER_AUTH_SECRET` stays unset (the boot
aborts by design). Export the values into each shell before running anything
below:

```bash
bun install
docker compose up -d db                       # Postgres only
set -a; source .env; set +a
bun run db:migrate                            # stays at the repo root, unlike `cd packages/api`
# in two terminals, both from the repo root (repeat the `source .env` line above in each):
make dev-api                                  # API on :8080
make dev-web                                  # Vite on :5173 (proxies /api -> :8080)
```

## Demo data

Dev only: create your account in the app first, then run `bun run db:seed` (in
the repo root, using the env already sourced above) — the demo dataset attaches
to the first registered user, so your account sees it after a reload. Never
point `make reset` / `db:seed` at data you care about.

## Tests

```bash
bun run verify        # the offline gate: types, lint, tests, build, source policies
bun run e2e           # browser smoke test on the built PWA — see CONTRIBUTING.md for the setup
```

Property tests guard the budget invariant, carry-over semantics, client↔server
FK-cascade parity, and outbox replay idempotency. Tests that exercise the
"no AI key" paths must run with `OPENAI_API_KEY=` explicitly emptied — bun
auto-loads `.env`, so a locally configured key can make them pass for the wrong
reason.

## Translations

A language is one file plus one registry line — see
[CONTRIBUTING.md](../CONTRIBUTING.md#add-a-language).
