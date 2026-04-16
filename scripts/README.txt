There are 4 files in this folder


_windows-setup.ps1
    - Installs Docker Desktop if not found
    # All setup happens in docker containers

vault-setup-linux
* Requires Docker engine to be running
    - Checks for Docker and starts the full Vault docker stack
    # All setup happens in docker containers

vault-setup-linux-dev
* Requires Docker engine to be running
    % Installs Node.js and pnpm
    # Builds TypeScript packages
    % Runs prisma database migrations
    # Creates MinIO storage bucket
    % Runs minimal docker setup - [ Postgres, Redis, MinIO ]
    # Runs natively on host machine
    % Hot-reload pages
    _ For devs

test-all.mjs 
    - Runs `pnpm run test` and compiles an html test results page
    - vault/test-results/test-results.html