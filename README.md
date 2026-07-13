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

## One-click deploy (Railway)

No server of your own? Deploy Enveo plus a managed Postgres on
[Railway](https://railway.com):

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https://github.com/enveo/enveo)

<!-- TODO(maintainer): this button points at Railway's repo-composer form, which starts a
     project from this repo but does NOT pre-wire Postgres or generate a session secret.
     After publishing the template (Railway → Project Settings → Generate Template from
     Project → Publish), replace the link above with the published template code:
       https://railway.com/new/template/<CODE>?utm_medium=integration&utm_source=button&utm_campaign=generic
     Steps: docs/hosting.md → "Publishing the one-click template". -->

The repo carries the Railway config ([`railway.json`](railway.json): Dockerfile build,
health check on `/api/health`, restart on failure). Add a **Postgres** service and set:

- `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
- `BETTER_AUTH_SECRET` = 32+ chars (`openssl rand -hex 32`) — the API refuses to boot without it
- `BETTER_AUTH_URL` = `https://${{RAILWAY_PUBLIC_DOMAIN}}` — recommended: it makes the
  session cookie `Secure` and fixes Google OAuth redirects

Leave `PORT` unset — Railway injects it and the app listens on it.

Full walkthrough (and what it would take to get Enveo listed on PikaPods):
**[docs/hosting.md](docs/hosting.md)**.

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

2.0 makes accounts mandatory. A 1.x database has no *credentialed* account — only a
password-less stub user (`owner@example.com` on a standard install) that already owns
your budget — so the instance presents as first-run.

**Do not register a new account.** Give the existing stub user a password instead: it
already owns your ledger, so signing in as that user is the whole upgrade — no SQL, no
reattachment, no window in which your devices see a foreign budget.

**1. Back up — this is your roll-back-to-1.x point.** Take it BEFORE you touch `.env`
and BEFORE you rebuild: the next start runs migrations `0014`/`0015` against this
database (`0014` drops the `sync_ops` primary key), and after that the dump is no
longer a 1.x database.

```bash
docker compose exec -T db pg_dump -U enveo enveo | gzip > pre-2.0-backup.sql.gz
gzip -t pre-2.0-backup.sql.gz     # the archive must be intact; no output = fine
```

**2. Add the session secret and rebuild:** put `BETTER_AUTH_SECRET=…`
(`openssl rand -hex 32`) into `.env`, then `make rebuild` (migrations run on start).

**3. Give the pre-2.0 owner a password, then sign in as them:**

```bash
docker compose exec db psql -U enveo -d enveo -c 'SELECT id, email FROM users;'   # usually one row: owner@example.com
docker compose exec app sh -c 'cd packages/api && bun run auth:reset-password owner@example.com "YourNewPassword"'
```

The CLI creates the credential account this user never had (that is exactly the
Google-only/no-password case it handles), so registration **closes** and the login
screen switches to sign-in. Sign in with that e-mail and the password you just set:
your budget is already attached to that account, and every device keeps syncing against
it.

#### If you already registered a NEW account

Then you have two users, and the new one owns an **empty** budget created lazily on its
first request; the real budget is still on the stub user. Either sign in as the stub
user anyway (step 3 above — the extra account is harmless), or reattach the budget:

> **Stop the app first.** An account with no budget gets an empty one created *lazily,
> by any request* — including the background pull every signed-in device fires once a
> minute. With the app running, such a request can land in the middle of the SQL below
> and re-create a stray empty budget; the account then owns **two**, and the server
> picks one of them by id — possibly the empty one, which hides your real budget.

```bash
docker compose stop app                          # no requests while you work
docker compose exec db psql -U enveo -d enveo    # SQL below
```

```sql
-- 1. Inventory. Write down the ids: the REAL budget is the one with your transaction
--    count, the STRAY is the empty one (0 transactions, named 'Budget') on the new user.
SELECT b.id, b.user_id, u.email, b.name,
       (SELECT count(*) FROM transactions t WHERE t.budget_id = b.id) AS transactions
FROM budgets b JOIN users u ON u.id = b.user_id;

-- 2. Reattach BY EXPLICIT ID — never by user_id, never by email. Deleting a budget
--    cascades to every transaction, envelope and allocation in it, and deleting a USER
--    cascades to their budgets (budgets.user_id → users.id ON DELETE CASCADE), so an
--    id-less DELETE that matches the wrong row destroys the ledger. Nothing here
--    touches `users`: the leftover stub user has no budget and no way to sign in — it
--    costs nothing, so leave it alone.
BEGIN;
DELETE FROM budgets WHERE id = '<stray-empty-budget-id>';
UPDATE budgets SET user_id = '<new-user-id>' WHERE id = '<real-budget-id>';

-- 3. Check INSIDE the transaction, before you commit: exactly ONE row must come back,
--    on '<new-user-id>', with your transaction count on it.
SELECT b.id, b.user_id, b.name,
       (SELECT count(*) FROM transactions t WHERE t.budget_id = b.id) AS transactions
FROM budgets b;

COMMIT;   -- anything unexpected in that check? ROLLBACK; and start over from step 1
```

Then `docker compose start app` and reload the app.

**Expected in the meantime:** until the budget is reattached, devices that already hold
your data report that their local copy **could not be matched to this account** and stop
syncing (while the app is stopped they simply see it as offline). That is the
multi-tenant guard doing its job — it refuses to push one account's ledger into another
account's budget. **Nothing is deleted**: the local data stays on the device, and sync
resumes by itself (within a minute, or on the next app focus) once the app is back up
with the budget reattached. Do not "remove the local data" on those devices while you
are mid-upgrade — on a device that has not synced in a while, that copy may be the
freshest one.

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
