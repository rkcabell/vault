# scripts/windows-setup.ps1 - One-shot Vault setup on Windows.
# Requires only Docker Desktop - no Node.js needed.
#
# Run from the repo root (PowerShell, cmd, Git Bash, or Windows Terminal):
#   powershell -ExecutionPolicy Bypass -File scripts\windows-setup.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ROOT = Split-Path -Parent $PSScriptRoot
$ENV_FILE = Join-Path $ROOT ".env.prod"
$EXAMPLE = Join-Path $ROOT ".env.docker.example"
$COMPOSE_FILE = Join-Path $ROOT "infra\docker\docker-compose.prod.yml"
$REQUIRED_ENV_KEYS = @(
    "POSTGRES_PASSWORD",
    "MINIO_ROOT_PASSWORD",
    "JWT_SECRET",
    "JWT_REFRESH_SECRET"
)

$step = 0
function Step($msg) { $script:step++; Write-Host "`n[$($script:step)] $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  + $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "`nError: $msg" -ForegroundColor Red; exit 1 }

function New-HexSecret {
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = New-Object byte[] 32
    $rng.GetBytes($bytes)
    return ([BitConverter]::ToString($bytes) -replace "-", "").ToLower()
}

function Wait-DockerReady {
    param([int]$TimeoutSeconds = 120, [int]$IntervalSeconds = 2)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    Write-Host "  Waiting for Docker daemon" -NoNewline
    while ((Get-Date) -lt $deadline) {
        & docker info *> $null
        if ($LASTEXITCODE -eq 0) { Write-Host " ready"; return $true }
        Write-Host "." -NoNewline
        Start-Sleep -Seconds $IntervalSeconds
    }
    Write-Host " timed out"
    return $false
}

function Show-DockerDiagnostics {
    Warn "Docker diagnostics:"
    $context = (& docker context show 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -eq 0 -and $context) {
        Write-Host "  Context: $context" -ForegroundColor Yellow
    } else {
        Write-Host "  Context: unavailable" -ForegroundColor Yellow
    }

    & docker version 2>$null
    if ($LASTEXITCODE -ne 0) {
        Warn "docker version failed. Docker daemon may not be running."
    }
}

function Get-ComposeBaseArgs {
    return @(
        "compose",
        "--env-file", $ENV_FILE,
        "-f", $COMPOSE_FILE
    )
}

function Show-ComposeDiagnostics {
    Warn "Compose diagnostics:"

    & docker @(Get-ComposeBaseArgs) ps 2>$null
    if ($LASTEXITCODE -ne 0) {
        Warn "Unable to read compose service status."
    }

    & docker @(Get-ComposeBaseArgs) logs --tail 80 postgres redis minio minio-init api web jobs-ocr jobs-thumb nginx 2>$null
    if ($LASTEXITCODE -ne 0) {
        Warn "Unable to read compose logs."
    }
}

function Invoke-ComposeUp {
    # Phase 1: build images
    # Temporarily lower ErrorActionPreference so docker's stderr output (e.g. build status
    # messages) doesn't throw NativeCommandError under the global "Stop" policy.
    Write-Host "  Building images (this may take a few minutes on first run)..."
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & docker @(Get-ComposeBaseArgs) --progress plain build 2>&1 | Tee-Object -Variable buildLines
    $buildExitCode = $LASTEXITCODE
    $ErrorActionPreference = $prevEAP

    # On Windows, docker compose build can exit non-zero even when all images built
    # successfully (redirected stdout/stderr changes BuildKit's exit behaviour).
    # Treat it as a real failure only when the output also contains an ERROR line.
    if (($buildExitCode -ne 0) -and (($buildLines | Out-String) -match '(?m)ERROR')) {
        return $false
    }

    # Phase 2: start services
    # Temporarily lower ErrorActionPreference so docker's stderr warnings (e.g. orphan
    # containers) don't throw NativeCommandError under the global "Stop" policy.
    Write-Host "  Starting services..." -NoNewline
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $upOutput = & docker @(Get-ComposeBaseArgs) up -d 2>&1
    $upExitCode = $LASTEXITCODE
    $ErrorActionPreference = $prevEAP
    Write-Host $(if ($upExitCode -eq 0) { " done" } else { " failed" })

    if ($upExitCode -ne 0) {
        ($upOutput | Select-Object -Last 40 | Out-String).Trim() | Write-Host
        return $false
    }

    return $true
}

function Get-EnvValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Key
    )

    $pattern = "^(?i:$([Regex]::Escape($Key)))=(.*)$"
    $match = Select-String -Path $Path -Pattern $pattern | Select-Object -First 1
    if (-not $match) {
        return $null
    }

    return $match.Matches[0].Groups[1].Value.Trim()
}

function Assert-ServicesHealthy {
    $issues = @()
    $baseArgs = Get-ComposeBaseArgs
    $runningServices = @("postgres", "redis", "minio", "api", "web", "jobs-ocr", "jobs-thumb", "nginx")

    foreach ($service in $runningServices) {
        $id = (& docker @baseArgs ps -q $service 2>$null | Out-String).Trim()
        if (-not $id) { $issues += "$service container is missing"; continue }
        $status = (& docker inspect -f "{{.State.Status}}" $id 2>$null | Out-String).Trim()
        if ($status -ne "running") {
            $issues += "$service status is '$status' (expected 'running')"
        }
    }

    $initId = (& docker @baseArgs ps --all -q minio-init 2>$null | Out-String).Trim()
    if (-not $initId) {
        $issues += "minio-init container is missing"
    } else {
        $initStatus   = (& docker inspect -f "{{.State.Status}}"   $initId 2>$null | Out-String).Trim()
        $initExitCode = (& docker inspect -f "{{.State.ExitCode}}" $initId 2>$null | Out-String).Trim()
        if ($initStatus -ne "exited" -or $initExitCode -ne "0") {
            $issues += "minio-init status is '$initStatus' with exit code '$initExitCode' (expected exited/0)"
        }
    }

    if ($issues.Count -gt 0) {
        foreach ($issue in $issues) { Warn $issue }
        Show-ComposeDiagnostics
        Die "Vault services are not healthy. See diagnostics above."
    }
}

# ---------------------------------------------------------------------------
# 1. Docker Desktop
# ---------------------------------------------------------------------------
Step "Checking Docker Desktop"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "  Installing Docker Desktop via winget..."
    & winget install Docker.DockerDesktop --silent --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) {
        Die "Failed to install Docker Desktop via winget."
    }

    Die "Docker Desktop installed. Restart your machine, start Docker Desktop, then re-run this script."
}

Step "Waiting for Docker Engine"
if (Wait-DockerReady -TimeoutSeconds 120 -IntervalSeconds 2) {
    Ok "Docker daemon is reachable"
} else {
    Show-DockerDiagnostics
    Die "Docker daemon did not become ready within 120s. Start Docker Desktop and re-run this script."
}

# ---------------------------------------------------------------------------
# 2. .env.prod
# ---------------------------------------------------------------------------
Step "Configuring environment"

if (Test-Path $ENV_FILE) {
    Ok ".env.prod already exists - skipping"
} else {
    if (-not (Test-Path $EXAMPLE)) {
        Die "$EXAMPLE not found. Is this a complete clone of the repository?"
    }

    $jwtSecret = New-HexSecret
    $jwtRefreshSecret = New-HexSecret

    $content = Get-Content $EXAMPLE -Raw
    $content = $content -replace "(?m)^JWT_SECRET=\S+", "JWT_SECRET=$jwtSecret"
    $content = $content -replace "(?m)^JWT_REFRESH_SECRET=\S+", "JWT_REFRESH_SECRET=$jwtRefreshSecret"
    $content = $content -replace "(?m)^CORS_ORIGIN=\S+", "CORS_ORIGIN=http://localhost"

    # Write without BOM and with LF line endings so docker compose parses it cleanly.
    [System.IO.File]::WriteAllText($ENV_FILE, ($content -replace "`r`n", "`n"))

    Ok ".env.prod created with generated JWT secrets"
}

$missingKeys = @()
foreach ($key in $REQUIRED_ENV_KEYS) {
    $value = Get-EnvValue -Path $ENV_FILE -Key $key
    if ([string]::IsNullOrWhiteSpace($value)) {
        $missingKeys += $key
    }
}

if ($missingKeys.Count -gt 0) {
    Die ".env.prod is missing required non-empty values: $($missingKeys -join ', '). Update .env.prod and re-run setup."
}

Ok "Required .env.prod values are present"

# ---------------------------------------------------------------------------
# 3. Build and start everything
# ---------------------------------------------------------------------------
Step "Building and starting Vault (this may take a few minutes on first run)"

Invoke-ComposeUp | Out-Null

Step "Verifying service health"
Assert-ServicesHealthy
Ok "All services started and verified"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "Vault is running!" -ForegroundColor Green
Write-Host ""
Write-Host "  Web app       ->  http://localhost"
Write-Host "  API           ->  http://localhost:8000"
Write-Host "  MinIO console ->  http://localhost:9001  (vault / vaultvault)"
Write-Host ""
Write-Host "To stop:   docker compose --env-file .env.prod -f infra\docker\docker-compose.prod.yml down"
Write-Host "To start:  docker compose --env-file .env.prod -f infra\docker\docker-compose.prod.yml up -d"
Write-Host ""
