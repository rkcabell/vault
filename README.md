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
└── scripts/          # setup.sh
```

---

## Local Setup

Should work right out of the box

```bash
1. git clone https://github.com/rkcabell/vault.git
2. cd vault
3. bash scripts/setup.sh
4. npm run boot
```

Open [http://localhost:3000](http://localhost:3000).

The setup script handles everything automatically on Debian/Ubuntu — Node.js, Docker, OCR tools, `.env` generation, Docker infrastructure, database migrations, and MinIO bucket creation. On other platforms, install prerequisites manually before running it.

**Prerequisites (non-Debian/Ubuntu):**

- Node.js ≥18.18, npm ≥10.5.0
- Docker + Docker Compose v2
- ocrmypdf, Tesseract, Ghostscript, qpdf (optional — required for OCR only)

  macOS: `brew install ocrmypdf tesseract ghostscript qpdf`

---

### Manual setup (advanced)

#### 1. Install dependencies

```bash
npm install
```

#### 2. Start infrastructure

```bash
npm run localdocker
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

### Development

| Command                     | Description                                                      |
| --------------------------- | ---------------------------------------------------------------- |
| `npm run boot`              | Start API + web + worker in dev mode (hot reload)                |
| `npm run start`             | Start infrastructure, then run API + web + worker (no hot reload) |
| `npm run api:dev`           | Start API server only (hot reload)                               |
| `npm run web:dev`           | Start web app only (hot reload)                                  |
| `npm -w api run worker:dev` | Start background workers only (hot reload)                       |

### Build & quality

| Command          | Description                                     |
| ---------------- | ----------------------------------------------- |
| `npm run build`  | Build all packages                              |
| `npm run lint`   | Run ESLint across API and web                   |
| `npm run sweep`  | Clean, lint, and build all packages             |
| `npm run clean`  | Remove Next.js build output                     |

### Testing

| Command             | Description                                  |
| ------------------- | -------------------------------------------- |
| `npm run test`      | Run full test suite (API + web)              |
| `npm run test:api`  | Run API tests and generate HTML report       |
| `npm run test:web`  | Run web tests                                |
| `npm run coverage`  | Run tests with coverage report               |

### Database

| Command               | Description                              |
| --------------------- | ---------------------------------------- |
| `npm run prismagen`   | Regenerate Prisma client                 |
| `npm run prismigrate` | Apply database migrations                |
| `npm run prismareset` | Reset database — **destructive**         |

### Infrastructure

| Command                      | Description                                      |
| ---------------------------- | ------------------------------------------------ |
| `npm run localdocker`        | Start local infrastructure (Postgres, Redis, MinIO) |
| `npm run docker:build`       | Build images and start full Docker stack         |
| `npm run docker:rebuild-clean` | Rebuild images without cache and start stack   |
| `npm run dockerup`           | Start full Docker stack (no build)               |
| `npm run dockerdown`         | Stop full Docker stack                           |
| `npm run docker:logs`        | Tail Docker compose logs                         |

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
