# Thin wrappers around docker compose. `make` lists the targets.
# Poll interval: `make start INTERVAL=60` (seconds, default 15).

APP_URL ?= http://localhost:3000
SEED_IDS ?= acme-crm north-analytics ferry-pay

# Exported only when given, so COMPOSE_POLL_INTERVAL_SECONDS from .env still applies otherwise.
ifdef INTERVAL
export COMPOSE_POLL_INTERVAL_SECONDS := $(INTERVAL)
endif

.DEFAULT_GOAL := help
.PHONY: help build start stop reset logs seed clear check e2e

help:
	@echo "make build              build the images (run after changing the code)"
	@echo "make start              start everything in the background and wait until healthy"
	@echo "make start INTERVAL=60  the same, polling every 60 seconds"
	@echo "make seed               track acme-crm, north-analytics and ferry-pay"
	@echo "make clear              remove all competitors with their history, rewind the stub"
	@echo "make logs               follow the app logs"
	@echo "make stop               stop everything, keep the data"
	@echo "make reset              stop everything and delete the data"
	@echo "make check              lint, typecheck and test (needs the db service up)"
	@echo "make e2e                end-to-end checks on a separate, throwaway stack"

build:
	docker compose build

start:
	docker compose up -d --wait
	@echo "UI: $(APP_URL)"

stop:
	docker compose down

reset:
	docker compose down -v

logs:
	docker compose logs -f app

check:
	npm run lint
	npm run typecheck
	npm test

e2e:
	python3 scripts/e2e-smoke.py

# Already tracked ids are fine, so seeding twice is harmless.
seed:
	@for id in $(SEED_IDS); do \
		code=$$(curl -s -o /dev/null -w '%{http_code}' -X POST \
			-H 'content-type: application/json' -d "{\"id\":\"$$id\"}" $(APP_URL)/api/competitors); \
		case $$code in \
			201) echo "added $$id" ;; \
			409) echo "already tracked $$id" ;; \
			*) echo "failed to add $$id (HTTP $$code). Is the app running? Try: make start" >&2; exit 1 ;; \
		esac; \
	done

# The stub restarts as well: its version counters live in memory, and without the rewind
# competitors added afterwards would start at version 4 and never show a change.
clear:
	@body=$$(curl -fsS $(APP_URL)/api/competitors) \
		|| { echo "cannot reach the app. Is it running? Try: make start" >&2; exit 1; }; \
	for id in $$(printf '%s' "$$body" | grep -o '"id":"[^"]*"' | cut -d'"' -f4); do \
		curl -fsS -X DELETE $(APP_URL)/api/competitors/$$id || exit 1; \
		echo "removed $$id"; \
	done
	@docker compose restart listing-stub
	@docker compose up -d --wait listing-stub
