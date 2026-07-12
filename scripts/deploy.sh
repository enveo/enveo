#!/usr/bin/env bash
# Enveo — deployment bootstrap for a fresh server (Ubuntu/Debian).
# Idempotent: safe to run multiple times. Does nothing destructive.
#
#   bash scripts/deploy.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf "\n\033[36m▸ %s\033[0m\n" "$1"; }

# 1) Docker
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker (get.docker.com)…"
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Missing 'docker compose' plugin. Install docker-compose-plugin and re-run." >&2
  exit 1
fi

# 2) .env
if [ ! -f .env ]; then
  say "Creating .env with a random database password…"
  pass="$(openssl rand -hex 16 2>/dev/null || head -c16 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c24)"
  cp .env.example .env
  sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=${pass}/" .env
  secret="$(openssl rand -hex 32)"
  sed -i "s/^BETTER_AUTH_SECRET=.*/BETTER_AUTH_SECRET=${secret}/" .env
  echo "  wrote .env (POSTGRES_PASSWORD and BETTER_AUTH_SECRET generated)"
else
  echo "  .env already exists — leaving it alone."
  if ! grep -q '^BETTER_AUTH_SECRET=..' .env; then
    secret="$(openssl rand -hex 32)"
    if grep -q '^BETTER_AUTH_SECRET=' .env; then
      sed -i "s/^BETTER_AUTH_SECRET=.*/BETTER_AUTH_SECRET=${secret}/" .env
    else
      echo "BETTER_AUTH_SECRET=${secret}" >> .env
    fi
    echo "  added missing BETTER_AUTH_SECRET to .env"
  fi
fi

# 3) Build + start
say "Building and starting containers (db + app)…"
docker compose up -d --build

# 4) Wait for app health
say "Waiting for the app to answer on /api/health…"
for i in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:8081/api/health >/dev/null 2>&1; then
    echo "  ✓ app healthy: http://127.0.0.1:8081"
    break
  fi
  sleep 2
  [ "$i" = 40 ] && { echo "  ✗ app did not start — check: docker compose logs app"; exit 1; }
done

# 5) HTTPS
say "Next step — expose it over HTTPS (required for PWA install):"
cat <<'EOF'
  The app listens on 127.0.0.1:8081 only. Put it behind your own HTTPS layer,
  for example:
    - a reverse proxy with TLS (Caddy, nginx + certbot), or
    - a private mesh VPN with HTTPS certificates, e.g. Tailscale:
        sudo tailscale serve --bg https / http://127.0.0.1:8081
        sudo tailscale serve status   # shows https://<host>.<tailnet>.ts.net
EOF
say "Done."
