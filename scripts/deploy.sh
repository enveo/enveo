#!/usr/bin/env bash
# Enveo — deployment bootstrap for a server you already administer (Ubuntu/Debian).
#
#   bash scripts/deploy.sh
#
# What it does: check the prerequisites, generate the two secrets into .env if they are not
# there yet, build and start the stack, wait for /api/health.
#
# What it deliberately does NOT do: install anything. Docker Engine and its Compose v2 plugin
# are the host operator's decision — this script neither downloads an installer nor pipes one
# into a shell, adds a package repository, imports a key or asks for root. A budgeting app is
# a poor place to teach the download-a-script-and-execute-it habit, and a script that
# provisions your operating system is one you cannot audit at the moment you must trust it.
# (That rule is enforced on this file's SOURCE by scripts/lib/sourcePolicy.ts.) If a
# prerequisite is missing you get the official documentation link and a rerun instruction —
# and NOTHING has been changed.
#
# Idempotent: safe to run repeatedly. An existing .env is left alone, except that a missing
# BETTER_AUTH_SECRET is added (the API refuses to boot without one).
#
# Exit codes:  0 ok · 1 the app did not become healthy · 2 no docker CLI
#              3 no Compose v2 plugin · 4 Docker daemon unreachable
#              5 another required tool missing, or secret generation failed
#              6 an existing BETTER_AUTH_SECRET is too short to boot with
set -euo pipefail
cd "$(dirname "$0")/.."

say()  { printf "\n\033[36m▸ %s\033[0m\n" "$1"; }
fail() { printf "\n\033[31m✗ %s\033[0m\n" "$1" >&2; }

DOCS_INSTALL="https://docs.docker.com/engine/install/"
DOCS_INSTALL_UBUNTU="https://docs.docker.com/engine/install/ubuntu/"
DOCS_INSTALL_DEBIAN="https://docs.docker.com/engine/install/debian/"
DOCS_POSTINSTALL="https://docs.docker.com/engine/install/linux-postinstall/"

# ---------------------------------------------------------------------------------------------
# 1) Prerequisites — BEFORE anything is created or changed.
#
# Three failures that look alike from a distance and need completely different fixes: the CLI
# is not installed, the CLI is there but Compose v2 is not, or everything is installed and the
# daemon cannot be reached (service down, or this user is not in the `docker` group). Telling
# an operator to "install Docker" when their real problem is a group membership wastes an
# afternoon, so each one exits with its own code and its own explanation.
# ---------------------------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  fail "Docker is not installed (no \`docker\` command)."
  cat >&2 <<EOF
  Enveo runs in containers; installing Docker is your call, not this script's.
  Ubuntu and Debian are what this script is tested on — the links below cover
  them. Install Docker Engine with the Compose v2 plugin from Docker's own
  documentation:

    Ubuntu: ${DOCS_INSTALL_UBUNTU}
    Debian: ${DOCS_INSTALL_DEBIAN}
    Other:  ${DOCS_INSTALL}

  Then verify, and run this script again:

    docker compose version
    bash scripts/deploy.sh

  Nothing has been created or changed.
EOF
  exit 2
fi

if ! docker compose version >/dev/null 2>&1; then
  fail "The Docker Compose v2 plugin is missing (\`docker compose\` is not a docker command)."
  cat >&2 <<EOF
  The \`docker\` CLI is installed, so this is not a full install — only the
  compose plugin is absent. The legacy \`docker-compose\` (v1, hyphen) script is
  not a substitute: this stack uses v2 syntax and the Compose Specification.

  Install \`docker-compose-plugin\` from Docker's repository as described in:

    ${DOCS_INSTALL}

  Then verify, and run this script again:

    docker compose version
    bash scripts/deploy.sh

  Nothing has been created or changed.
EOF
  exit 3
fi

if ! docker info >/dev/null 2>&1; then
  fail "Docker is installed but its daemon cannot be reached from this account."
  cat >&2 <<EOF
  This is a service or permission problem, NOT a missing installation — do not
  reinstall. The two usual causes:

    1. the daemon is not running:
         systemctl status docker    (start it: sudo systemctl enable --now docker)
    2. your user is not in the \`docker\` group, so the socket is not readable —
       see Docker's post-installation steps:
         ${DOCS_POSTINSTALL}
       A new group membership only applies to a NEW login session.

  Then run this script again. Nothing has been created or changed.
EOF
  exit 4
fi

# Everything else this script shells out to later. Checked here, together, so a missing tool
# cannot surface halfway through — after .env exists and the containers are up.
missing=""
for tool in openssl curl; do
  command -v "$tool" >/dev/null 2>&1 || missing="${missing} ${tool}"
done
if [ -n "${missing}" ]; then
  fail "Missing required command(s):${missing}"
  cat >&2 <<EOF
  This script needs \`openssl\` (to generate the two secrets) and \`curl\` (to
  poll the app's health endpoint on 127.0.0.1). Both are packaged on every
  supported distribution; install them with your own package manager, then run
  this script again.

  Nothing has been created or changed.
EOF
  exit 5
fi

# ---------------------------------------------------------------------------------------------
# 2) .env — the first thing that writes anything.
#
# Three rules here, each of them learned the hard way:
#
#  * A secret is generated into a VARIABLE and checked, never inlined into another command's
#    arguments. `sed "s|…|…=$(openssl rand -hex 24)|"` looks equivalent and is not: `set -e`
#    sees sed's status (0), so a failed openssl writes an EMPTY password — and compose's
#    `${POSTGRES_PASSWORD:-enveo}` substitutes on empty as well as unset, initialising the
#    database volume, permanently, with a well-known password.
#  * A secret never reaches another process's argv (/proc/<pid>/cmdline is world-readable) and
#    never reaches an xtrace line. Substitution is done by the shell's own read/printf builtins,
#    with tracing suspended around it.
#  * Values are never echoed: a secret in a terminal scrollback, a CI log or a screenshot is a
#    leaked secret. `.env` itself is created 0600.
# ---------------------------------------------------------------------------------------------

gen_secret() {  # $1 = hex byte count; prints the secret on stdout, fails loudly on an empty one
  local value
  value="$(openssl rand -hex "$1")" || return 1
  [ -n "$value" ] || return 1
  printf '%s' "$value"
}

write_new_env() {
  local trace=0
  case "$-" in *x*) trace=1; set +x ;; esac
  local pass secret line status=0
  if ! pass="$(gen_secret 24)" || ! secret="$(gen_secret 32)"; then status=1; fi
  if [ "$status" = 0 ]; then
    umask 077
    : > .env.tmp
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        POSTGRES_PASSWORD=*)  printf 'POSTGRES_PASSWORD=%s\n' "$pass"   >> .env.tmp ;;
        BETTER_AUTH_SECRET=*) printf 'BETTER_AUTH_SECRET=%s\n' "$secret" >> .env.tmp ;;
        *)                    printf '%s\n' "$line"                      >> .env.tmp ;;
      esac
    done < .env.example
    mv .env.tmp .env
    chmod 600 .env
  fi
  if [ "$trace" = 1 ]; then set -x; fi
  return "$status"
}

append_secret() {
  local trace=0
  case "$-" in *x*) trace=1; set +x ;; esac
  local secret status=0
  if secret="$(gen_secret 32)"; then
    printf 'BETTER_AUTH_SECRET=%s\n' "$secret" >> .env
  else
    status=1
  fi
  if [ "$trace" = 1 ]; then set -x; fi
  return "$status"
}

secret_failed() {
  fail "Could not generate a secret — \`openssl rand\` failed."
  cat >&2 <<EOF
  Nothing was written: an empty password here would be worse than no file at
  all, because compose substitutes its default on an EMPTY value and the
  database volume would be initialised with it, permanently.

  Check your openssl installation and run this script again.
EOF
  exit 5
}

if [ ! -f .env ]; then
  say "Creating .env with generated secrets…"
  write_new_env || secret_failed
  echo "  wrote .env, mode 600 (POSTGRES_PASSWORD and BETTER_AUTH_SECRET generated — values not printed)"
else
  echo "  .env already exists — leaving it alone."
  current="$(grep -m1 '^BETTER_AUTH_SECRET=' .env || true)"
  current="${current#BETTER_AUTH_SECRET=}"
  if [ -z "$current" ]; then
    append_secret || secret_failed
    echo "  added the missing BETTER_AUTH_SECRET (value not printed)"
  elif [ "${#current}" -lt 32 ]; then
    fail "BETTER_AUTH_SECRET in .env is too short (${#current} characters; the API requires at least 32)."
    cat >&2 <<'EOF'
  The API refuses to boot without a 32+ character session secret, so starting
  the stack now would only produce a container that exits and an unhelpful
  "did not become healthy" eighty seconds later.

  This script will NOT overwrite it: replacing a real secret signs every device
  out. Set it yourself, then run this script again:

    openssl rand -hex 32     # put the output in .env as BETTER_AUTH_SECRET=…

  Nothing has been changed.
EOF
    exit 6
  fi
fi

# ---------------------------------------------------------------------------------------------
# 3) Build + start
# ---------------------------------------------------------------------------------------------
say "Building and starting containers (db + app)…"
docker compose up -d --build

# ---------------------------------------------------------------------------------------------
# 4) Wait for the app to answer on the loopback interface. The only request this script makes.
# ---------------------------------------------------------------------------------------------
say "Waiting for the app to answer on /api/health…"
attempts="${ENVEO_HEALTH_ATTEMPTS:-40}"   # overridable for tests; the default is ~80 seconds
delay="${ENVEO_HEALTH_DELAY:-2}"
healthy=0
i=0
while [ "$i" -lt "$attempts" ]; do
  i=$((i + 1))
  if curl -fsS http://127.0.0.1:8081/api/health >/dev/null 2>&1; then
    healthy=1
    break
  fi
  # No sleep after the LAST attempt: the answer is already known, and waiting two more
  # seconds only delays the failure message. An `&&` here would be a `set -e` trap — on the
  # final iteration it evaluates false, and that is the loop body's exit status.
  if [ "$i" -lt "$attempts" ]; then sleep "$delay"; fi
done
if [ "$healthy" != 1 ]; then
  fail "The app did not become healthy — check: docker compose logs app"
  exit 1
fi
echo "  ✓ app healthy: http://127.0.0.1:8081"

# ---------------------------------------------------------------------------------------------
# 5) HTTPS
# ---------------------------------------------------------------------------------------------
say "Next step — expose it over HTTPS (required for PWA install):"
cat <<'EOF'
  The app listens on 127.0.0.1:8081 only. Put it behind your own HTTPS layer,
  for example:
    - a reverse proxy with TLS (Caddy, nginx + certbot), or
    - a private mesh VPN with HTTPS certificates, e.g. Tailscale:
        sudo tailscale serve --bg https / http://127.0.0.1:8081
        sudo tailscale serve status   # shows https://<host>.<tailnet>.ts.net

  Then set BETTER_AUTH_URL in .env to that https:// origin and run:
    docker compose up -d
EOF
say "Done."
