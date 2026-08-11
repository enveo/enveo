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
# BUN VERSION. Pinned to one exact version AND the multi-architecture manifest digest, in every
# stage. `.bun-version` is the single source of truth and `scripts/lib/bunVersion.test.ts` fails
# the build when this file, CI, `@types/bun` or the documentation drift apart. The digest below
# is the linux/amd64 + linux/arm64 index for oven/bun:1.3.14 — bump version and digest together,
# never one alone, and rerun the whole gate.

# ── Stage 1: build the PWA ──────────────────────────────────────────────────────────────────
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

# ── Stage 2: the production dependency closure ──────────────────────────────────────────────
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS deps
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

# ── Stage 3: runtime ────────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS runtime

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

# `bun` (uid/gid 1000) ships with the official image. No shell escalation path is added: the
# entrypoint is the only executable this user needs, and it is not writable by them.
USER bun

EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/enveo-entrypoint"]
