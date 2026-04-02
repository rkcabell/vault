# scripts/windows-setup.ps1 — One-shot Vault setup on Windows.
# Requires only Docker Desktop — no Node.js needed.
#
# Run from the repo root in PowerShell:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   .\scripts\windows-setup.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ROOT = Split-Path -Parent $PSScriptRoot

$step = 0
function Step($msg) { $script:step++; Write-Host "`n[$($script:step)] $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  + $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "`nError: $msg" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------------------
# 1. Docker Desktop
# ---------------------------------------------------------------------------
Step "Checking Docker Desktop"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "  Installing Docker Desktop via winget..."
    winget install Docker.DockerDesktop --silent --accept-source-agreements --accept-package-agreements
    Die "Docker Desktop installed. Restart your machine, start Docker Desktop, then re-run this script."
}

try {
    docker compose version | Out-Null
    Ok "Docker ready"
} catch {
    Die "Docker is not running. Start Docker Desktop and re-run this script."
}

# ---------------------------------------------------------------------------
# 2. .env.docker
# ---------------------------------------------------------------------------
Step "Configuring environment"

$ENV_FILE = "$ROOT\.env.docker"
$EXAMPLE  = "$ROOT\.env.docker.example"

if (Test-Path $ENV_FILE) {
    Ok ".env.docker already exists — skipping"
} else {
    if (-not (Test-Path $EXAMPLE)) {
        Die ".env.docker.example not found. Is this a complete clone of the repository?"
    }

    # Generate secrets using PowerShell built-in crypto — no openssl required
    function New-HexSecret {
        $rng   = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        $bytes = New-Object byte[] 32
        $rng.GetBytes($bytes)
        return ([BitConverter]::ToString($bytes) -replace '-', '').ToLower()
    }

    $jwtSecret        = New-HexSecret
    $jwtRefreshSecret = New-HexSecret

    $content = Get-Content $EXAMPLE -Raw
    $content = $content -replace '(?m)^JWT_SECRET=\S+',         "JWT_SECRET=$jwtSecret"
    $content = $content -replace '(?m)^JWT_REFRESH_SECRET=\S+', "JWT_REFRESH_SECRET=$jwtRefreshSecret"

    # Write without BOM and with LF line endings so docker compose parses it cleanly
    [System.IO.File]::WriteAllText($ENV_FILE, ($content -replace "`r`n", "`n"))

    Ok ".env.docker created with generated JWT secrets"
}

# ---------------------------------------------------------------------------
# 3. Build and start everything
# ---------------------------------------------------------------------------
Step "Building and starting Vault (this may take a few minutes on first run)"

docker compose -f "$ROOT\infra\docker\docker-compose.yml" up -d --build

Ok "All services started"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "Vault is running!" -ForegroundColor Green
Write-Host ""
Write-Host "  Web app       ->  http://localhost:3000"
Write-Host "  API           ->  http://localhost:8000"
Write-Host "  MinIO console ->  http://localhost:9001  (vault / vaultvault)"
Write-Host ""
Write-Host "To stop:   docker compose -f infra\docker\docker-compose.yml down"
Write-Host "To start:  docker compose -f infra\docker\docker-compose.yml up -d"
Write-Host ""
