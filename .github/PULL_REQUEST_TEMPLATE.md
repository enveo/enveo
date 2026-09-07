## What & why

<!-- What does this change, and why? Link an issue if there is one. -->

## Checklist

- [ ] Code, comments, and commit messages are in English
- [ ] Commits follow [Conventional Commits](https://www.conventionalcommits.org/) with scope (`feat(api):`, `fix(web):`, `chore:`, …)
- [ ] `bun run verify` passes locally
- [ ] If the change is visible to users: `APP_VERSION` in `packages/web/src/lib/version.ts` was bumped
- [ ] If any user-facing copy changed: `bun run i18n:extract` was run (in `packages/web`) and the orphan report was checked
- [ ] If this changes architecture, invariants, or a known pitfall: `CLAUDE.md`/`AGENTS.md` was updated in the same PR
