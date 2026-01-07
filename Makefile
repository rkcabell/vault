# --- Docker infra ---
up:        ## start infra (postgres, minio, redis)
	docker compose -f infra/docker/docker-compose.yml up -d

down:      ## stop infra
	docker compose -f infra/docker/docker-compose.yml down

nuke:      ## stop infra & remove volumes
	docker compose -f infra/docker/docker-compose.yml down -v

logs:      ## tail all infra logs
	docker compose -f infra/docker/docker-compose.yml logs -f

# --- API/dev ---
api-dev:   ## start API (hot reload)
	cd apps/api && npm run dev

worker:    ## start OCR worker
	cd apps/api && npm run worker

typecheck: ## TypeScript typecheck
	cd apps/api && npm run typecheck

lint:      ## ESLint check
	cd apps/api && npm run lint

lint-fix:  ## ESLint fix
	cd apps/api && npm run lint:fix

fmt:       ## Prettier format
	cd apps/api && npm run format

test:      ## (placeholder)
	echo "no tests yet"
help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-14s\033[0m %s\n", $$1, $$2}'
