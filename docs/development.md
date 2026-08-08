# Developing Enveo

The development stack ([`docker-compose.yml`](../docker-compose.yml)) **builds
from source** — that is the only difference from the self-host quickstart.

```bash
cp .env.example .env    # set POSTGRES_PASSWORD and BETTER_AUTH_SECRET (openssl rand -hex 32)
make up                 # build + start db + app → http://127.0.0.1:8081
make logs               # follow logs; `make help` lists every target
```

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
bun test packages/shared packages/api packages/web/src/lib
```

Property tests guard the budget invariant, carry-over semantics, client↔server
FK-cascade parity, and outbox replay idempotency. Tests that exercise the
"no AI key" paths must run with `OPENAI_API_KEY=` explicitly emptied — bun
auto-loads `.env`, so a locally configured key can make them pass for the wrong
reason.

## Translations

A language is one file plus one registry line — see
[CONTRIBUTING.md](../CONTRIBUTING.md#add-a-language).
