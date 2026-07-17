# Contributing to Enveo

Thanks for your interest! Enveo is young and moving fast — before starting
anything larger than a small fix, please open an issue to discuss it first.

## Development setup

See [README](README.md) for the quick start (including creating `.env`). In short:

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
- **Tests must pass**: `bun test packages/shared packages/api packages/web/src/lib`
  and `bun run build:web`. CI runs the same gates.
- Amounts are integer minor units — never floats. Balances are derived from the
  ledger — never add a stored balance column.
- New mutation ops need full parity: zod schema (`shared/ops.ts`) + `applyOp`
  reducer + server push handler + replay/idempotency tests.
- UI strings go through `t()` — **the English sentence IS the key**; money through
  `M()`/`formatMoney`.
- Read `AGENTS.md` for architecture, invariants, and known pitfalls before
  diving in — it will save you time.

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
