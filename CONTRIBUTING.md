# Contributing to Enveo

Thanks for your interest! Enveo is young and moving fast — before starting
anything larger than a small fix, please open an issue to discuss it first.

## Development setup

See [README](README.md) for the quick start (including creating `.env`). Use **Bun 1.3.14** —
the version in `.bun-version`, which CI and the Docker image also use; a drift check in
`bun run test` enforces it. In short:

`bun` auto-loads `.env` from its own working directory, not the repo root, so export the
values into each shell before running anything below — otherwise `BETTER_AUTH_SECRET`
stays unset and the boot aborts by design:

```bash
bun install
docker compose up -d db
set -a; source .env; set +a
bun run db:migrate
# in two terminals, both from the repo root (repeat the `source .env` line above in each):
make dev-api    # API on :8080
make dev-web    # Vite on :5173
```

After opening the app in your browser, create your account in the login screen.

**Optional demo data:** once your account is registered, run `bun run db:seed` (repo
root, using the env already sourced above) — the demo dataset attaches to the first
registered user, so your account sees it after a reload.

## Ground rules

- **English everywhere**: code, comments, tests, commit messages.
- **Conventional Commits** with scope: `feat(api): …`, `fix(web): …`, `chore: …`.
- **Verification must pass**: `bun run verify` (typecheck + tests + production
  build). It needs no network and no database, and it forces `OPENAI_API_KEY` and
  `TEST_DATABASE_URL` empty so an auto-loaded `.env` cannot change the result.
  CI runs `bun run verify:ci`, which adds the DB-backed suites and the dependency
  audit — see [Running the full gate](#running-the-full-gate).
- Amounts are integer minor units — never floats. Balances are derived from the
  ledger — never add a stored balance column.
- New mutation ops need full parity: zod schema (`shared/ops.ts`) + `applyOp`
  reducer + server push handler + replay/idempotency tests.
- UI strings go through `t()` — **the English sentence IS the key**; money through
  `M()`/`formatMoney`.
- Read `AGENTS.md` for architecture, invariants, and known pitfalls before
  diving in — it will save you time.

## Running the full gate

| Command | What it does |
|---|---|
| `bun run verify` | What you run before pushing: `typecheck` + `test` + `build`. Offline, no database. |
| `bun run test` | Shared, API, web-lib and tooling tests. Forces `OPENAI_API_KEY=""` and `TEST_DATABASE_URL=""`, so DB-backed groups skip. |
| `bun run test:db` | The same tests with the DB-backed groups **required** against a throwaway PostgreSQL. |
| `bun run typecheck` | Shared, API, web app, web tests and repository tooling. |
| `bun run build` | The production web/PWA build. |
| `bun run security:audit` | `bun audit` evaluated against `security/audit-policy.json`. |
| `bun run verify:ci` | What CI runs: `typecheck` + `test:db` + `build` + `security:audit`. |

The DB-backed suites migrate and **write**, so `test:db` refuses to start unless you
point it at a database you have explicitly acknowledged as disposable:

```bash
docker run -d --rm --name enveotest \
  -e POSTGRES_USER=enveo -e POSTGRES_PASSWORD=enveo -e POSTGRES_DB=enveotest \
  -p 127.0.0.1:5499:5432 postgres:16-alpine

TEST_DATABASE_URL=postgres://enveo:enveo@127.0.0.1:5499/enveotest \
ENVEO_TEST_DB_ACK=throwaway bun run test:db
```

Create a **fresh** container for this; the sentinel proves you meant it, not that the
data is expendable. The runner additionally refuses a `TEST_DATABASE_URL` that resolves
to the same `host:port/database` as `DATABASE_URL`, **and** one that resolves to the
application's own default target (`localhost:5432/enveo`) — that is where Enveo itself
connects when `DATABASE_URL` is unset, so it is a live database, never a throwaway.
`localhost`, `127.0.0.1` and `::1` count as the same host, and different credentials do
not make a different database.

`security:audit` fails on any critical/high advisory, and on any moderate/low one that
is not covered by an exact, unexpired entry in `security/audit-policy.json`. It fails
closed: an unreachable registry or unparseable output is a failure, never a pass. If a
new advisory blocks your unrelated PR, that is intended — fix the dependency or open the
policy discussion; do not weaken the gate.

## Add a language

A locale is **one file**. English is the source, so a translation can never break
the app: any message you leave out simply renders its English text.

1. Copy `packages/web/src/lib/i18n/locales/de.ts` to `<code>.ts` (a BCP-47 code —
   `pt-BR`, `sv`, …) and rename the exported const (no dashes: `pt-BR` → `ptBR`).
2. **Read `locales/GLOSSARY.md` first.** It fixes the budgeting vocabulary
   (envelope, available, to be budgeted, carry-over, …). Terminology drifting
   between screens is a worse bug than a clumsy sentence.
3. Translate the values. The keys are English sentences — **never edit a key**.
   Keep `{n}`/`{name}` placeholders verbatim, keep `**bold**` markers, and let
   money/dates/numbers come from `Intl` (never hardcode a currency symbol).
   Plural entries are objects keyed by CLDR category; the categories your language
   needs are computed, not guessed:
   `new Intl.PluralRules("cs").resolvedOptions().pluralCategories`.
   **Watch the short keys.** A one-word English message can be a verb OR a noun, and
   the dictionary shows it to you without its screen: `"Type {word} to confirm:"` is
   the imperative *type this word*, not the noun *kind*. When a key is too short to
   be sure, open the call site (`bun run i18n:ambiguity` lists every short message
   with its call sites) — and translate the whole sentence into YOUR word order, not
   English's.
4. Add **one line** to `locales/../registry.ts` (`community: true`) — the Settings
   picker and the lazy-loading are driven by that registry, so there is nothing
   else to wire up.
5. `bun run i18n:extract` (in `packages/web`), then
   `bun test packages/web/src/lib/i18n`. The tests report orphaned messages,
   incomplete plural categories and dropped `{placeholders}` by name.

Fixing an existing translation is welcome and needs no ceremony — open a PR.

> **For maintainers editing English copy:** changing an English string CHANGES ITS
> KEY, which silently orphans every translation of it. Run `bun run i18n:extract`
> and read the orphan report before shipping a copy change.
>
> Keep every message a WHOLE phrase. Gluing fragments together in JSX
> (`t("Type")` + `<b>{word}</b>` + `t(" to confirm:")`) forces English word order on
> every other language — German needs its separable prefix last ("Gib zur Bestätigung
> LOESCHEN **ein**:") — and hands the translator a bare word with no context. Use one
> message with a `{placeholder}`; the test suite rejects fragments outright.

## Reporting bugs

Include: app version (Settings → About), how you host it (Docker/compose,
reverse proxy), browser/OS, and steps to reproduce. For sync issues, note
whether the budget is plain or E2EE.

## Security

Please report security issues privately via GitHub Security Advisories
(Security tab → Report a vulnerability) rather than public issues. See
[SECURITY.md](SECURITY.md) for the full policy.
