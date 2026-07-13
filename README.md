# Enveo

**Private, local-first envelope budgeting.** YNAB-style zero-based budgeting as a
mobile-first PWA (installable on iOS and Android), self-hosted with a single
`docker compose up`. Your ledger lives on your devices; the server is a thin,
optionally end-to-end-encrypted sync layer.

> Domain model: money physically sits in **accounts**; budgeting means distributing
> it into virtual **envelopes**. Invariant: `Σ(envelope available) + To Be Budgeted =
> Σ(on-budget account balances)`. Balances and "available" are **derived** from the
> transaction + allocation ledger — never stored.

## Features

- **Local-first**: the full ledger is replicated to IndexedDB; every screen works
  offline and syncs in the background (idempotent push by `opId`, cursor-based pull,
  snapshot recovery). Conflicts: last-write-wins per entity, delete wins.
- **Optional E2EE**: encrypted oplog sync — the server never sees plaintext.
- **Envelope budgeting done right**: negative balances carry over, transfers,
  refunds, split transactions, scheduled/recurring transactions, monthly goals.
- **Import from screenshots**: photograph or screenshot a bank statement, review,
  edit, dedupe — with a self-learning matcher that remembers your corrections.
- **Budget assistant**: distribute "To Be Budgeted" by rules or AI, fully editable
  before applying.
- **AI is optional and off by default** (zero egress). Rule-based fallbacks for
  everything; bring your own OpenAI key (BYOK, stays on your device) or configure
  a server key.
- **PL/EN**, dark mode, currency per budget.

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite + TypeScript, PWA (`vite-plugin-pwa`), TanStack Query |
| Backend | bun + Hono, REST, `zod` validation |
| ORM / DB | Drizzle ORM + PostgreSQL 16 (amounts in **minor units**, BIGINT) |
| Domain | `packages/shared` (`@enveo/shared`) — pure functions + property tests, shared by client and server |
| Runtime | Docker Compose (db + app); one image serves API and frontend |

## Accounts

An account is **mandatory** — there is no no-login mode. The first person to open
the app creates the **owner account** (e-mail + password; Google sign-in when
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are set), and registration **closes**
right after: a second sign-up is refused with `signups_closed`, enforced
server-side. Nobody who finds your URL can create themselves an account.

| Variable | Default | Meaning |
|---|---|---|
| `BETTER_AUTH_SECRET` | — | **Required** session secret (min 32 chars). `scripts/deploy.sh` generates one; by hand: `openssl rand -hex 32` |
| `DEPLOYMENT` | `selfhost` | `selfhost` closes registration after the first account; `cloud` keeps it open |
| `ALLOW_SIGNUPS` | unset | `1` reopens registration on `selfhost` (e.g. to add a family member) — remove it again afterwards |

Forgot the password? There is no e-mail infrastructure on a self-hosted install —
reset it on the server: `bun run auth:reset-password <email> <new-password>`
(inside the app container: `docker compose exec app sh -c 'cd packages/api && bun run auth:reset-password you@example.com NewPassword1'`).

## Quick start

```bash
cp .env.example .env          # set POSTGRES_PASSWORD and BETTER_AUTH_SECRET (openssl rand -hex 32)
make up                       # builds the image, starts db + app (migrations run automatically)
# app: http://127.0.0.1:8081  → create the owner account, then registration closes
make logs                     # follow logs
```

(`scripts/deploy.sh` does the same and generates both secrets for you.)

A fresh install starts with an **empty budget** — the in-app onboarding wizard
walks you through the initial setup. `make help` lists all commands.

### Development without Docker

```bash
bun install
docker compose up -d db                       # Postgres only
cd packages/api && bun run db:migrate
# in two terminals:
make dev-api                                  # API on :8080
make dev-web                                  # Vite on :5173 (proxies /api -> :8080)
```

Demo data (dev only): create your account in the app first, then
`cd packages/api && bun run db:seed` — the demo dataset is attached to the first
existing user, so your account sees it after a reload.

## Self-hosting notes

- The app listens on `127.0.0.1:8081` by default — put it behind your own HTTPS
  perimeter. A service worker (PWA install) requires HTTPS; a private mesh VPN
  with HTTPS certificates (e.g. Tailscale `serve`), a reverse proxy with TLS, or
  any tunnel works.
- **iPhone**: open the URL in Safari → Share → **Add to Home Screen**.
- Update: `git pull && make rebuild`. Migrations are additive and run on start.
- Back up Postgres (`pg_dump`) before upgrades. Never run `make reset`/`db:seed`
  against real data.

### Upgrading from 1.x

2.0 makes accounts mandatory. A 1.x database has no account, so the instance
presents as first-run: add `BETTER_AUTH_SECRET` to `.env` (`openssl rand -hex 32`),
rebuild, open the app and **create the owner account** — registration is open
because no credentialed account exists yet, and closes as soon as you finish.

Your existing budget is **not** attached to the new account yet. Reattach it with
SQL (take a `pg_dump` first), then reload the app:

```sql
-- the first API call after registration lazily created an EMPTY budget: drop it,
-- reattach the real budget to the new account, remove the pre-2.0 stub user
DELETE FROM budgets WHERE user_id = '<new-user-id>';
UPDATE budgets SET user_id = '<new-user-id>'
  WHERE user_id = (SELECT id FROM users WHERE email = 'owner@example.com');
DELETE FROM users WHERE email = 'owner@example.com';
```

Find `<new-user-id>` with `SELECT id FROM users WHERE email = '<your-signup-email>';`
and check the pre-2.0 stub's address with `SELECT id, email FROM users;` before
running the `UPDATE` (it is `owner@example.com` on a standard install).

**Expected in the meantime:** until the budget is reattached, devices that already
hold your data report that their local copy **could not be matched to this account**
and stop syncing. That is the multi-tenant guard doing its job — it refuses to push
one account's ledger into another account's budget. **Nothing is deleted**: the
local data stays on the device, and sync resumes by itself (within a minute, or on
the next app focus) once the SQL above has run. Do not "remove the local data" on
those devices while you are mid-upgrade.

Password reset (no e-mail infrastructure on selfhost):
`bun run auth:reset-password <email> <new-password>` on the server.

## AI (optional)

Smart quick-add, the budget assistant, and screenshot import all work
**rule-based with zero dependencies**. With AI enabled (OpenAI; server mode via
`OPENAI_API_KEY` in `.env`, or BYOK — the user's key stored on their device),
parsing and suggestions are LLM-enhanced with rule fallbacks. AI is **off by
default** (zero egress), gated behind an explicit in-app consent.

## Tests

```bash
bun test packages/shared packages/api packages/web/src/lib
```

Property tests guard the budget invariant, carry-over semantics, client↔server
FK-cascade parity, and outbox replay idempotency.
