# AGENTS.md — Enveo

## What this is
**Enveo** is a private, local-first envelope budgeting app (YNAB-style, zero-based), built as a mobile-first PWA with optional end-to-end encrypted sync and AI-assisted workflows. Amounts live in minor units, balances are derived from the ledger, and the client is the source of truth — the server is a sync and convenience layer.

## Stack & layout
Monorepo with bun workspaces (`packages/*`):
- **packages/shared** (`@enveo/shared`) — pure domain, zero I/O: `budget.ts` (ledger math), `applyOp.ts` (mutation reducers for the client replica), `stateResponse.ts`/`summary.ts`, `ops.ts` (zod op schemas), `quickadd.ts` (natural-language entry parsing), `aiBudget.ts` (budget suggestion engine), `aiPrompts.ts` (ALL AI prompt builders/parsers). This is the shared math for client and server — parity is guaranteed by running identical code on both sides.
- **packages/api** — bun + Hono + Drizzle + Postgres 16. `src/index.ts` mounts routes under `/api`; in production it also serves the built web app (SPA fallback). Migrations in `drizzle/` run on container start; the migrator orders by timestamp from `meta/_journal.json` — semantic changes always require a NEW migration file.
- **packages/web** — React 18 + Vite + TanStack Query, PWA (`vite-plugin-pwa`, registerType `prompt`). Local-first lives in `src/lib`: `store.ts`/`idb.ts` (ledger replica in IndexedDB), `outbox.ts`/`persist.ts`, `sync.ts` (push/pull/snapshot/replace), `mutate.ts` (`local.*` → applyOp + outbox), `version.ts`.

## Running locally
`bun` must be on PATH. Full stack via Docker:
1. `cp .env.example .env` and set `POSTGRES_PASSWORD` + `BETTER_AUTH_SECRET` (required — `openssl rand -hex 32`; `scripts/deploy.sh` generates both). Optionally `OPENAI_API_KEY` + `OPENAI_MODEL` for AI features.
2. `make up` (build + start; migrations run automatically). A fresh install has NO user and NO budget: the first visit creates the owner account, the first API call lazily creates an EMPTY budget, and the in-app onboarding wizard does the initial setup. `make logs`, `make down`.
3. Dev without Docker: `docker compose up -d db`, then run migrations with `DATABASE_URL` set, then `make dev-api` (API) + `make dev-web` (Vite). Vite listens on `::1` — open `localhost`, not `127.0.0.1`.

`db:seed` is a DEV-ONLY tool with an anonymized demo dataset. Never run it against data you care about. It ATTACHES the demo budget to the first existing user, so the dev/E2E flow is: register → `bun run db:seed` → the account sees the demo data. An empty start needs no tooling at all (fresh DB = empty budget → onboarding).

## Tests
- **Unit/property**: `bun test packages/shared packages/api packages/web/src/lib`. These guard the core invariant (§ Domain invariants), carry-over semantics, FK-cascade parity between client and server, and replay idempotency.
- **E2E**: drive a THROWAWAY stack only — fresh Postgres container, API with `WEB_DIST` pointing at the built web assets, headless Chromium via CDP. Never point E2E at a database you care about. Prefer prod-like serving (built assets, not the dev server): CSP and PWA behavior only show up there.
- Tests exercising "no AI key" paths must run with `OPENAI_API_KEY=` explicitly emptied — bun auto-loads `.env`, so a locally configured key can make such tests pass for the wrong reason.

## Domain invariants
- Amounts are ALWAYS integer minor units (never floats). `Transaction.amount` is a positive magnitude; direction comes from `type` (expense/income/transfer) + `isRefund`. `month` = 'YYYY-MM', `date` = 'YYYY-MM-DD'.
- Account balances and envelope "available" are DERIVED from the ledger (`computeBudgetState`/`stateResponse`) — never materialize a balance column (property tests will break).
- Core invariant: Σ(available) + toBeBudgeted = Σ(on-budget account balances). Carry-over: negative available carries into the next month as a negative carry-in (no floor at 0).
- Local-first: the UI boots from the IndexedDB replica; a write = applyOp on the mirror + outbox → sync push/pull. The server-side `changes` journal is driven by Postgres TRIGGERS (so imports and FK cascades are captured too), not by route handlers. Conflicts are LWW per entity, delete wins; recovery = snapshot resync. `applyOp` must mirror FK cascades faithfully or replay loses idempotency.
- New mutation ops require FULL parity: zod schema (`shared/ops.ts`) + `applyOp` reducer + server push handler (`api/routes/sync.ts`) + replay/idempotency tests. Mirror FK behavior from the REAL schema (e.g. `transactions.recurrence_id` is `set null`).
- E2EE: budgets have tier plain|e2ee + epoch; v1 data routes require plain, sync2 requires e2ee (409 tier_mismatch) — new data routes MUST call requireTier. Crypto lives ONLY in `web/lib/crypto.ts` (the server never encrypts). The client keeps the DEK in IDB meta; the outbox stays plaintext and encryption happens only at push time (pending ops survive tier flips). Any 409 tier_mismatch → hard engine re-bootstrap (update tier meta from the body, reset cursor, re-boot; missing DEK → Unlock screen).

### Multi-tenant guard (load-bearing — do NOT weaken)
Accounts are mandatory and sign-out KEEPS the replica, so one device can hold user A's ledger + A's queued ops while user B signs in. The session cookie is shared by every tab and can be swapped MID-CYCLE (a sign-out+sign-in in another tab; the long-lived tab never sees a 401). One cycle makes many server writes, and the server's FK guards only reject references to another budget's EXISTING rows — fresh creates would sail into B's budget. Hence three layers (`web/lib/sync.ts`, "Account identity of the replica"):
- **Stamp**: the replica is stamped with the session userId (IDB meta). Boot does not hand the replica to the UI until the stamp is compared (`bootOwnerOk`); every CYCLE re-reads the session (`ensureIdentity` — only a verdict for the SAME user id is reused; memoizing per page load is a BUG we already fixed).
- **Only a STAMP MISMATCH may wipe** — and even then only via the human (BootStatus `foreign` → ForeignReplicaScreen: export a backup / remove and continue). An UNSTAMPED replica whose ownership cannot be proven (`proveOwnership`) is UNPROVEN, not foreign: it refuses every server write (push, `/sync/replace`, `/sync2/reset`, e2ee enable/disable/rekey, checkpoint upload) and is NEVER destroyed. Nothing is destroyed unattended — the replica may be the last copy, and a user id does not survive a server rebuild.
- **Per-REQUEST tenant assertion on EVERY server write** (the authoritative layer — the client's check is one request older than the write): pushes NAME the budget they are for (`budgetAssertionFails`), the full-budget OVERWRITE routes NAME the user the client just verified (`ownerAssertionFails` — the tenant there is the USER, because a restore deliberately carries the BACKUP FILE's budgetId). Mismatch → 409 `{error:"budget_mismatch"}` BEFORE anything is written; the client re-proves and writes nothing. Any NEW write endpoint must carry one of these assertions.
- **PITFALL — `budgetId` is an EPOCH marker, not a tenant id**: lazy budget creation, wipe+reseed and a DB restore all mint a new one. It may NEVER be used alone to conclude "different account" (that false positive IS the 2.0 upgrade path: an unstamped 1.x replica of B_old vs. the freshly lazy-created empty B_new). A differing budgetId means "resync / cannot prove", not "foreign".

## AI features
- Provider: OpenAI (`OPENAI_API_KEY`/`OPENAI_MODEL`). No key → clean fallback to local rule engines.
- Prompts live ONLY in `shared/aiPrompts.ts` — server and BYOK build identical requests from the same code (parity guarded by prompt-identity tests).
- AI modes (`settings.aiMode`, per device): **off** (default; local rules, zero egress), **server** (operator key via the narrow OpenAI-mirror proxy `/api/ai/v1/chat/completions`), **byok** (user's key in device localStorage; requests go straight to OpenAI). In off/byok, suggestion/quick-add generation never touches `/api/*`; first use in off goes through the AI consent sheet.
- Structured output uses strict `json_schema` (object root — wrap arrays in `{items}`). `reasoning_effort` is gated by `supportsReasoningEffort` and the enum stops at `low` (some models reject `minimal`).

## Auth (accounts are MANDATORY — since 2.0)
- better-auth is ALWAYS instantiated (email+password always enabled; Google only when `GOOGLE_CLIENT_ID`/`SECRET` are set). There is no no-auth mode — `AUTH_MODE`/`DEV_LOGIN` no longer exist. `BETTER_AUTH_SECRET` (≥32 chars) is REQUIRED: `assertAuthEnv()` fails the boot without it.
- Deployment profiles: `DEPLOYMENT=selfhost` (default) closes registration once a credentialed user exists; `DEPLOYMENT=cloud` keeps it open; `ALLOW_SIGNUPS=1` reopens it on selfhost. The policy is the pure `signupsOpen()` (`api/src/authPolicy.ts`) and is enforced SERVER-SIDE in better-auth's user-create hook (403 `signups_closed`) — never in the UI. "Credentialed" = has an `auth_accounts` row, so a pre-2.0 stub owner still reads as first-run (that IS the upgrade path).
- The gate takes a Postgres ADVISORY LOCK (`pg_advisory_xact_lock`, one reserved connection via `sql.begin`) around check+create, so two concurrent first registrations cannot both become "the first account". Never move that check onto the pooled `db` — lock and unlock would land on different sessions.
- `GET /api/auth/meta` (public, `{signupsOpen, firstRun, providers}` — leak nothing else) tells the Login screen what to render. It MUST stay registered BEFORE the `/api/auth/*` wildcard: Hono matches in registration order.
- The session middleware protects ALL `/api/*` except `/api/auth/*` and `/api/health` (the AI proxy included). Budgets are lazily created per user (empty → onboarding wizard). E2E and tests sign up via `POST /api/auth/sign-up/email` (always available; the first sign-up on a fresh DB always succeeds).
- Lost password on selfhost (no email infra): `bun run auth:reset-password <email> <new-password>` on the server.
- Auth tables are `auth_sessions`/`auth_accounts`/`auth_verifications` (+ extended `users`) — do NOT confuse `auth_accounts` with the domain `accounts` table (bank accounts).

## Conventions
- Code, comments, tests, and commit messages in **English**. Conventional Commits with scope: `feat(api):`, `fix(web):`, `chore:`.
- UI strings go through `t()` with dictionaries in `lib/i18n.*` (add keys to ALL locales); money is formatted via `M()`/`formatMoney` — never hardcode a currency symbol in JSX.
- Colors: accent/danger/CTA are CSS variables; in SVG set them via `style` (presentation attributes don't resolve `var()`); use precomputed alpha variables — never string-concatenate alpha onto a color.

## Known pitfalls (hard-won — do not rediscover)
- `workbox-window` MUST be in `dependencies` of packages/web (pulled by `virtual:pwa-register`), or the frozen-lockfile Docker build fails.
- A CSS `transform` on an ancestor breaks `position: fixed` descendants. Sheets animate with transforms — render fixed overlays (pads, full-screen editors, nested pickers) via `createPortal(document.body)`.
- CSP is `script-src 'self'` (no unsafe-eval) — the amount calculator uses a hand-written arithmetic evaluator (`evalArith`); keep it eval-free.
- WebKit/iOS can drop hit-testing on a composited (transformed) layer after unmounting a full-screen fixed overlay above it — force a compositing rebuild after closing such overlays (see the opacity-kick pattern in ImportSheet).
- Reading DOM state (e.g. `aria-checked`) synchronously right after `.click()` observes the pre-render value — React batches; wait a tick in tests.
- PWA update detection is byte-based on `sw.js` (new asset hashes), not version-number based; `APP_VERSION` in `version.ts` is manual semver — bump it on every user-visible change. The update banner can't be tested against the dev server (SW off).
- `source_ref` (screenshot-import metadata) is not part of ClientLedger — it is lost on `/api/sync/replace` and JSON export (accepted loss).
- `.git` is in `.dockerignore` → `__BUILD_INFO__.sha` is empty in container builds (only the build timestamp shows).

## Pointers
- Specs and plans: `docs/` (if present). Machine-local environment/ops knowledge (deployment target, private network setup, backup paths) belongs in `CLAUDE.local.md` (gitignored) — never in this file.
