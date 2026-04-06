# Vault

A self-hosted personal document archive. Upload files, extract text via OCR, tag and search everything, set reminders, and organize items into bundles

---

## Core Principles

- **Source-available** — Free for personal and noncommercial use under the PolyForm Noncommercial License. No telemetry, no cloud lock-in, no required accounts.
- **Dependency resilience** — Prefer stable, well-maintained libraries. Every dependency is a future maintenance obligation; the goal is a lean, auditable graph that doesn't break on routine upgrades.
- **Speed** — Uploads bypass the server entirely via presigned S3 URLs. Search is GIN-indexed at the database layer. Thumbnails are generated asynchronously and cached at the edge.
- **Lightweight** — A single `docker compose up` starts a fully functional instance. No SaaS dependencies, no external services required, minimal attack surface.

---

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the full strategic breakdown with a forking tree of possible directions.

**Phase 0 — Foundation (current focus):**
- Email delivery for password reset and reminder notifications
- Share token expiry and access controls
- File deduplication on upload (SHA-256 hash check)
- Bulk operations — multi-select to tag, bundle, or delete
- Text viewer UI fixes (overlap, highlight, resize)

**Coming up:**
- 3D knowledge graph — interactive force-directed node graph of documents and their relationships
- Calendar sync — read-only iCal feed for reminders
- Watch folder ingestion — drop files into a directory and Vault picks them up automatically (NAS-friendly)
- Shared bundles — collaborate on collections without requiring a full multi-user model
- API / web decoupling — cleaner separation to enable headless use and alternative frontends

---

## Pending Changes

| Change | Status | Notes |
| --- | --- | --- |
| Migrate `npm` → `pnpm` | In progress | Faster installs, strict dependency isolation, better monorepo workspace support |

---

## Features

- **File management** — Upload PDFs, images, scans, and receipts with direct-to-storage presigned URLs
- **OCR & text extraction** — Automatic text extraction from images and PDFs via `ocrmypdf` + Tesseract
- **Full-text search** — PostgreSQL native full-text search with GIN-indexed tag filtering
- **Thumbnails** — Auto-generated previews for PDFs, images, and HEIC files
- **Bundles** — Group related media into named, orderable collections
- **Reminders** — Time-based reminders linked to any media item
- **Self-hosted** — No cloud accounts, no subscriptions, no telemetry

---

## Tech Stack

| Layer            | Technology                                                 |
| ---------------- | ---------------------------------------------------------- |
| Frontend         | Next.js 16, React 18, TypeScript, Tailwind CSS 4, Radix UI |
| Backend          | Fastify 4, Node.js ≥18.18, TypeScript                      |
| Database         | PostgreSQL 16 (Prisma ORM)                                 |
| Queue            | BullMQ + Redis 7                                           |
| Storage          | MinIO (S3-compatible)                                      |
| OCR              | ocrmypdf, Tesseract, Ghostscript, qpdf                     |
| Image processing | Sharp, heic-convert, @napi-rs/canvas                       |
| Auth             | JWT (access + refresh tokens), Argon2 password hashing     |

---

## Project Structure

```
vault/
├── apps/
│   ├── api/          # Fastify REST API + BullMQ workers
│   └── web/          # Next.js frontend
├── packages/
│   ├── db/           # Prisma schema and client
│   └── types/        # Shared TypeScript types
├── infra/
│   └── docker/       # Dockerfiles and Compose configs
├── docs/             # OpenAPI spec and test coverage plan
├── test-results/     # Generated HTML test reports
└── scripts/          # linux-setup.sh, windows-setup.ps1
```

---

## Local Setup

### Linux (Ubuntu/Debian)

```bash
# 1. Install git and clipboard support (VMware guests)
sudo apt-get update && sudo apt-get install -y git open-vm-tools-desktop

# 2. Clone
git clone https://github.com/rkcabell/vault.git
cd vault

# 3. Run setup (installs Node.js, Docker, OCR tools, starts infrastructure, runs migrations)
sudo bash scripts/linux-setup.sh

# 4. Add your user to the docker group so you don't need sudo
sudo usermod -aG docker $USER
newgrp docker

# 5. Fix file ownership (setup runs as root, this reclaims the files)
sudo chown -R $USER:$USER ~/vault

# 6. Start
pnpm run start
```

Open [http://localhost:3000](http://localhost:3000).

### Windows

```powershell
git clone https://github.com/rkcabell/vault.git
cd vault
powershell -ExecutionPolicy Bypass -File scripts\windows-setup.ps1
```

Works from PowerShell, cmd, Git Bash, or Windows Terminal. If Docker Desktop was just installed, the script will ask you to restart and re-run.

Open [http://localhost](http://localhost).

To stop or restart Vault:

```powershell
# Stop all services
docker compose --env-file .env.prod -f infra\docker\docker-compose.prod.yml down

# Start again (no rebuild)
docker compose --env-file .env.prod -f infra\docker\docker-compose.prod.yml up -d
```

### macOS

```bash
brew install git node ocrmypdf tesseract ghostscript qpdf
git clone https://github.com/rkcabell/vault.git
cd vault
bash scripts/linux-setup.sh
pnpm run start
```

---

### Manual setup (advanced)

#### 1. Install dependencies

```bash
pnpm install
```

#### 2. Start infrastructure

```bash
pnpm run localdocker
# or: docker compose -f infra/docker/docker-minimal.yml up -d
```

| Service       | URL                     | Credentials              |
| ------------- | ----------------------- | ------------------------ |
| PostgreSQL    | `localhost:5432`        | see `docker-minimal.yml` |
| Redis         | `localhost:6379`        | —                        |
| MinIO API     | `http://localhost:9000` | see `docker-minimal.yml` |
| MinIO Console | `http://localhost:9001` | see `docker-minimal.yml` |

> **MinIO bucket:** Log into the console at `http://localhost:9001` and create a bucket named `vault-media`.

#### 3. Configure environment

Create `apps/api/.env`:

```env
NODE_ENV=development
HOST=127.0.0.1
PORT=8000
CORS_ORIGIN=http://localhost:3000

POSTGRES_URL=postgresql://<user>:<password>@localhost:5432/vault?schema=public

# Generate with: openssl rand -hex 32
JWT_SECRET=<your-secret>
JWT_REFRESH_SECRET=<your-refresh-secret>

S3_ENDPOINT=http://localhost:9000
S3_PUBLIC_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=<minio-access-key>
S3_SECRET_ACCESS_KEY=<minio-secret-key>
S3_BUCKET=<your-bucket-name>

REDIS_URL=redis://localhost:6379
```

#### 4. Set up the database

```bash
pnpm run prismagen      # Generate Prisma client
pnpm run prismigrate    # Apply migrations
```

#### 5. Start development servers

```bash
pnpm run boot
```

Alternatively, run each process in a separate terminal:

```bash
pnpm run api:dev              # API server   → http://localhost:8000
pnpm run web:dev              # Web app      → http://localhost:3000
pnpm -F api run worker:dev    # OCR + thumbnail workers
```

---

## Available Scripts

### Development

| Command                      | Description                                                      |
| ---------------------------- | ---------------------------------------------------------------- |
| `pnpm run boot`              | Start API + web + worker in dev mode (hot reload)                |
| `pnpm run start`             | Build, start infrastructure, and run API + web + worker          |
| `pnpm run api:dev`           | Start API server only (hot reload)                               |
| `pnpm run web:dev`           | Start web app only (hot reload)                                  |
| `pnpm -F api run worker:dev` | Start background workers only (hot reload)                       |

### Build & quality

| Command           | Description                                     |
| ----------------- | ----------------------------------------------- |
| `pnpm run build`  | Build all packages                              |
| `pnpm run lint`   | Run ESLint across API and web                   |
| `pnpm run sweep`  | Clean, lint, and build all packages             |
| `pnpm run clean`  | Remove Next.js build output                     |

### Testing

| Command              | Description                                  |
| -------------------- | -------------------------------------------- |
| `pnpm run test`      | Run full test suite (API + web)              |
| `pnpm run test:api`  | Run API tests and generate HTML report       |
| `pnpm run test:web`  | Run web tests                                |
| `pnpm run coverage`  | Run tests with coverage report               |

### Database

| Command                | Description                              |
| ---------------------- | ---------------------------------------- |
| `pnpm run prismagen`   | Regenerate Prisma client                 |
| `pnpm run prismigrate` | Apply database migrations                |
| `pnpm run prismareset` | Reset database — **destructive**         |

### Infrastructure

| Command                       | Description                                         |
| ----------------------------- | --------------------------------------------------- |
| `pnpm run localdocker`        | Start local infrastructure (Postgres, Redis, MinIO) |
| `pnpm run docker:build`       | Build images and start full Docker stack            |
| `pnpm run docker:rebuild-clean` | Rebuild images without cache and start stack      |
| `pnpm run dockerup`           | Start full Docker stack (no build)                  |
| `pnpm run dockerdown`         | Stop full Docker stack                              |
| `pnpm run docker:logs`        | Tail Docker compose logs                            |

---

## Full Docker Stack

To run the entire application in Docker (API, web, workers, and all infrastructure):

```bash
pnpm run docker:build
# or: docker compose -f infra/docker/docker-compose.yml up -d --build
```

Configure services using `.env.docker` at the repo root. The Dockerfile supports three build targets: `api`, `web`, and `jobs`.

### Services

| Service | Role | Exposed port |
| ----------- | ------------------------------------------- | ------------ |
| `api` | Fastify REST API | 8000 |
| `web` | Next.js frontend | 3000 |
| `nginx` | Reverse proxy — routes `/api/*` to API (prod only) | 80 |
| `jobs-ocr` | OCR text extraction worker | — |
| `jobs-thumb` | Thumbnail generation worker | — |
| `postgres` | PostgreSQL database | 5432 |
| `redis` | Job queue backing store (BullMQ) | 6379 |
| `minio` | S3-compatible object storage | 9000 / 9001 |
| `minio-init` | One-time bucket creation (exits after init) | — |

---

## API

The REST API runs on `http://localhost:8000`. An OpenAPI specification is available at [docs/api/openapi.yml](docs/api/openapi.yml).

Key endpoint groups:

| Prefix           | Description                                |
| ---------------- | ------------------------------------------ |
| `/api/auth`      | Registration, login, token refresh         |
| `/api/media`     | Upload, list, search, update, delete files |
| `/api/bundles`   | Create and manage bundles                  |
| `/api/reminders` | Create and manage reminders                |
| `/api/tags`      | List tags with usage counts                |
| `/api/profile`   | User profile management                    |

---

## License

[PolyForm Noncommercial License 1.0.0](LICENSE) — free for personal and noncommercial use.

