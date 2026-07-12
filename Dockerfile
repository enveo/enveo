# Enveo — single image: API (bun + hono) serving the built frontend (Vite PWA)
FROM oven/bun:1 AS build
WORKDIR /app

# Manifests first (better layer caching)
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
RUN bun install --frozen-lockfile

# Sources and frontend build
COPY . .
RUN cd packages/web && bun run build

# ── Runtime image ───────────────────────────────────────────────────────
FROM oven/bun:1 AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV WEB_DIST=/app/packages/web/dist

COPY --from=build /app /app

EXPOSE 8080
CMD ["sh", "-c", "bun packages/api/src/db/migrate.ts && bun packages/api/src/db/ensure-seed.ts && bun packages/api/src/index.ts"]
