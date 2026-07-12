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

Default deployment has no login (`AUTH_MODE=none`) — intended for private
deployments behind a network perimeter (VPN / private network / localhost).
Optional multi-user mode (better-auth + Google) behind `AUTH_MODE=multi`.

## Quick start

```bash
cp .env.example .env          # set POSTGRES_PASSWORD
make up                       # builds the image, starts db + app (migrations run automatically)
# app: http://127.0.0.1:8081
make logs                     # follow logs
```

A fresh install starts with an **empty budget** — the in-app onboarding wizard
walks you through the initial setup. `make help` lists all commands.

### Development without Docker

```bash
bun install
docker compose up -d db                       # Postgres only
cd packages/api && bun run db:migrate         # (+ bun run db:seed = demo data, dev only)
# in two terminals:
make dev-api                                  # API on :8080
make dev-web                                  # Vite on :5173 (proxies /api -> :8080)
```

## Self-hosting notes

- The app listens on `127.0.0.1:8081` by default — put it behind your own HTTPS
  perimeter. A service worker (PWA install) requires HTTPS; a private mesh VPN
  with HTTPS certificates (e.g. Tailscale `serve`), a reverse proxy with TLS, or
  any tunnel works.
- **iPhone**: open the URL in Safari → Share → **Add to Home Screen**.
- Update: `git pull && make rebuild`. Migrations are additive and run on start.
- Back up Postgres (`pg_dump`) before upgrades. Never run `make reset`/`db:seed`
  against real data.

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
