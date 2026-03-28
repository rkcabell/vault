# scripts/setup.ps1 — Bootstrap Vault for local development on Windows.
# Run from repo root in an elevated PowerShell terminal:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   .\scripts\setup.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ROOT = Split-Path -Parent $PSScriptRoot
$ENV_FILE = "$ROOT\apps\api\.env"

$step = 0
function Step($msg)  { $script:step++; Write-Host "`n[$($script:step)] $msg" -ForegroundColor Cyan }
function Ok($msg)    { Write-Host "  + $msg" -ForegroundColor Green }
function Warn($msg)  { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Die($msg)   { Write-Host "`nError: $msg" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------------------
# 1. Node.js
# ---------------------------------------------------------------------------
Step "Checking Node.js"
if (Get-Command node -ErrorAction SilentlyContinue) {
    Ok "node $(node --version) already installed"
} else {
    Write-Host "  Installing Node.js 20 via winget..."
    winget install OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
    # Refresh PATH
    $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH', 'User')
    if (Get-Command node -ErrorAction SilentlyContinue) {
        Ok "node installed"
    } else {
        Warn "Node.js installed but not yet on PATH — open a new terminal after setup completes"
    }
}

# ---------------------------------------------------------------------------
# 2. Docker Desktop
# ---------------------------------------------------------------------------
Step "Checking Docker"
if (Get-Command docker -ErrorAction SilentlyContinue) {
    Ok "docker already installed"
} else {
    Write-Host "  Installing Docker Desktop via winget..."
    winget install Docker.DockerDesktop --silent --accept-source-agreements --accept-package-agreements
    Warn "Docker Desktop installed — you may need to restart and re-run this script before continuing"
    Warn "Ensure WSL2 is enabled: wsl --install"
}

# Verify Docker is actually running
try {
    docker compose version | Out-Null
    Ok "docker compose ready"
} catch {
    Die "Docker is not running. Start Docker Desktop and re-run this script."
}

# ---------------------------------------------------------------------------
# 3. npm install
# ---------------------------------------------------------------------------
Step "Installing dependencies"
Set-Location $ROOT
npm install
Ok "node_modules ready"

Step "Building internal packages"
npm run build --workspace=packages/db
Ok "@vault/db built"

# ---------------------------------------------------------------------------
# 4. Create .env if missing
# ---------------------------------------------------------------------------
Step "Configuring environment"
if (Test-Path $ENV_FILE) {
    Ok "apps/api/.env already exists — skipping"
} else {
    $JWT_SECRET = node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
    $JWT_REFRESH_SECRET = node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"

    @"
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
"@ | Set-Content $ENV_FILE

    Ok "apps/api/.env created with generated JWT secrets"
}

# ---------------------------------------------------------------------------
# 5. Start infrastructure
# ---------------------------------------------------------------------------
Step "Starting Docker infrastructure"
docker compose -f "$ROOT\infra\docker\docker-minimal.yml" up -d postgres redis minio
Ok "Containers started"

# ---------------------------------------------------------------------------
# 6. Wait for services
# ---------------------------------------------------------------------------
Step "Waiting for services to be ready"

function WaitFor($label, $cmd) {
    Write-Host -NoNewline "  $($label.PadRight(12))"
    for ($i = 0; $i -lt 30; $i++) {
        try {
            Invoke-Expression $cmd 2>$null | Out-Null
            Write-Host " ready" -ForegroundColor Green
            return
        } catch {}
        Write-Host -NoNewline "."
        Start-Sleep -Seconds 2
    }
    Write-Host ""
    Die "$label did not become ready."
}

WaitFor "postgres" "docker compose -f `"$ROOT\infra\docker\docker-minimal.yml`" exec -T postgres pg_isready -U vault -d vault"
WaitFor "redis"    "docker compose -f `"$ROOT\infra\docker\docker-minimal.yml`" exec -T redis redis-cli ping"
WaitFor "minio"    "docker compose -f `"$ROOT\infra\docker\docker-minimal.yml`" exec -T minio curl -sf http://localhost:9000/minio/health/live"

# ---------------------------------------------------------------------------
# 7. Create MinIO bucket
# ---------------------------------------------------------------------------
Step "Creating MinIO bucket"
Set-Location "$ROOT\apps\api"
node --input-type=module @"
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
const client = new S3Client({
  endpoint: 'http://localhost:9000',
  region: 'us-east-1',
  credentials: { accessKeyId: 'vault', secretAccessKey: 'vaultvault' },
  forcePathStyle: true,
});
try {
  await client.send(new HeadBucketCommand({ Bucket: 'vault-media' }));
  console.log('  Bucket already exists: vault-media');
} catch {
  await client.send(new CreateBucketCommand({ Bucket: 'vault-media' }));
  console.log('  Bucket created: vault-media');
}
"@
Set-Location $ROOT
Ok "MinIO bucket ready"

# ---------------------------------------------------------------------------
# 8. Prisma
# ---------------------------------------------------------------------------
Step "Setting up database"
$SCHEMA = "$ROOT\packages\db\prisma\schema.prisma"
npx prisma generate --schema $SCHEMA
Ok "Prisma client generated"

npx prisma migrate deploy --schema $SCHEMA
Ok "Migrations applied"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host ""
Write-Host "  Start (dev mode):  " -NoNewline; Write-Host "npm run boot" -ForegroundColor White
Write-Host "    API              ->  http://localhost:8000"
Write-Host "    Web              ->  http://localhost:3000"
Write-Host "    MinIO console    ->  http://localhost:9001"
Write-Host ""
