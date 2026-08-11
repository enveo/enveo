#!/bin/sh
# Enveo container entrypoint (§3e).
#
# Two jobs, in this order, and nothing else:
#   1. apply database migrations — a FAILURE HERE MUST PREVENT THE API FROM STARTING;
#   2. `exec` the API, so the Bun process REPLACES this shell and is the process Docker
#      signals. Without `exec`, /bin/sh stays PID 1, SIGTERM never reaches Bun, and every
#      `docker stop` waits out the grace period and ends in SIGKILL.
#
# `set -eu`: any non-zero exit aborts (fail-fast migrations), any unset variable is an error.
# There is no `||`, no background job and no retry loop — a failed migration is an operator
# event, not something to paper over.
set -eu

# Escape hatch for maintenance commands (`docker run --rm <image> bun packages/api/src/db/seed.ts`).
# Compose's `app` service passes no command, so the normal path below is what production runs.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

echo "enveo: applying database migrations"
bun /app/packages/api/src/db/migrate.ts

echo "enveo: starting API"
exec bun /app/packages/api/src/index.ts
