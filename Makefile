.PHONY: help up down logs build rebuild migrate seed reset dev-api dev-web test verify

# Targets that verify or run code DELEGATE to the root scripts in package.json — that contract
# is the single source of truth (see AGENTS.md § Tests). Never spell out a package command here:
# a second list is exactly what drifts. The docker compose targets below are the stack itself,
# not a duplicate of anything, so they stay as they are.

help: ## Show available commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

deploy: ## Bootstrap on a fresh server (Docker + .env + start + health)
	bash scripts/deploy.sh

up: ## Build and start (db + app) in the background
	docker compose up -d --build

down: ## Stop containers
	docker compose down

logs: ## Tail application logs
	docker compose logs -f app

build: ## Build the Docker application image (for the web bundle alone: bun run build)
	docker compose build

rebuild: ## Rebuild from scratch and start
	docker compose up -d --build --force-recreate

migrate: ## Run migrations inside the app container
	docker compose exec app bun packages/api/src/db/migrate.ts

seed: ## Force a re-seed (WARNING: wipes data)
	docker compose exec app bun packages/api/src/db/seed.ts

reset: ## Drop the database (volume) and recreate from scratch
	docker compose down -v && docker compose up -d --build

dev-api: ## Dev: API with auto-reload (requires local database / .env)
	bun run dev:api

dev-web: ## Dev: Vite frontend (proxies /api -> :8080)
	bun run dev:web

test: ## Tests: shared, api, web/lib and tooling (AI and DB-backed groups off)
	bun run test

verify: ## Full local gate: typecheck + tests + production build (offline)
	bun run verify
