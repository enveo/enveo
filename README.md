# Enveo

**Calm money, one envelope at a time.** Enveo is a private, local-first
envelope budgeting app — YNAB-style zero-based budgeting as a mobile-first PWA
you self-host with a single `docker compose up`. It works offline, syncs in the
background (optionally end-to-end encrypted), and your data stays yours.

**Website: [enveo.app](https://enveo.app)** · **[Documentation](docs/readme.md)** · AGPL-3.0

<p align="center">
  <a href="https://enveo.app"><img src="docs/assets/hero.gif" width="260" alt="Enveo: home, budget and reports on mobile"></a>
</p>

## Features

- **Envelope budgeting done right** — carry-over (negatives included),
  transfers, refunds, split transactions, monthly goals.
- **Local-first PWA** — every screen works offline; installs on iOS and
  Android; syncs in the background when a server is reachable.
- **Optional end-to-end encryption** — the server relays ciphertexts and never
  sees plaintext.
- **AI where it helps, off by default** — a budget assistant (works rule-based
  with no key at all) and screenshot import of bank statements; bring your own
  OpenAI key (protected by the optional server vault) or configure an operator
  key on the server.
- **Reports** — net worth, cash flow, spending, budget health.
- **10 languages** ([add yours](CONTRIBUTING.md#add-a-language)), **31
  currencies**, dark mode, four accent themes.

## Run it

<!-- TODO(maintainer): remove this note once the GHCR package is public
     (docs/hosting.md → "Publishing the image", steps 4-6). -->
> **Image not public yet.** `ghcr.io/enveo/enveo` becomes pullable when the
> package visibility flips with the repo — until then, build from source
> ([docs/development.md](docs/development.md)).

An empty directory, two generated secrets — nothing is compiled. You bring
**Docker Engine with the Compose v2 plugin** ([Docker's own install
docs](https://docs.docker.com/engine/install/); `docker compose version` must
answer):

```bash
mkdir enveo && cd enveo
curl -fsSL https://raw.githubusercontent.com/enveo/enveo/main/compose.selfhost.yml -o compose.yml
{ echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
  echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)"; } > .env
docker compose up -d
```

That compose file runs **`ghcr.io/enveo/enveo:latest`** — a mutable alias moved
onto a stable release only after that exact image passed the release gate, so it
never serves a prerelease but may advance across a major version. It does not
move under you: restarting an install keeps the image it already has, and you
update deliberately (back up → read the release notes → `docker compose pull` →
recreate → check), as [operations.md](docs/operations.md#update) spells out.

Open **http://localhost:8081** and create the **owner account** right away —
registration closes as soon as it exists, so nobody who finds your URL can sign
themselves up. The budget starts empty; the in-app wizard sets it up.

Using it from your phone needs HTTPS — see **[Self-hosting](docs/install.md)**
for that (and for every knob). No server? **[Railway, Render and
friends](docs/hosting.md)**.

## Documentation

Everything else lives in **[docs/](docs/readme.md)**: [self-hosting in
full](docs/install.md), [managed platforms](docs/hosting.md), [day-2
operations](docs/operations.md), [architecture](docs/architecture.md),
[AI features](docs/ai.md) and [developing](docs/development.md).

## Developing

```bash
cp .env.example .env    # set POSTGRES_PASSWORD and BETTER_AUTH_SECRET (openssl rand -hex 32)
make up                 # build + start → http://127.0.0.1:8081
bun run verify          # typecheck + tests + production build (offline, no database needed)
```

Details (running without Docker, demo data, translations):
**[docs/development.md](docs/development.md)** and
**[CONTRIBUTING.md](CONTRIBUTING.md)**.

## License

[AGPL-3.0](LICENSE) — free to self-host, modify and share; run it as a service
and your changes stay open too.
