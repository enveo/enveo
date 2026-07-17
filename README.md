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
- **AI is optional and off by default** (zero egress). The budget assistant works
  rule-based with no key at all; quick add and screenshot import need AI. Bring your
  own OpenAI key (BYOK, stays on your device) or configure a server key.
- **10 languages**: English, Polski, Deutsch, Español, Français, Italiano,
  Nederlands, Português (Brasil), Čeština, Svenska — the eight beyond EN/PL are
  community translations, and each is one file ([add yours](CONTRIBUTING.md#add-a-language)).
- **31 currencies**, one per budget (two-decimal only — the ledger stores integer
  minor units, so JPY/HUF/KWD and friends are deliberately not offered).
- Dark mode, four accent themes, installable on iOS/Android.

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

Forgot the password? There is no e-mail infrastructure on a self-hosted install — the
operator resets it on the server (see [Operating it](#operating-it)).

## Run it

Docker, an empty directory, two generated secrets. Nothing is compiled — this pulls the
published image.

<!-- TODO(maintainer): remove this note once a release tag has been pushed, the Release
     workflow has built the image, and the GHCR package is public (see docs/hosting.md). -->
> **Not published yet.** The `ghcr.io/enveo/enveo` image lands with the first version tag
> built and published by the [Release workflow](.github/workflows/release.yml) (see
> [docs/hosting.md](docs/hosting.md)). Until then `docker compose up -d` on the file below
> cannot pull it; build from source instead ([Develop it](#develop-it)).

```bash
mkdir enveo && cd enveo
curl -fsSL https://raw.githubusercontent.com/enveo/enveo/main/compose.selfhost.yml -o compose.yml
{ echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
  echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)"; } > .env
docker compose up -d
```

Open **http://localhost:8081** and create the **owner account** — do it now, not later:
registration is open until that account exists, so whoever reaches the app first becomes
the owner. It **closes** right after, and nobody who finds your URL can then sign
themselves up; to add a household member, put `ALLOW_SIGNUPS=1` in `.env`, `docker compose
up -d`, let them register, then remove it and repeat. The budget starts **empty** — the
in-app wizard sets it up.

The app is published on the **loopback interface only** (`127.0.0.1:8081`) — the machine
that runs it, nothing else on the network. Reaching it from another device is the HTTPS
step below, not `ENVEO_BIND=0.0.0.0`: a port open to a LAN (or, on a VPS, to the internet)
hands the owner account to the first stranger who finds it and sends session cookies in
the clear. Docker publishes ports through its own iptables rules, which **bypass
ufw/firewalld** — a host firewall does not undo this.

Both secrets are **required**: with either unset the stack refuses to start rather than
come up with a guessable one. Everything else is optional —
[`.env.selfhost.example`](.env.selfhost.example) documents the knobs (host port, bind
address, OpenAI key, Google sign-in, public URL). Migrations run automatically on start,
on every update.

> **HTTPS** — the way to use Enveo from your phone. Installing the PWA (and its offline
> service worker) needs a secure origin: `localhost` counts, a bare LAN IP or a
> plain-HTTP domain does not — and over plain HTTP the session cookie travels in the
> clear. Put Enveo behind TLS: a reverse proxy with a certificate, a tunnel, or a private
> mesh VPN that terminates HTTPS (e.g. Tailscale `serve`), pointed at the loopback port.
>
> Then **set `BETTER_AUTH_URL` to that `https://…` origin** in `.env` and `docker compose
> up -d`. This is not cosmetic: the session cookie is marked `Secure` only when
> `BETTER_AUTH_URL` is an `https://` URL. Leave the `http://localhost` default in place
> behind a proxy and you get a 90-day session cookie **without** `Secure` — a single
> plain-`http://` link to the same host leaks it. Sign-in keeps working either way, so
> nothing warns you.
>
> On iPhone: open the HTTPS URL in Safari → Share → **Add to Home Screen**.

## Deploy on Railway

No server of your own? [Railway](https://railway.com) runs the container and a managed
Postgres for you. There is **no one-click button yet** (it needs a published template —
see [docs/hosting.md](docs/hosting.md)), so the project is wired by hand, once:

<!-- TODO(maintainer): a "Deploy on Railway" button requires a PUBLISHED template code.
     The repo-composer form (/new/template?template=<repo-url>) is NOT a documented
     deploy-button URL and pre-wires neither Postgres nor a session secret — do not put it
     back. Once the template is published (docs/hosting.md → "Publishing the one-click
     template"), retitle this section and add:
       [![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/<CODE>?utm_medium=integration&utm_source=button&utm_campaign=generic) -->

1. **New Project → Deploy from GitHub repo** → `enveo/enveo`. The repo carries the Railway
   config ([`railway.json`](railway.json): Dockerfile build, health check on `/api/health`,
   restart on failure), so nothing else needs configuring on the build side.
2. **Add a Postgres service** to the same project.
3. On the Enveo service, set the variables:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `BETTER_AUTH_SECRET` = 32+ chars (`openssl rand -hex 32`) — the API refuses to boot without it
   - `BETTER_AUTH_URL` = `https://${{RAILWAY_PUBLIC_DOMAIN}}` — makes the session cookie
     `Secure` and fixes Google OAuth redirects
   - `DEPLOYMENT` = `selfhost` — registration closes after the owner account

   Leave `PORT` unset — Railway injects it and the app listens on it.
4. Generate a domain, check `/api/health` is green, open the app and create the **owner
   account** immediately (registration is open until it exists).

Steps 2 and 3 are not optional and they fail *quietly*: the image builds and the
migrations run, and only then does the server exit with `BETTER_AUTH_SECRET is required`
— a restart loop, not an error page.

Full walkthrough (and what it would take to get Enveo listed on PikaPods):
**[docs/hosting.md](docs/hosting.md)**.

## Operating it

Run these where your `compose.yml` lives.

```bash
# Update to the newest release (migrations run on start — back up first)
docker compose pull && docker compose up -d

# Back up: before every update, and on a schedule
docker compose exec -T db pg_dump -U enveo enveo | gzip > enveo-$(date +%F).sql.gz
gzip -t enveo-*.sql.gz                       # no output = the archive is intact

# Restore into an empty database
zcat enveo-2026-07-13.sql.gz | docker compose exec -T db psql -U enveo -d enveo

# Reset a forgotten password (there is no e-mail on a self-hosted install)
docker compose exec app bun run auth:reset-password you@example.com NewPassword1

# Logs
docker compose logs -f app
```

**Pin the version** once real data is in it: swap `:latest` in `compose.yml` for a
[release tag](https://github.com/enveo/enveo/releases) (e.g. `ghcr.io/enveo/enveo:2.3.2`),
so `docker compose pull` cannot carry you across a major version by surprise.

**Change the host port** with `ENVEO_PORT=9000` in `.env`, then `docker compose up -d`.
The app binds `127.0.0.1` unless you set `ENVEO_BIND=0.0.0.0` — read the warning in
[`.env.selfhost.example`](.env.selfhost.example) before you do; TLS in front of the
loopback port (above) is the better answer for phones. Postgres is deliberately **not**
published — it is reachable only from the app container.

## Develop it

The development stack ([`docker-compose.yml`](docker-compose.yml)) **builds from
source** — that is the only difference from the self-host file above.

```bash
cp .env.example .env    # set POSTGRES_PASSWORD and BETTER_AUTH_SECRET (openssl rand -hex 32)
make up                 # build + start db + app → http://127.0.0.1:8081
make logs               # follow logs; `make help` lists every target
```

Without Docker:

`bun` auto-loads `.env` from its own working directory, not the repo root, and the API's
`dev` script always runs with `packages/api` as that directory — so it never sees the
root `.env`, and `BETTER_AUTH_SECRET` stays unset (the boot aborts by design). Export the
values into each shell before running anything below:

```bash
bun install
docker compose up -d db                       # Postgres only
set -a; source .env; set +a
bun run db:migrate                            # stays at the repo root, unlike `cd packages/api`
# in two terminals, both from the repo root (repeat the `source .env` line above in each):
make dev-api                                  # API on :8080
make dev-web                                  # Vite on :5173 (proxies /api -> :8080)
```

Demo data (dev only): create your account in the app first, then run
`bun run db:seed` (in the repo root, using the env already sourced above) — the demo dataset
attaches to the first registered user, so your account sees it after a reload. Never point
`make reset` / `db:seed` at data you care about.

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

AI is **off by default** (zero egress), gated behind an explicit in-app consent. With
it off, the **budget assistant** still distributes "To Be Budgeted" **rule-based, with
zero dependencies** — no key, no network. **Quick add** (type "coffee 12.50 yesterday")
and **screenshot import** are LLM-only since 2.2.0: the rule parser behind quick add was
a table of Polish and English words, which could not be translated into the other eight
languages, so it is gone. With AI off the quick-add bar is therefore hidden and import
asks you to enable AI first — manual entry (pad + calculator) is untouched.

Enable it with an OpenAI key: server mode (`OPENAI_API_KEY` in `.env` — the key stays
on your server) or BYOK (the user's key, stored on their device, talking to OpenAI
directly). The model answers in the UI language.

## Tests

```bash
bun test packages/shared packages/api packages/web/src/lib
```

Property tests guard the budget invariant, carry-over semantics, client↔server
FK-cascade parity, and outbox replay idempotency.
