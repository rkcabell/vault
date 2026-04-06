#!/usr/bin/env bash
# scripts/linux-setup.sh — Bootstrap Vault for local development from scratch.
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
ENV_FILE="$ROOT/apps/api/.env"
COMPOSE="docker compose -f $ROOT/infra/docker/docker-minimal.yml"

step() { echo -e "\n${BLUE}${BOLD}[$((++STEP))] $1${NC}"; }
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
die()  { echo -e "\n${RED}${BOLD}Error: $1${NC}" >&2; exit 1; }
STEP=0

# ---------------------------------------------------------------------------
# 1. System dependencies (auto-install on Debian/Ubuntu if apt is available)
# ---------------------------------------------------------------------------
step "Checking system dependencies"

install_apt() {
  local pkg="$1"; local cmd="${2:-$1}"
  if command -v "$cmd" &>/dev/null; then
    ok "$cmd already installed"
  elif command -v apt-get &>/dev/null; then
    echo "  Installing $pkg via apt-get..."
    apt-get install -y "$pkg" -qq
    ok "$pkg installed"
  else
    warn "$cmd not found and apt-get unavailable — install manually"
  fi
}

# Node.js >= 18.18
if ! command -v node &>/dev/null; then
  if command -v apt-get &>/dev/null; then
    echo "  Installing Node.js 20.x via NodeSource..."
    apt-get install -y ca-certificates curl gnupg -qq
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs -qq
    ok "node installed"
  else
    die "node is required but not found. Install Node.js >=18.18 from https://nodejs.org"
  fi
else
  ok "node"
fi

# pnpm
if ! command -v pnpm &>/dev/null; then
  echo "  Installing pnpm..."
  corepack enable && corepack prepare pnpm@10.33.0 --activate
  ok "pnpm installed"
else
  ok "pnpm"
fi

# Docker + Docker Compose v2
if ! command -v docker &>/dev/null; then
  if command -v apt-get &>/dev/null; then
    echo "  Installing Docker via apt-get..."
    apt-get install -y ca-certificates curl gnupg -qq
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      | tee /etc/apt/sources.list.d/docker.list > /dev/null
    apt-get update -qq
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin -qq
    ok "docker installed"
  else
    die "docker is required but not found. Install from https://docs.docker.com/get-docker/"
  fi
else
  ok "docker"
fi
docker compose version &>/dev/null || die "Docker Compose v2 is required. See https://docs.docker.com/compose/install/"
ok "docker compose"

# Optional OCR tools
for entry in "ocrmypdf:ocrmypdf" "tesseract-ocr:tesseract" "ghostscript:gs" "qpdf:qpdf"; do
  pkg="${entry%%:*}"; cmd="${entry##*:}"
  if command -v "$cmd" &>/dev/null; then
    ok "$cmd"
  elif command -v apt-get &>/dev/null; then
    echo "  Installing $pkg..."
    apt-get install -y "$pkg" -qq && ok "$cmd installed"
  else
    warn "$cmd not found — OCR processing will be unavailable"
  fi
done

# ---------------------------------------------------------------------------
# 2. pnpm install + build internal packages
# ---------------------------------------------------------------------------
step "Installing dependencies"
pnpm install --dir "$ROOT"
ok "node_modules ready"

step "Building internal packages"
pnpm -F @vault/db run build
ok "@vault/db built"

# ---------------------------------------------------------------------------
# 3. Create .env if missing
# ---------------------------------------------------------------------------
step "Configuring environment"

if [[ -f "$ENV_FILE" ]]; then
  ok "apps/api/.env already exists — skipping"
else
  JWT_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
  JWT_REFRESH_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")

  cat > "$ENV_FILE" <<EOF
NODE_ENV=development
HOST=127.0.0.1
PORT=8000
CORS_ORIGIN=http://localhost:3000

POSTGRES_URL=postgresql://vault:vault@localhost:5432/vault?schema=public

JWT_SECRET=$JWT_SECRET
JWT_REFRESH_SECRET=$JWT_REFRESH_SECRET

S3_ENDPOINT=http://localhost:9000
S3_PUBLIC_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=vault
S3_SECRET_ACCESS_KEY=vaultvault
S3_BUCKET=vault-media

REDIS_URL=redis://localhost:6379
EOF

  ok "apps/api/.env created with generated JWT secrets"
fi

# Load .env into the environment for all subsequent steps (Prisma, Node, etc.)
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

_env_val() { grep "^$1=" "$ENV_FILE" | cut -d= -f2-; }
S3_ENDPOINT=$(_env_val S3_ENDPOINT)
S3_ACCESS_KEY_ID=$(_env_val S3_ACCESS_KEY_ID)
S3_SECRET_ACCESS_KEY=$(_env_val S3_SECRET_ACCESS_KEY)
S3_BUCKET=$(_env_val S3_BUCKET)

# ---------------------------------------------------------------------------
# 4. Start infrastructure
# ---------------------------------------------------------------------------
step "Starting Docker infrastructure"
$COMPOSE up -d postgres redis minio
ok "Containers started"

# ---------------------------------------------------------------------------
# 5. Wait for services
# ---------------------------------------------------------------------------
step "Waiting for services to be ready"

wait_for() {
  local label="$1"; shift
  local max=30
  printf "  %-12s" "$label"
  for _ in $(seq 1 $max); do
    if "$@" &>/dev/null; then
      echo -e " ${GREEN}ready${NC}"
      return 0
    fi
    printf "."
    sleep 2
  done
  echo ""
  die "$label did not become ready. Check logs: $COMPOSE logs"
}

wait_for "postgres" $COMPOSE exec -T postgres pg_isready -U vault -d vault
wait_for "redis"    $COMPOSE exec -T redis redis-cli ping
wait_for "minio"    $COMPOSE exec -T minio curl -sf http://localhost:9000/minio/health/live

# ---------------------------------------------------------------------------
# 6. Create MinIO bucket
# ---------------------------------------------------------------------------
step "Creating MinIO bucket"

# Run from apps/api so Node resolves @aws-sdk/client-s3 from that workspace
(cd "$ROOT/apps/api" && node --input-type=module <<EOF
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';

const client = new S3Client({
  endpoint: '$S3_ENDPOINT',
  region: 'us-east-1',
  credentials: {
    accessKeyId: '$S3_ACCESS_KEY_ID',
    secretAccessKey: '$S3_SECRET_ACCESS_KEY',
  },
  forcePathStyle: true,
});

try {
  await client.send(new HeadBucketCommand({ Bucket: '$S3_BUCKET' }));
  console.log('  Bucket already exists: $S3_BUCKET');
} catch {
  await client.send(new CreateBucketCommand({ Bucket: '$S3_BUCKET' }));
  console.log('  Bucket created: $S3_BUCKET');
}
EOF
)
ok "MinIO bucket ready"

# ---------------------------------------------------------------------------
# 7. Generate Prisma client + migrate
# ---------------------------------------------------------------------------
step "Setting up database"

SCHEMA="$ROOT/packages/db/prisma/schema.prisma"
(cd "$ROOT" && pnpm exec prisma generate --schema "$SCHEMA")
ok "Prisma client generated"

(cd "$ROOT" && pnpm exec prisma migrate deploy --schema "$SCHEMA")
ok "Migrations applied"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo -e "${GREEN}${BOLD}Setup complete.${NC}"
echo ""
echo -e "  Start everything:  ${BOLD}pnpm run start${NC}"
echo -e "    API              →  http://localhost:8000"
echo -e "    Web              →  http://localhost:3000"
echo -e "    MinIO console    →  http://localhost:9001"
echo ""
