# Contributing to Enveo

Thanks for your interest! Enveo is young and moving fast — before starting
anything larger than a small fix, please open an issue to discuss it first.

## Development setup

See [README](README.md) for the quick start. In short:

```bash
bun install
docker compose up -d db
cd packages/api && bun run db:migrate && bun run db:seed   # demo data, dev only
make dev-api    # API on :8080
make dev-web    # Vite on :5173
```

## Ground rules

- **English everywhere**: code, comments, tests, commit messages.
- **Conventional Commits** with scope: `feat(api): …`, `fix(web): …`, `chore: …`.
- **Tests must pass**: `bun test packages/shared packages/api packages/web/src/lib`
  and `bun run build:web`. CI runs the same gates.
- Amounts are integer minor units — never floats. Balances are derived from the
  ledger — never add a stored balance column.
- New mutation ops need full parity: zod schema (`shared/ops.ts`) + `applyOp`
  reducer + server push handler + replay/idempotency tests.
- UI strings go through `t()` (add keys to all locales); money through
  `M()`/`formatMoney`.
- Read `AGENTS.md` for architecture, invariants, and known pitfalls before
  diving in — it will save you time.

## Reporting bugs

Include: app version (Settings → About), how you host it (Docker/compose,
reverse proxy), browser/OS, and steps to reproduce. For sync issues, note
whether the budget is plain or E2EE.

## Security

Please report security issues privately via GitHub Security Advisories
(Security tab → Report a vulnerability) rather than public issues.
