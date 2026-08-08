# Operating Enveo

Day-2 operations for a self-hosted install. Run these where your `compose.yml`
lives.

## Update

```bash
# Update to the newest release (migrations run on start — back up first)
docker compose pull && docker compose up -d
```

**Pin the version** once real data is in it: swap `:latest` in `compose.yml`
for a [release tag](https://github.com/enveo/enveo/releases) (e.g.
`ghcr.io/enveo/enveo:3.6.2`), so `docker compose pull` cannot carry you across
a major version by surprise.

Upgrading a 1.x install to 2.0+ is a one-time special case:
[upgrade-from-1.x.md](upgrade-from-1.x.md).

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
