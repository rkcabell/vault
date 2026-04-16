#!/usr/bin/env bash
# Vault entry point — install or start, detected automatically.
# Usage: bash vault.sh   (or ./vault.sh after chmod +x)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$DIR/.env.prod"
COMPOSE_FILE="$DIR/infra/docker/docker-compose.prod.yml"
COMPOSE="docker compose --env-file $ENV_FILE -f $COMPOSE_FILE"

if [[ -f "$ENV_FILE" ]] && command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
    RUNNING=$($COMPOSE ps -q 2>/dev/null || true)
    if [[ -n "$RUNNING" ]]; then
        echo "Vault is already running → http://localhost"
        exit 0
    fi
    echo "Starting Vault..."
    $COMPOSE up -d
    echo "Vault is running → http://localhost"
    exit 0
fi

# Full install
bash "$DIR/scripts/vault-setup-linux.sh"
