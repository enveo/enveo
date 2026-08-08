# Self-hosting Enveo

Everything about running Enveo on your own machine: the quickstart, accounts,
network exposure and HTTPS. For managed platforms (Railway, Render, PikaPods)
see [hosting.md](hosting.md); for day-2 operations (updates, backups, password
reset) see [operations.md](operations.md).

## Quickstart

Docker, an empty directory, two generated secrets. Nothing is compiled — this
pulls the published image. (Until the GHCR package is public, pulls fail with
403 — build from source instead: [development.md](development.md).)

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
automatically on start, on every update.

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
