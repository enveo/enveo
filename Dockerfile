# Enveo — single image: API (Bun + Hono) serving the built frontend (Vite PWA).
#
# THREE stages, on purpose (§3e):
#   build   — full frozen install; Vite/TypeScript live here and NEVER leave this stage.
#   deps    — production dependency closure only, pruned to what the API can actually reach.
#   runtime — an explicit ALLOWLIST of files, owned by root, run as the unprivileged `bun` user.
#
# The old image was `COPY --from=build /app /app`: the whole build workspace, its dev
# dependencies and a root shell. Nothing here copies a directory the runtime does not execute.
#
# BUN VERSION. ONE exact version, pinned together with the multi-architecture manifest digest, in
# every stage. `.bun-version` is the single source of truth and `scripts/lib/bunVersion.test.ts`
# fails the build when this file, CI, `@types/bun` or the documentation drift apart. Both digests
# below are linux/amd64 + linux/arm64 indexes — bump version and digests together, never one
# alone, and rerun the whole gate.
#
# TWO BASES, deliberately:
#   build            → Debian (`oven/bun:1.3.14`). Vite's toolchain is native and glibc-linked
#                      (rollup, esbuild, sharp). None of it is copied forward.
#   deps + runtime   → Alpine (`oven/bun:1.3.14-alpine`). Alpine's OS surface is dramatically
#                      smaller: 0 CRITICAL / 2 HIGH versus Debian trixie's 4 CRITICAL / 21 HIGH,
#                      four of which are perl-base CVEs Debian has no fix for.
#
# Mixing bases is safe here for ONE checked reason: the production closure is 26 packages of
# PURE JAVASCRIPT with zero native binaries, so nothing glibc-linked crosses the stage boundary.
# `scripts/image-inventory.ts` asserts that — it fails if any ELF binary appears under /app.
# Bun bundles its own ICU (75.1 on both images), so Intl — money formatting, CURRENCY_DIGITS,
# CLDR plural categories — is byte-identical on musl; verified, not assumed.
# `deps` runs on the RUNTIME base so the tree that ships is the one that platform resolved.

# ── Stage 1: build the PWA (Debian — native build toolchain) ────────────────────────────────
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS build
WORKDIR /app

# Manifests first: the install layer is then cached across source-only changes.
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
RUN bun install --frozen-lockfile

# Only what Vite reads. The API source is not part of the frontend build.
COPY packages/shared/ packages/shared/
COPY packages/web/ packages/web/

# Release identity, passed in by the release workflow (§3d) — NOT a secret, and not recoverable
# from the build context: `.git` is excluded by .dockerignore. Absent (a plain `docker build`)
# degrades to today's behaviour: an empty sha and a build timestamp only.
ARG SOURCE_COMMIT=""
ENV ENVEO_BUILD_SHA=${SOURCE_COMMIT}
RUN cd packages/web && bun run build

# ── Stage 2: the production dependency closure (Alpine — the runtime platform) ──────────────
FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS deps
WORKDIR /app

# All four manifests are copied even though only two workspaces are installed: `--frozen-lockfile`
# verifies the lockfile against the COMPLETE workspace set, so omitting packages/web here would
# fail the integrity check. Only `--filter`ed workspaces get a link tree.
COPY package.json bun.lock ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
RUN bun install --production --frozen-lockfile --filter '@enveo/api' --filter '@enveo/shared'

# …and then prune. The filtered install still materialises every OPTIONAL PEER resolvable in the
# workspace graph, which is how drizzle-kit, tsx, esbuild, react and react-dom end up inside a
# "production" install (better-auth declares them optional peers; they resolve because the API
# devDepends on drizzle-kit and the web workspace depends on react). This walks the required-link
# graph and deletes everything unreachable. It fails the build if the closure loses a package the
# API needs — see scripts/lib/runtimeClosure.ts.
COPY scripts/prune-runtime-deps.ts scripts/
COPY scripts/lib/runtimeClosure.ts scripts/lib/
RUN bun scripts/prune-runtime-deps.ts /app && rm -rf scripts

# ── Stage 3: runtime (Alpine) ───────────────────────────────────────────────────────────────
FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS runtime

ARG SOURCE_COMMIT=""
LABEL org.opencontainers.image.title="Enveo" \
      org.opencontainers.image.description="Local-first envelope budgeting (YNAB-style), mobile-first PWA with optional end-to-end encrypted sync." \
      org.opencontainers.image.source="https://github.com/enveo/enveo" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}"

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    WEB_DIST=/app/packages/web/dist

# EVERY file below is owned by root while the container runs as `bun` (uid 1000): the application
# cannot rewrite its own code, migrations or frontend assets. Nothing here is chowned.
#
# Manifests — Bun resolves `@enveo/shared` and the dependency link trees through them.
COPY package.json ./
COPY packages/api/package.json packages/api/
COPY packages/shared/package.json packages/shared/

# The pruned production dependency closure. `packages/*/node_modules` are the link trees;
# `node_modules/.bun` is the store they point into. NOT the build stage's node_modules.
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/packages/api/node_modules packages/api/node_modules
COPY --from=deps /app/packages/shared/node_modules packages/shared/node_modules

# Runtime inputs, explicitly. `.dockerignore` keeps *.test.ts out of the build context, so the
# 28 test files next to the sources never reach the image.
COPY packages/api/src packages/api/src
COPY packages/shared/src packages/shared/src
COPY packages/api/drizzle packages/api/drizzle
COPY --from=build /app/packages/web/dist packages/web/dist
COPY scripts/docker-entrypoint.sh /usr/local/bin/enveo-entrypoint

# `bun` (uid/gid 1000) ships with the official image — the same uid on the Alpine variant as on
# Debian. No shell escalation path is added: the entrypoint is the only executable this user
# needs, and it is not writable by them. It is POSIX `sh` only, which is all busybox provides.
USER bun

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/enveo-entrypoint"]
