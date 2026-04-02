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
function Ok($msg) { Write-Host "  + $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Die($msg) { Write-Host "`nError: $msg" -ForegroundColor Red; exit 1 }

function New-AsciiProgressBar {
    param(
        [Parameter(Mandatory = $true)]
        [int]$Percent,
        [int]$Width = 44
    )

    $clamped = [Math]::Max(0, [Math]::Min(100, $Percent))
    $filled = [int][Math]::Floor(($clamped / 100) * $Width)
    $segments = @(" ") * $Width

    for ($i = 0; $i -lt $filled; $i++) {
        $segments[$i] = "="
    }

    $label = "[$clamped%]"
    $start = [Math]::Max(0, [int][Math]::Floor(($Width - $label.Length) / 2))
    for ($i = 0; $i -lt $label.Length -and ($start + $i) -lt $Width; $i++) {
        $segments[$start + $i] = $label[$i]
    }

    return "[" + ($segments -join "") + "]"
}

function Write-AsciiProgressLine {
    param(
        [Parameter(Mandatory = $true)]
        [int]$Percent,
        [Parameter(Mandatory = $true)]
        [string]$Label,
        [string]$Suffix = ""
    )

    $bar = New-AsciiProgressBar -Percent $Percent
    $line = "  $Label $bar"
    if (-not [string]::IsNullOrWhiteSpace($Suffix)) {
        $line += " $Suffix"
    }

    # Pad to clear remnants from the previous redraw.
    Write-Host -NoNewline ("`r" + $line.PadRight(140))
}

function Wait-DockerReady {
    param(
        [int]$TimeoutSeconds = 120,
        [int]$IntervalSeconds = 2
    )

    $startedAt = Get-Date
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        & docker info --format "{{.ServerVersion}}" *> $null
        if ($LASTEXITCODE -eq 0) {
            $elapsedSuccess = [int][Math]::Floor(((Get-Date) - $startedAt).TotalSeconds)
            Write-AsciiProgressLine -Percent 100 -Label "Docker readiness" -Suffix "ready in ${elapsedSuccess}s"
            Write-Host ""
            return $true
        }

        $elapsedSeconds = [int][Math]::Floor(((Get-Date) - $startedAt).TotalSeconds)
        $percent = [int][Math]::Floor(($elapsedSeconds / $TimeoutSeconds) * 100)
        Write-AsciiProgressLine -Percent $percent -Label "Docker readiness" -Suffix "${elapsedSeconds}s/${TimeoutSeconds}s"
        Start-Sleep -Seconds $IntervalSeconds
    }

    Write-AsciiProgressLine -Percent 100 -Label "Docker readiness" -Suffix "timeout after ${TimeoutSeconds}s"
    Write-Host ""
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

function Invoke-ComposeUpWithProgress {
    param(
        [int]$EstimateSeconds = 300,
        [int]$RefreshIntervalMs = 500
    )

    $composeArgs = @(Get-ComposeBaseArgs) + @("up", "-d", "--build")
    $stdoutFile = [System.IO.Path]::GetTempFileName()
    $stderrFile = [System.IO.Path]::GetTempFileName()
    $process = $null
    $exitCode = 1

    try {
        $process = Start-Process -FilePath "docker" -ArgumentList $composeArgs -NoNewWindow -PassThru -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
        $startedAt = Get-Date

        while (-not $process.HasExited) {
            $elapsedSeconds = [int][Math]::Floor(((Get-Date) - $startedAt).TotalSeconds)
            $percent = [int][Math]::Min(99, [Math]::Floor(($elapsedSeconds / $EstimateSeconds) * 100))
            Write-AsciiProgressLine -Percent $percent -Label "Compose build" -Suffix "${elapsedSeconds}s elapsed"
            Start-Sleep -Milliseconds $RefreshIntervalMs
            $process.Refresh()
        }

        $process.WaitForExit()
        $exitCode = $process.ExitCode
        $totalSeconds = [int][Math]::Floor(((Get-Date) - $startedAt).TotalSeconds)
        $resultLabel = if ($exitCode -eq 0) { "completed in ${totalSeconds}s" } else { "failed in ${totalSeconds}s" }
        Write-AsciiProgressLine -Percent 100 -Label "Compose build" -Suffix $resultLabel
        Write-Host ""

        if ($exitCode -ne 0) {
            $stderrTail = (Get-Content -Path $stderrFile -Tail 40 -ErrorAction SilentlyContinue | Out-String).Trim()
            if ($stderrTail) {
                Warn "docker compose stderr (tail):"
                Write-Host $stderrTail
            }

            $stdoutTail = (Get-Content -Path $stdoutFile -Tail 40 -ErrorAction SilentlyContinue | Out-String).Trim()
            if ($stdoutTail) {
                Warn "docker compose stdout (tail):"
                Write-Host $stdoutTail
            }
        }

        return ($exitCode -eq 0)
    } finally {
        foreach ($path in @($stdoutFile, $stderrFile)) {
            if ($path -and (Test-Path $path)) {
                Remove-Item -LiteralPath $path -ErrorAction SilentlyContinue
            }
        }
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
    $runningServices = @("postgres", "redis", "minio", "api", "web", "jobs-ocr", "jobs-thumb", "nginx")

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
# 2. .env.prod
# ---------------------------------------------------------------------------
Step "Configuring environment"

if (Test-Path $ENV_FILE) {
    Ok ".env.prod already exists - skipping"
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
    $content = $content -replace "(?m)^CORS_ORIGIN=\S+", "CORS_ORIGIN=http://localhost"

    # Write without BOM and with LF line endings so docker compose parses it cleanly.
    [System.IO.File]::WriteAllText($ENV_FILE, ($content -replace "`r`n", "`n"))

    Ok ".env.prod created with generated JWT secrets"
}

if (-not (Test-Path $ENV_FILE)) {
    Die ".env.prod was not created."
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

if (-not (Invoke-ComposeUpWithProgress -EstimateSeconds 480 -RefreshIntervalMs 500)) {
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
Write-Host "  Web app       ->  http://localhost"
Write-Host "  API           ->  http://localhost:8000"
Write-Host "  MinIO console ->  http://localhost:9001  (vault / vaultvault)"
Write-Host ""
Write-Host "To stop:   docker compose --env-file .env.prod -f infra\docker\docker-compose.prod.yml down"
Write-Host "To start:  docker compose --env-file .env.prod -f infra\docker\docker-compose.prod.yml up -d"
Write-Host ""
