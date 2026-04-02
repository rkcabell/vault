# scripts/windows-setup.ps1 - One-shot Vault setup on Windows.
# Requires only Docker Desktop - no Node.js needed.
#
# Run from the repo root (PowerShell, cmd, Git Bash, or Windows Terminal):
#   powershell -ExecutionPolicy Bypass -File scripts\windows-setup.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ROOT = Split-Path -Parent $PSScriptRoot
$ENV_FILE = Join-Path $ROOT ".env.docker"
$EXAMPLE = Join-Path $ROOT ".env.docker.example"
$COMPOSE_FILE = Join-Path $ROOT "infra\docker\docker-compose.yml"
$REQUIRED_ENV_KEYS = @(
    "POSTGRES_PASSWORD",
    "MINIO_ROOT_PASSWORD",
    "JWT_SECRET",
    "JWT_REFRESH_SECRET"
)

$step = 0
function Step($msg) { $script:step++; Write-Host "`n[$($script:step)] $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "  + $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Die($msg) { Write-Host "`nError: $msg" -ForegroundColor Red; exit 1 }

function Wait-DockerReady {
    param(
        [int]$TimeoutSeconds = 120,
        [int]$IntervalSeconds = 2
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        & docker info --format "{{.ServerVersion}}" *> $null
        if ($LASTEXITCODE -eq 0) {
            return $true
        }
        Start-Sleep -Seconds $IntervalSeconds
    }

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

    & docker @(Get-ComposeBaseArgs) logs --tail 80 postgres redis minio minio-init api web jobs-ocr jobs-thumb 2>$null
    if ($LASTEXITCODE -ne 0) {
        Warn "Unable to read compose logs."
    }
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

function Get-ServiceContainerId {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Service
    )

    $raw = & docker @(Get-ComposeBaseArgs) ps -q $Service 2>$null
    if ($LASTEXITCODE -ne 0) {
        return $null
    }

    return ($raw | Out-String).Trim()
}

function Get-ContainerStateField {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ContainerId,
        [Parameter(Mandatory = $true)]
        [string]$Template
    )

    $value = & docker inspect -f $Template $ContainerId 2>$null
    if ($LASTEXITCODE -ne 0) {
        return $null
    }

    return ($value | Out-String).Trim()
}

function Assert-ServicesHealthy {
    $issues = @()
    $runningServices = @("postgres", "redis", "minio", "api", "web", "jobs-ocr", "jobs-thumb")

    foreach ($service in $runningServices) {
        $id = Get-ServiceContainerId -Service $service
        if (-not $id) {
            $issues += "$service container is missing"
            continue
        }

        $status = Get-ContainerStateField -ContainerId $id -Template "{{.State.Status}}"
        if ($status -ne "running") {
            $issues += "$service status is '$status' (expected 'running')"
        }
    }

    $initRaw = & docker @(Get-ComposeBaseArgs) ps --all -q minio-init 2>$null
    $initId = ($initRaw | Out-String).Trim()
    if (-not $initId) {
        $issues += "minio-init container is missing"
    } else {
        $initStatus = Get-ContainerStateField -ContainerId $initId -Template "{{.State.Status}}"
        $initExitCode = Get-ContainerStateField -ContainerId $initId -Template "{{.State.ExitCode}}"
        if ($initStatus -ne "exited" -or $initExitCode -ne "0") {
            $issues += "minio-init status is '$initStatus' with exit code '$initExitCode' (expected exited/0)"
        }
    }

    if ($issues.Count -gt 0) {
        Warn "Service verification failed:"
        foreach ($issue in $issues) {
            Warn $issue
        }
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
# 2. .env.docker
# ---------------------------------------------------------------------------
Step "Configuring environment"

if (Test-Path $ENV_FILE) {
    Ok ".env.docker already exists - skipping"
} else {
    if (-not (Test-Path $EXAMPLE)) {
        Die ".env.docker.example not found. Is this a complete clone of the repository?"
    }

    function New-HexSecret {
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        $bytes = New-Object byte[] 32
        $rng.GetBytes($bytes)
        return ([BitConverter]::ToString($bytes) -replace "-", "").ToLower()
    }

    $jwtSecret = New-HexSecret
    $jwtRefreshSecret = New-HexSecret

    $content = Get-Content $EXAMPLE -Raw
    $content = $content -replace "(?m)^JWT_SECRET=\S+", "JWT_SECRET=$jwtSecret"
    $content = $content -replace "(?m)^JWT_REFRESH_SECRET=\S+", "JWT_REFRESH_SECRET=$jwtRefreshSecret"

    # Write without BOM and with LF line endings so docker compose parses it cleanly.
    [System.IO.File]::WriteAllText($ENV_FILE, ($content -replace "`r`n", "`n"))

    Ok ".env.docker created with generated JWT secrets"
}

if (-not (Test-Path $ENV_FILE)) {
    Die ".env.docker was not created."
}

$missingKeys = @()
foreach ($key in $REQUIRED_ENV_KEYS) {
    $value = Get-EnvValue -Path $ENV_FILE -Key $key
    if ([string]::IsNullOrWhiteSpace($value)) {
        $missingKeys += $key
    }
}

if ($missingKeys.Count -gt 0) {
    Die ".env.docker is missing required non-empty values: $($missingKeys -join ', '). Update .env.docker and re-run setup."
}

Ok "Required .env.docker values are present"

# ---------------------------------------------------------------------------
# 3. Build and start everything
# ---------------------------------------------------------------------------
Step "Building and starting Vault (this may take a few minutes on first run)"

& docker @(Get-ComposeBaseArgs) up -d --build
if ($LASTEXITCODE -ne 0) {
    Show-ComposeDiagnostics
    Die "Failed to build/start Vault services."
}

Step "Verifying service health"
Assert-ServicesHealthy
Ok "All services started and verified"

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
Write-Host "To stop:   docker compose --env-file .env.docker -f infra\docker\docker-compose.yml down"
Write-Host "To start:  docker compose --env-file .env.docker -f infra\docker\docker-compose.yml up -d"
Write-Host ""
