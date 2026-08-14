# Self-hosting Enveo

Everything about running Enveo on your own machine: the quickstart, accounts,
network exposure and HTTPS. For managed platforms (Railway, Render, PikaPods)
see [hosting.md](hosting.md); for day-2 operations (updates, backups, password
reset) see [operations.md](operations.md).

## Quickstart

An empty directory and two generated secrets. Nothing is compiled — this pulls
the published image, `ghcr.io/enveo/enveo:latest`. (Until the GHCR package is
public, pulls fail with 403 — build from source instead:
[development.md](development.md).)

**Prerequisite:** Docker Engine with the Compose v2 plugin, installed and
running. Enveo neither installs nor configures it — provisioning the host is the
operator's job. Follow [Docker's own installation
documentation](https://docs.docker.com/engine/install/) for your distribution,
then check that `docker compose version` answers before continuing.

```bash
mkdir enveo && cd enveo
curl -fsSL https://raw.githubusercontent.com/enveo/enveo/main/compose.selfhost.yml -o compose.yml
{ echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
  echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)"; } > .env
docker compose up -d
```

Open **http://localhost:8081** and create the **owner account** — do it now, not
later: registration is open until that account exists, so whoever reaches the
app first becomes the owner. The budget starts **empty** — the in-app wizard
sets it up.

Both secrets are **required**: with either unset the stack refuses to start
rather than come up with a guessable one. Everything else is optional —
[`.env.selfhost.example`](../.env.selfhost.example) documents the knobs (host
port, bind address, OpenAI key, Google sign-in, public URL). Migrations run
automatically on start, on every update — updating is a deliberate step, see
[operations.md](operations.md#update).

## Own OpenAI credential vault (optional)

Own OpenAI lets each budget use its own OpenAI key without entering it again on
every device. For a normal, non-E2EE budget the browser sends requests to Enveo;
Enveo decrypts that budget's key only for the duration of the request and calls
OpenAI. PostgreSQL stores only envelope-encrypted material. The master key must
therefore live outside PostgreSQL, the image and `.env`.

The ordinary stack deliberately starts without this vault. To enable it, download
[`compose.ai-vault.yml`](../compose.ai-vault.yml) next to `compose.yml`, then create
a key ring (the command prints only random bytes into the protected file):

```bash
mkdir -p secrets
chmod 700 secrets
KEY_ID="$(date -u +%Y-%m)"
KEY_VALUE="$(openssl rand -base64 32)"
printf '{"version":1,"activeKeyId":"%s","keys":{"%s":"%s"}}\n' \
  "$KEY_ID" "$KEY_ID" "$KEY_VALUE" > secrets/enveo-ai-vault-key-ring.json
unset KEY_VALUE
chmod 600 secrets/enveo-ai-vault-key-ring.json
echo 'AI_VAULT_KEY_RING_PATH=./secrets/enveo-ai-vault-key-ring.json' >> .env
docker compose -f compose.yml -f compose.ai-vault.yml up -d
```

The app container runs as uid `1000`. The mounted file must be readable by that uid;
on a host where the file has a different numeric owner, set it explicitly with
`sudo chown 1000:1000 secrets/enveo-ai-vault-key-ring.json`, keep mode `600`, and
restart with the same two `-f` arguments. `docker compose logs app` reports an
unreadable or malformed ring using a stable error code and never prints its contents.

Back up the key-ring file separately from the PostgreSQL dump and keep that copy
offline. A database restore containing vaulted credentials needs the matching ring.
Losing it does not damage budget transactions, but existing Own OpenAI keys become
unrecoverable and must be deleted/re-entered after a new ring is installed. Do not put
the JSON itself in `.env`, Git, a container image, or ordinary log/backup automation.

Rotation is additive: generate another 32-byte value, add it under a new id, make that
id `activeKeyId`, and retain every older entry. Normal credential use lazily rewraps its
per-record DEK with the active master key without re-encrypting the OpenAI key. Keep an
old key until this query returns no row that names it:

```bash
docker compose exec -T db psql -U enveo -d enveo -c \
  "SELECT master_key_id, count(*) FROM budget_ai_credentials WHERE storage_kind='server_vault' GROUP BY master_key_id ORDER BY master_key_id;"
```

Replace the ring file atomically, then recreate `app` so Docker remounts the new
file and the process loads it:

```bash
docker compose -f compose.yml -f compose.ai-vault.yml up -d --force-recreate app
```

Exercise each active Own OpenAI credential, then run the query. Removing a
still-referenced old key makes those rows unreadable; restoring the previous ring
and recreating `app` is the recovery.

## Accounts and registration

An account is **mandatory** — there is no no-login mode. The first person to
open the app creates the **owner account** (e-mail + password; Google sign-in
when `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are set), and registration
**closes** right after: a second sign-up is refused with `signups_closed`,
enforced server-side. Nobody who finds your URL can create themselves an
account.

| Variable | Default | Meaning |
|---|---|---|
| `BETTER_AUTH_SECRET` | — | **Required** session secret (min 32 chars). `scripts/deploy.sh` generates one; by hand: `openssl rand -hex 32` |
| `DEPLOYMENT` | `selfhost` | `selfhost` closes registration after the first account; `cloud` keeps it open |
| `ALLOW_SIGNUPS` | unset | `1` reopens registration on `selfhost` (e.g. to add a family member) — remove it again afterwards |

To add a household member: put `ALLOW_SIGNUPS=1` in `.env`, `docker compose up
-d`, let them register, then remove it and repeat.

Forgot the password? There is no e-mail infrastructure on a self-hosted install
— the operator resets it on the server (see
[operations.md](operations.md#reset-a-forgotten-password)).

## Network exposure

The app is published on the **loopback interface only** (`127.0.0.1:8081`) —
the machine that runs it, nothing else on the network. Reaching it from another
device is the HTTPS step below, not `ENVEO_BIND=0.0.0.0`: a port open to a LAN
(or, on a VPS, to the internet) hands the owner account to the first stranger
who finds it and sends session cookies in the clear. Docker publishes ports
through its own iptables rules, which **bypass ufw/firewalld** — a host
firewall does not undo this.

## HTTPS — the way to use Enveo from your phone

Installing the PWA (and its offline service worker) needs a secure origin:
`localhost` counts, a bare LAN IP or a plain-HTTP domain does not — and over
plain HTTP the session cookie travels in the clear. Put Enveo behind TLS: a
reverse proxy with a certificate, a tunnel, or a private mesh VPN that
terminates HTTPS (e.g. Tailscale `serve`), pointed at the loopback port.

Then **set `BETTER_AUTH_URL` to that `https://…` origin** in `.env` and
`docker compose up -d`. This is not cosmetic: the session cookie is marked
`Secure` only when `BETTER_AUTH_URL` is an `https://` URL. Leave the
`http://localhost` default in place behind a proxy and you get a 90-day session
cookie **without** `Secure` — a single plain-`http://` link to the same host
leaks it. Sign-in keeps working either way, so nothing warns you.

On iPhone: open the HTTPS URL in Safari → Share → **Add to Home Screen**.
