# Vault

A self-hosted personal document archive. Upload files, extract text via OCR, tag and search everything, set reminders, and organize items into bundles

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

| Layer | Technology |
|---|---|
| Frontend | Next.js 16, React 18, TypeScript, Tailwind CSS 4, Radix UI |
| Backend | Fastify 4, Node.js ≥18.18, TypeScript |
| Database | PostgreSQL 16 (Prisma ORM) |
| Queue | BullMQ + Redis 7 |
| Storage | MinIO (S3-compatible) |
| OCR | ocrmypdf, Tesseract, Ghostscript, qpdf |
| Image processing | Sharp, heic-convert, @napi-rs/canvas |
| Auth | JWT (access + refresh tokens), Argon2 password hashing |

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
├── docs/             # ADRs, OpenAPI spec, postmortems
└── scripts/          # Dev scripts (setup.sh)
```

---

## Local Setup

### Prerequisites

- **Node.js** ≥18.18 and **npm** ≥10.5.0
- **Docker** and **Docker Compose**
- **ocrmypdf**, **Tesseract**, **Ghostscript**, and **qpdf** (required for OCR workers)

  On Debian/Ubuntu:
  ```bash
  sudo apt install ocrmypdf tesseract-ocr ghostscript qpdf
  ```
  On macOS:
  ```bash
  brew install ocrmypdf tesseract ghostscript qpdf
  ```

---

### Automated setup (recommended)

Run the setup script to handle everything in one go:

```bash
chmod +x scripts/setup.sh
./scripts/setup.sh
```

This will:
1. Check prerequisites and warn about missing OCR tools
2. Install npm dependencies
3. Start Docker infrastructure (PostgreSQL, Redis, MinIO)
4. Create `apps/api/.env` with auto-generated JWT secrets (skipped if it already exists)
5. Create the MinIO bucket
6. Generate the Prisma client and apply migrations

Then start the dev servers:

```bash
npm run boot
```

---

### Manual setup

#### 1. Install dependencies

```bash
npm install
```

#### 2. Start infrastructure

```bash
npm run localdocker
# or: docker compose -f infra/docker/docker-minimal.yml up -d
```

| Service | URL | Credentials |
|---|---|---|
| PostgreSQL | `localhost:5432` | see `docker-minimal.yml` |
| Redis | `localhost:6379` | — |
| MinIO API | `http://localhost:9000` | see `docker-minimal.yml` |
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
npm run prismagen      # Generate Prisma client
npm run prismigrate    # Apply migrations
```

#### 5. Start development servers

```bash
npm run boot
```

Alternatively, run each process in a separate terminal:

```bash
npm run api:dev              # API server   → http://localhost:8000
npm run web:dev              # Web app      → http://localhost:3000
npm -w api run worker:dev    # OCR + thumbnail workers
```

---

## Available Scripts

| Command | Description |
|---|---|
| `npm run boot` | Start API + web + worker (hot reload) |
| `npm run api:dev` | Start API only |
| `npm run web:dev` | Start web app only |
| `npm -w api run worker:dev` | Start background workers |
| `npm run build` | Build all packages |
| `npm run lint` | Run ESLint across API and web |
| `npm run test:api` | Run API test suite |
| `npm run prismagen` | Regenerate Prisma client |
| `npm run prismigrate` | Apply database migrations |
| `npm run prismareset` | Reset database (destructive) |
| `npm run localdocker` | Start infrastructure containers |
| `npm run docker:build` | Build and start full Docker stack |
| `npm run docker:logs` | Tail Docker logs |


---

## Full Docker Stack

To run the entire application in Docker (API, web, workers, and all infrastructure):

```bash
npm run docker:build
# or: docker compose -f infra/docker/docker-compose.yml up -d --build
```

Configure services using `.env.docker` at the repo root. The Dockerfile supports three build targets: `api`, `web`, and `jobs`.

---

## API

The REST API runs on `http://localhost:8000`. An OpenAPI specification is available at [docs/api/openapi.yml](docs/api/openapi.yml).

Key endpoint groups:

| Prefix | Description |
|---|---|
| `/api/auth` | Registration, login, token refresh |
| `/api/media` | Upload, list, search, update, delete files |
| `/api/bundles` | Create and manage bundles |
| `/api/reminders` | Create and manage reminders |
| `/api/tags` | List tags with usage counts |
| `/api/profile` | User profile management |

---

## License

Private — all rights reserved.
