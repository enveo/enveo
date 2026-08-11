# Operating Enveo

Day-2 operations for a self-hosted install. Run these where your `compose.yml`
lives.

## Update

An update is **deliberate**, in this order:

```bash
# 1. Back up (see below) and check the archive
docker compose exec -T db pg_dump -U enveo enveo | gzip > enveo-$(date +%F).sql.gz
gzip -t enveo-*.sql.gz

# 2. Read the release notes: https://github.com/enveo/enveo/releases

# 3. Fetch the new image and recreate the containers (migrations run on start)
docker compose pull
docker compose up -d

# 4. Check it came up and your data is there
curl -fsS http://127.0.0.1:8081/api/health          # {"ok":true}
docker compose logs --tail=50 app                   # "enveo: applying database migrations",
                                                    # then "Enveo API → http://localhost:8080"
```

Then open the app, confirm you are still signed in and that the current month's
budget and a recent transaction look right.

**About the `:latest` tag.** `ghcr.io/enveo/enveo:latest` is a *mutable alias*.
The release pipeline moves it onto a stable release only after that exact image
has passed the full gate — multi-architecture manifest, vulnerability scan,
provenance and SBOM — so it never points at a prerelease, but it **can advance
across a major version**. That is safe to live with because nothing moves on its
own: the first `docker compose up` fetches the image, and restarting an existing
install keeps running the image already on the machine. Your deployment changes
only when you run step 3 above.

**Going back is not just a tag edit.** If the new version migrated the database,
the old image cannot read the new schema — recovery is restoring the backup you
took in step 1. Repointing `latest`, or keeping an old image around locally, is
not a downgrade path.

## Back up and restore

```bash
# Back up: before every update, and on a schedule
docker compose exec -T db pg_dump -U enveo enveo | gzip > enveo-$(date +%F).sql.gz
gzip -t enveo-*.sql.gz                       # no output = the archive is intact

# Restore into an empty database
zcat enveo-2026-07-13.sql.gz | docker compose exec -T db psql -U enveo -d enveo
```

Keep at least one copy of the backup **and of your `.env`** off the machine —
losing `BETTER_AUTH_SECRET` signs every device out.

## Reset a forgotten password

There is no e-mail on a self-hosted install; the operator resets passwords on
the server:

```bash
docker compose exec app bun run auth:reset-password you@example.com NewPassword1
```

## Logs

```bash
docker compose logs -f app
```

## Ports and binding

**Change the host port** with `ENVEO_PORT=9000` in `.env`, then `docker compose
up -d`. The app binds `127.0.0.1` unless you set `ENVEO_BIND=0.0.0.0` — read
the warning in [`.env.selfhost.example`](../.env.selfhost.example) before you
do; TLS in front of the loopback port ([install.md](install.md#https--the-way-to-use-enveo-from-your-phone))
is the better answer for phones. Postgres is deliberately **not** published —
it is reachable only from the app container.
