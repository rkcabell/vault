# tools/Make.ps1
function up { docker compose -f infra/docker/docker-compose.yml up -d }
function down { docker compose -f infra/docker/docker-compose.yml down }
function nuke { docker compose -f infra/docker/docker-compose.yml down -v }
function logs { docker compose -f infra/docker/docker-compose.yml logs -f }

function apiDev { Push-Location apps/api; npm run dev; Pop-Location }
function worker { Push-Location apps/api; npm run worker; Pop-Location }
function lint { Push-Location apps/api; npm run lint; Pop-Location }
function lintFix { Push-Location apps/api; npm run lint:fix; Pop-Location }
function fmt { Push-Location apps/api; npm run format; Pop-Location }
function typecheck { Push-Location apps/api; npm run typecheck; Pop-Location }

Write-Host "Loaded: up, down, nuke, logs, apiDev, worker, lint, lintFix, fmt, typecheck" -ForegroundColor Green
