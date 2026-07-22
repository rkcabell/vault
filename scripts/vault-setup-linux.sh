#!/usr/bin/env bash
# File: scripts/vault-setup-linux-prod.sh
# Checks for Docker and starts the full Vault production stack.
# Requires Docker Engine to be running.
#
# Run from the repo root:
#   bash scripts/vault-setup-linux-prod.sh
set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env.prod"
EXAMPLE="$ROOT/.env.prod.example"
COMPOSE_FILE="$ROOT/infra/docker/docker-compose.prod.yml"
COMPOSE_ARGS=(--env-file "$ENV_FILE" -f "$COMPOSE_FILE")
REQUIRED_ENV_KEYS=(POSTGRES_PASSWORD JWT_SECRET JWT_REFRESH_SECRET)

STEP=0
step() { echo -e "\n${BLUE}${BOLD}[$((++STEP))] $1${NC}"; }
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
die()  { echo -e "\n${RED}${BOLD}Error: $1${NC}" >&2; exit 1; }

new_hex_secret() {
  openssl rand -hex 32
}

# Emit an OSC 8 clickable hyperlink (supported in most modern terminals)
hyperlink() {  # hyperlink <url> <text>
  printf '\e]8;;%s\e\\%s\e]8;;\e\\' "$1" "$2"
}

wait_docker_ready() {
  local timeout="${1:-120}" interval="${2:-2}"
  local deadline=$(( $(date +%s) + timeout ))
  printf "  Waiting for Docker daemon"
  while [[ $(date +%s) -lt $deadline ]]; do
    docker info &>/dev/null && echo " ready" && return 0
    printf "."
    sleep "$interval"
  done
  echo " timed out"
  return 1
}

get_env_value() {
  grep -m1 "^${1}=" "$ENV_FILE" 2>/dev/null | cut -d= -f2-
}

show_compose_diagnostics() {
  warn "Compose diagnostics:"
  docker "${COMPOSE_ARGS[@]}" ps 2>/dev/null \
    || warn "Unable to read compose service status."
  docker "${COMPOSE_ARGS[@]}" logs --tail 80 \
    postgres redis api web jobs-ocr jobs-thumb nginx 2>/dev/null \
    || warn "Unable to read compose logs."
}

assert_services_healthy() {
  local issues=()
  local running_services=(postgres redis api web jobs-ocr jobs-thumb nginx)

  for service in "${running_services[@]}"; do
    local id
    id=$(docker "${COMPOSE_ARGS[@]}" ps -q "$service" 2>/dev/null | tr -d '[:space:]')
    if [[ -z "$id" ]]; then
      issues+=("$service container is missing")
      continue
    fi
    local status
    status=$(docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null | tr -d '[:space:]')
    if [[ "$status" != "running" ]]; then
      issues+=("$service status is '$status' (expected 'running')")
    fi
  done

  if [[ ${#issues[@]} -gt 0 ]]; then
    for issue in "${issues[@]}"; do warn "$issue"; done
    show_compose_diagnostics
    die "Vault services are not healthy. See diagnostics above."
  fi
}

# ---------------------------------------------------------------------------
# 1. Docker
# ---------------------------------------------------------------------------
step "Checking Docker"

if ! command -v docker &>/dev/null; then
  die "docker is required but not found. Install Docker Engine from https://docs.docker.com/get-docker/"
fi
ok "docker found"

docker compose version &>/dev/null \
  || die "Docker Compose v2 is required. See https://docs.docker.com/compose/install/"
ok "docker compose v2"

step "Waiting for Docker Engine"
if wait_docker_ready 120 2; then
  ok "Docker daemon is reachable"
else
  docker info 2>&1 || true
  die "Docker daemon did not become ready within 120s. Start Docker Engine and re-run this script."
fi

# ---------------------------------------------------------------------------
# 2. .env.prod
# ---------------------------------------------------------------------------
step "Configuring environment"

if [[ -f "$ENV_FILE" ]]; then
  ok ".env.prod already exists — skipping"
else
  [[ -f "$EXAMPLE" ]] || die "$EXAMPLE not found. Is this a complete clone of the repository?"

  jwt_secret=$(new_hex_secret)
  jwt_refresh_secret=$(new_hex_secret)
  pg_password=$(new_hex_secret)

  # Strip carriage returns, patch generated secrets and CORS origin
  content=$(tr -d '\r' < "$EXAMPLE")
  content=$(echo "$content" | sed "s|^JWT_SECRET=.*|JWT_SECRET=$jwt_secret|")
  content=$(echo "$content" | sed "s|^JWT_REFRESH_SECRET=.*|JWT_REFRESH_SECRET=$jwt_refresh_secret|")
  content=$(echo "$content" | sed "s|^CORS_ORIGIN=.*|CORS_ORIGIN=http://localhost|")
  # Postgres password appears twice: the standalone var and inside the URL.
  content=$(echo "$content" | sed "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$pg_password|")
  content=$(echo "$content" | sed "s|^POSTGRES_URL=postgresql://vault:[^@]*@|POSTGRES_URL=postgresql://vault:$pg_password@|")

  printf '%s\n' "$content" > "$ENV_FILE"
  ok ".env.prod created with generated secrets (JWT + Postgres)"
fi

missing_keys=()
for key in "${REQUIRED_ENV_KEYS[@]}"; do
  value=$(get_env_value "$key")
  if [[ -z "${value// /}" ]]; then
    missing_keys+=("$key")
  fi
done

if [[ ${#missing_keys[@]} -gt 0 ]]; then
  die ".env.prod is missing required non-empty values: ${missing_keys[*]}. Update .env.prod and re-run setup."
fi

ok "Required .env.prod values are present"

# ---------------------------------------------------------------------------
# 3. Build and start everything
# ---------------------------------------------------------------------------
step "Building and starting Vault (this may take a few minutes on first run)"

# Phase 1: build images
# docker compose build can exit non-zero on some systems even when images
# built successfully (BuildKit stderr output). Treat as a real failure only
# when the output also contains an ERROR line.
echo "  Building images (this may take a few minutes on first run)..."
build_log=$(mktemp)
set +e
docker "${COMPOSE_ARGS[@]}" --progress plain build 2>&1 | tee "$build_log"
build_exit=${PIPESTATUS[0]}
set -e
if [[ $build_exit -ne 0 ]] && grep -qm1 'ERROR' "$build_log" 2>/dev/null; then
  rm -f "$build_log"
  die "Build failed. See output above."
fi
rm -f "$build_log"

# Phase 2: start services
printf "  Starting services..."
set +e
up_out=$(docker "${COMPOSE_ARGS[@]}" up -d 2>&1)
up_exit=$?
set -e
if [[ $up_exit -eq 0 ]]; then
  echo " done"
else
  echo " failed"
  echo "$up_out" | tail -40
  die "Startup failed. See output above."
fi

# ---------------------------------------------------------------------------
# 4. Verify service health
# ---------------------------------------------------------------------------
step "Verifying service health"
assert_services_healthy
ok "All services started and verified"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo -e "${GREEN}${BOLD}Vault is running!${NC}"
echo ""
echo -e "  Web app       ->  $(hyperlink http://localhost http://localhost)"
echo -e "  API           ->  $(hyperlink http://localhost:8000 http://localhost:8000)"
echo ""
echo "To stop:   docker compose --env-file .env.prod -f infra/docker/docker-compose.prod.yml down"
echo "To start:  docker compose --env-file .env.prod -f infra/docker/docker-compose.prod.yml up -d"
echo ""
