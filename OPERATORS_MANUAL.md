# Vault Operator's Manual

**Living operational reference for the Vault project owner**  
**Purpose**: Run, debug, extend, and recover the system

---

Test User
- Email: test@example.com
- Password: Password123

## 1. System Overview

### Mental Model
Vault is a **user-friendly personal file locker and life administration system**. It transforms a pile of PDFs, images, scans, receipts, and other documents into a searchable, trackable system complete with color-coded tags and reminders, with planned smart assistance features.

**Core Philosophy**: 
- Elegant infrastructure where every file has a purpose
- **Runs locally, for free** — no cloud dependencies, no subscription costs
- Self-hosted with open-source components (PostgreSQL, MinIO, Redis)

**User Flow**:
1. Upload documents (PDFs, images, scans, receipts)
2. Automatic processing: OCR text extraction, thumbnail generation
3. Organize with color-coded tags and titles
4. Search across document text and metadata
5. Set reminders for time-sensitive documents
6. Access via REST API and web UI

**Technical Flow**:
1. Stored in S3-compatible object storage (MinIO)
2. Processed asynchronously for thumbnails and OCR text extraction
3. Indexed for full-text search
4. Made accessible via REST API and web UI

### High-Level Data Flow
```
┌─────────────────────────────────────────────────────────────┐
│  Upload Request (Web/API)                                    │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  API Server (Fastify)                                        │
│  • Create Media record (status: PENDING)                     │
│  • Generate presigned S3 upload URL                          │
│  • Enqueue: thumbnail job → Redis "thumb:queue"              │
│  • Enqueue: OCR job → Redis "ocr:queue"                      │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  Client uploads file to S3 via presigned URL                 │
│  → Storage bucket: vault-originals                           │
└────────────────────┬────────────────────────────────────────┘
                     │
      ┌──────────────┴──────────────┐
      ▼                             ▼
┌──────────────────┐        ┌──────────────────┐
│  Thumbnail Worker│        │  OCR Worker      │
│  (Node.js)       │        │  (Python)        │
│  • Fetch original│        │  • Fetch original│
│  • Generate WebP │        │  • Run Tesseract │
│  • Upload to S3  │        │  • Extract text  │
│  • Update Media  │        │  • Create Document│
│    thumbnailKey  │        │    record        │
└──────────────────┘        └──────────────────┘
      │                             │
      └──────────────┬──────────────┘
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  Database: Media record updated (status: READY)              │
└─────────────────────────────────────────────────────────────┘
```

### Core Invariants (MUST NEVER BREAK)

> [!CAUTION]
> **Critical System Invariants**

1. **Media ownership isolation**: Every `Media` record MUST have a `userId`. API routes enforce ownership checks before returning data or presigned URLs.
2. **S3 key uniqueness**: Storage keys follow pattern `{userId}/{mediaId}/{filename}` to prevent collisions and enable per-user isolation.
3. **Status transitions**: Media status can only flow: `PENDING → READY` or `PENDING → FAILED`. Never reverse direction.
4. **Cascade deletions**: Deleting a `User` cascades to all their `Media`. Deleting `Media` cascades to associated `Document`.
5. **Presigned URL security**: All S3 URLs expire in 600 seconds (10 minutes). Never store or share presigned URLs long-term.

---

## 2. Architecture Map

### Component Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                        Frontend (Next.js)                    │
│  apps/web/                                                   │
│  • Login, media explorer, search, upload dialog             │
└────────────────────┬────────────────────────────────────────┘
                     │ HTTP/REST
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                     API Server (Fastify)                     │
│  apps/api/                                                   │
│  • Routes: /auth, /media, /media/:id/thumbnail              │
│  • Plugins: Prisma, S3, Redis, JWT, Rate Limit              │
│  • Queues: Enqueue thumbnail and OCR jobs                   │
└───────┬──────────────┬────────────────┬─────────────────────┘
        │              │                │
        │              │                └─────────────┐
        │              │                              │
        ▼              ▼                              ▼
┌──────────────┐ ┌──────────────┐           ┌──────────────┐
│  PostgreSQL  │ │    MinIO     │           │    Redis     │
│  (Database)  │ │  (S3 Storage)│           │  (Queues)    │
│  • Users     │ │  • Originals │           │  • thumb:queue│
│  • Media     │ │  • Thumbnails│           │  • ocr:queue  │
│  • Documents │ └──────────────┘           └──────────────┘
└──────────────┘         │                          │
        ▲                │                          │
        │                │                          │
        │    ┌───────────┴───────────┐              │
        │    │                       │              │
        │    ▼                       ▼              │
        │ ┌──────────────┐    ┌──────────────┐     │
        │ │  Thumb Worker│    │  OCR Worker  │     │
        │ │  (Node.js)   │    │  (Python)    │     │
        │ │ workers/     │    │ workers/     │     │
        │ │  node-jobs/  │    │  py-ocr/     │     │
        │ └──────────────┘    └──────────────┘     │
        │         ▲                   ▲             │
        └─────────┴───────────────────┴─────────────┘
```

### Shared Packages

- **`packages/shared`**: Shared types, DTO schemas, API client, Zod validators
- **`packages/config`**: Centralized config loader, env schema, secrets mapping
- **`packages/ui`**: Reusable React/UI primitives for web

TODO: Confirm if these packages are actively used or placeholder structure.

---

## 3. Repo and Directory Layout

```
vault/
├── apps/
│   ├── api/              Fastify REST API server (TypeScript)
│   └── web/              Next.js web UI (TypeScript + React)
├── workers/
│   ├── node-jobs/        Background thumbnail processor (TypeScript)
│   └── py-ocr/           OCR worker using Tesseract (Python)
├── packages/
│   ├── shared/           Shared types, DTO schemas, API client
│   ├── config/           Centralized config/env loader
│   └── ui/               Reusable React components
├── infra/
│   ├── docker/           Docker Compose, Dockerfiles, healthchecks
│   ├── meilisearch/      Index definitions, ranking rules (TODO: Not actively used?)
│   ├── k6/               Load/smoke test scripts
│   ├── scripts/          Dev init, seed, snapshot, restore scripts
│   └── sql/              Raw SQL for views, indexes, migration extras
├── prisma/
│   ├── schema.prisma     Data model definition
│   ├── migrations/       Database migration history
│   └── seed.ts           Dev seed script
├── docs/
│   ├── adr/              Architecture decision records (mostly empty)
│   ├── runbook/          Ops playbooks (backups, DLQ, deploy, keys) - empty
│   ├── security/         Threat model, hardening checklist (TODO: verify if populated)
│   ├── postmortems/      Incident writeups
│   └── api/              OpenAPI spec, examples
├── .github/workflows/    CI pipelines
└── Makefile              Dev workflow commands
```

### Purpose of Each Top-Level Directory

| Directory       | Purpose                                                          |
|-----------------|------------------------------------------------------------------|
| `apps/`         | Deployable applications (API server, Web frontend)                |
| `workers/`      | Background job processors (thumbnail, OCR)                        |
| `packages/`     | Shared code libraries (internal monorepo dependencies)            |
| `infra/`        | Infrastructure code, Docker, scripts, SQL                         |
| `prisma/`       | Database schema, migrations, seed data                            |
| `docs/`         | Documentation, ADRs, runbooks, security docs                      |
| `.github/`      | CI/CD workflows                                                   |

---

## 4. Environment and Configuration

### Required Environment Variables

> [!IMPORTANT]
> All services require a `.env` file. Use `.env.example` as a template.

#### Core Infrastructure

| Variable                 | Purpose                                      | Example                                    |
|--------------------------|----------------------------------------------|--------------------------------------------|
| `NODE_ENV`               | Runtime environment                          | `development`, `production`                |
| `DATABASE_URL`           | PostgreSQL connection string (Prisma)        | `postgresql://vault:vault@localhost:5432/vault` |
| `POSTGRES_URL`           | PostgreSQL connection string (alias)         | Same as `DATABASE_URL`                     |

#### API Server (`apps/api`)

| Variable                 | Purpose                                      | Example                                    |
|--------------------------|----------------------------------------------|--------------------------------------------|
| `PORT`                   | API HTTP port                                | `3000`                                     |
| `HOST`                   | Bind host                                    | `127.0.0.1`, `localhost`                     |
| `JWT_SECRET`             | Secret for signing JWT tokens                | `change-me` (MUST rotate in production)    |

#### Storage (S3/MinIO)

| Variable                 | Purpose                                      | Example                                    |
|--------------------------|----------------------------------------------|--------------------------------------------|
| `S3_ENDPOINT`            | S3-compatible endpoint                       | `http://localhost:9000`                    |
| `S3_REGION`              | AWS region (MinIO ignores, but required)     | `us-east-1`                                |
| `S3_ACCESS_KEY`          | S3 access key                                | `vault`                                    |
| `S3_SECRET_KEY`          | S3 secret key                                | `vaultvault`                               |
| `S3_BUCKET`              | Primary bucket for originals                 | `vault-originals`                          |

TODO: Confirm if separate `S3_BUCKET_ORIGINALS` and `S3_BUCKET_THUMBS` are used or if thumbnails go to same bucket with key prefix.

#### Redis (Queues)

| Variable                 | Purpose                                      | Example                                    |
|--------------------------|----------------------------------------------|--------------------------------------------|
| `REDIS_URL`              | Redis connection string                      | `redis://localhost:6379`                   |

#### Optional / Future Services

| Variable                       | Purpose                                      | Status                                     |
|--------------------------------|----------------------------------------------|--------------------------------------------|
| `MEILI_HOST`                   | Meilisearch endpoint                         | TODO: Verify if implemented                |
| `MEILI_MASTER_KEY`             | Meilisearch master key                       | TODO: Verify if implemented                |
| `EMAIL_SMTP_HOST`              | SMTP server for notifications                | TODO: Verify if implemented                |
| `EMAIL_SMTP_PORT`              | SMTP port                                    | TODO: Verify if implemented                |
| `EMAIL_FROM`                   | Sender email address                         | TODO: Verify if implemented                |
| `OTEL_EXPORTER_OTLP_ENDPOINT`  | OpenTelemetry exporter endpoint              | TODO: Verify if implemented                |

### Docker Compose Defaults

The `infra/docker/docker-compose.yml` file provides:
- **PostgreSQL**: `vault:vault@localhost:5432/vault`
- **MinIO**: `vault:vaultvault@localhost:9000` (console at `:9001`)
- **Redis**: `localhost:6379`

---

## 5. Data Model

### Prisma Schema Overview

File: [schema.prisma](file:///c:/Users/Rynan/Desktop/Vault/vault/prisma/schema.prisma)

#### Entity Relationship Diagram

```mermaid
erDiagram
    User ||--o{ Media : owns
    Media ||--o| Document : "has OCR text"
    
    User {
        string id PK
        string email UK
        string passwordHash
        datetime createdAt
    }
    
    Media {
        string id PK
        string userId FK
        MediaStatus status
        string storageKey
        string filename
        string mimeType
        int sizeBytes
        string title
        string[] tags
        datetime createdAt
        datetime updatedAt
        string thumbnailKey
    }
    
    Document {
        string mediaId PK_FK
        string rawText
    }
```

### Core Entities

#### `User`
- **Purpose**: Represents a registered user
- **Auth**: Password hashed using bcrypt (TODO: confirm hashing algorithm)
- **Cascade**: Deleting a user deletes all their media

| Field          | Type       | Constraints       | Notes                                      |
|----------------|------------|-------------------|--------------------------------------------|
| `id`           | String     | PK, CUID          | Collision-resistant ID                     |
| `email`        | String     | Unique            | Login identifier                           |
| `passwordHash` | String     |                   | Never return in API responses              |
| `createdAt`    | DateTime   | Default: now()    |                                            |

#### `Media`
- **Purpose**: Represents an uploaded media file (image, PDF, etc.)
- **Lifecycle**: `PENDING` (uploading) → `READY` (processed) or `FAILED`

| Field          | Type         | Constraints       | Notes                                      |
|----------------|--------------|-------------------|--------------------------------------------|
| `id`           | String       | PK, CUID          |                                            |
| `userId`       | String       | FK → User.id      | Enforces ownership                         |
| `status`       | MediaStatus  | Default: PENDING  | `PENDING`, `READY`, `FAILED`               |
| `storageKey`   | String       |                   | S3 key: `{userId}/{mediaId}/{filename}`    |
| `filename`     | String       |                   | Original filename                          |
| `mimeType`     | String       |                   | e.g., `image/jpeg`, `application/pdf`      |
| `sizeBytes`    | Int          |                   | File size in bytes                         |
| `title`        | String       |                   | User-provided or derived from filename     |
| `tags`         | String[]     | Default: []       | Array of tag strings                       |
| `createdAt`    | DateTime     | Default: now()    |                                            |
| `updatedAt`    | DateTime     | Auto-updated      |                                            |
| `thumbnailKey` | String?      | Nullable          | S3 key for WebP thumbnail (if generated)   |

#### `Document`
- **Purpose**: Stores OCR-extracted text for searchable media
- **Relationship**: One-to-one with `Media` (optional)

| Field      | Type   | Constraints        | Notes                                      |
|------------|--------|--------------------|--------------------------------------------|
| `mediaId`  | String | PK, FK → Media.id  | Same as parent Media ID                     |
| `rawText`  | String |                    | Full OCR text output                        |

#### `MediaStatus` Enum
- `PENDING`: Upload initiated, processing not complete
- `READY`: All processing complete (thumbnail + OCR if applicable)
- `FAILED`: Processing encountered an error

### Relationships
- `User` → `Media`: One-to-many (on delete: CASCADE)
- `Media` → `Document`: One-to-one (on delete: CASCADE)

---

## 6. Background Jobs and Queues

### Queue System

**Technology**: Redis Lists (`LPUSH`/`RPOP` pattern)  
TODO: Confirm if BullMQ is used (based on ADR 0005 filename) or if this is simple Redis list polling.

### Active Queues

#### `thumb:queue`
- **Purpose**: Generate WebP thumbnails from uploaded media
- **Producer**: API server (`apps/api/src/queues/enqueueThumbnail.ts`)
- **Consumer**: Thumbnail worker (`workers/node-jobs` - TODO: confirm exact consumer file)
- **Payload**:
  ```typescript
  {
    type: "thumb",
    mediaId: string,
    userId: string,
    storageKey: string,  // S3 key of original
    outKey: string,      // S3 key for thumbnail: "thumbs/{mediaId}.webp"
    size: number,        // Target edge size (default: 512px)
    attempt: number      // Retry counter (starts at 0)
  }
  ```
- **Processing**:
  1. Fetch original from S3 (`storageKey`)
  2. Generate WebP thumbnail using `sharp` library
  3. Upload thumbnail to S3 (`outKey`)
  4. Update `Media.thumbnailKey` in database
- **Retry Behavior**: TODO: Document max retries, backoff strategy

#### `ocr:queue`
- **Purpose**: Extract text from uploaded documents/images using Tesseract OCR
- **Producer**: API server (direct `redis.lpush("ocr:queue", ...)`)
- **Consumer**: Python OCR worker (`workers/py-ocr/src/main.py`)
- **Payload**:
  ```json
  {
    "type": "ocr",
    "mediaId": "<uuid>",
    "userId": "<uuid>",
    "storageKey": "<s3-key>",
    "title": "<media-title>"
  }
  ```
- **Processing**:
  1. Fetch original from S3
  2. Convert to image if PDF (using Poppler/pdf2image)
  3. Run Tesseract OCR
  4. Create `Document` record with extracted text
- **Retry Behavior**: TODO: Document max retries, backoff strategy

### Queue Management

#### How to Inspect Queues

```bash
# Connect to Redis
docker exec -it <redis-container> redis-cli

# View queue length
LLEN thumb:queue
LLEN ocr:queue

# Peek at next job (without removing)
LRANGE thumb:queue -1 -1
LRANGE ocr:queue -1 -1

# View all jobs in queue
LRANGE thumb:queue 0 -1
```

#### How to Drain Queues

> [!WARNING]
> Draining queues will discard all pending jobs. Media status will remain `PENDING` until re-enqueued.

```bash
# Clear entire queue
DEL thumb:queue
DEL ocr:queue
```

#### How to Safely Re-process Failed Jobs

TODO: Document DLQ (dead-letter queue) strategy. Currently no DLQ mechanism is visible in code.

**Manual reprocessing approach**:
1. Query database for `Media` records with `status = 'PENDING'` or `status = 'FAILED'`
2. For each record, re-enqueue jobs:
   ```sql
   SELECT id, userId, storageKey FROM "Media" WHERE status = 'PENDING';
   ```
3. TODO: Create admin script to bulk re-enqueue from query results

---

## 7. API

### Base URL
- **Development**: `http://localhost:3000`
- **Production**: TODO: Document production URL

### Authentication

**Method**: JWT (JSON Web Tokens)  
**Header**: `Authorization: Bearer <token>`

#### Endpoints

##### `POST /auth/register`
TODO: Confirm if implemented. Not visible in current route inspection.

##### `POST /auth/login`
TODO: Document request/response schema.

##### `POST /auth/refresh`
TODO: Document token refresh mechanism.

##### `POST /auth/logout`
TODO: Confirm if implemented.

### Media Endpoints

#### `POST /media`
**Purpose**: Initiate a new media upload

**Auth**: Required

**Request Body**:
```json
{
  "filename": "vacation.jpg",
  "mimeType": "image/jpeg",
  "sizeBytes": 2048576,
  "title": "Summer Vacation",
  "tags": ["travel", "2024"]
}
```

**Response**:
```json
{
  "id": "cm1x2y3z4...",
  "uploadUrl": "https://minio:9000/vault-originals/...",
  "storageKey": "user123/cm1x2y3z4.../vacation.jpg"
}
```

**Side Effects**:
1. Creates `Media` record with `status: PENDING`
2. Enqueues thumbnail job → `thumb:queue`
3. Enqueues OCR job → `ocr:queue`

**Next Step**: Client uploads file to `uploadUrl` (PUT request)

---

#### `GET /media`
**Purpose**: List all media owned by authenticated user

**Auth**: Required

**Query Parameters**:
- `q` (optional): Search query (matches title or OCR text)

**Response**:
```json
{
  "items": [
    {
      "id": "cm1x2y3z4...",
      "title": "Summer Vacation",
      "status": "READY",
      "createdAt": "2025-01-05T21:00:00Z"
    }
  ]
}
```

---

#### `GET /media/:id`
**Purpose**: Get media details and presigned download URL

**Auth**: Required (ownership enforced)

**Response**:
```json
{
  "media": {
    "id": "cm1x2y3z4...",
    "userId": "user123",
    "status": "READY",
    "storageKey": "user123/cm1x2y3z4.../vacation.jpg",
    "filename": "vacation.jpg",
    "mimeType": "image/jpeg",
    "sizeBytes": 2048576,
    "title": "Summer Vacation",
    "tags": ["travel", "2024"],
    "thumbnailKey": "thumbs/cm1x2y3z4....webp",
    "createdAt": "2025-01-05T21:00:00Z",
    "updatedAt": "2025-01-05T21:01:00Z",
    "document": {
      "mediaId": "cm1x2y3z4...",
      "rawText": "Extracted OCR text here..."
    }
  },
  "downloadUrl": "https://minio:9000/vault-originals/...?presigned-params"
}
```

---

#### `GET /media/:id/thumbnail`
**Purpose**: Get presigned URL for thumbnail image

**Auth**: Required (ownership enforced)

**Response**:
```json
{
  "url": "https://minio:9000/vault-originals/thumbs/...?presigned-params"
}
```

**Error Cases**:
- `404`: Media not found, user doesn't own media, or thumbnail not yet generated

---

### Health Endpoints

#### `GET /healthz`
TODO: Document response format and what this checks.

#### `GET /readyz`
TODO: Document readiness checks (DB connection, Redis connection, etc.)

---

### Rate Limiting

TODO: Document rate limit thresholds and headers (`X-RateLimit-*`).

---

## 8. Frontend Integration

TODO: Leave blank for now (as requested).

---

## Appendix: Operational Runbooks

> [!NOTE]
> Detailed runbooks are located in `docs/runbook/` but are currently empty. Recommended topics:

- **Local Development Setup** (`local-dev.md`)
- **Production Deployment** (`prod-deploy.md`)
- **Backup and Restore** (`backups.md`)
- **Dead-Letter Queue Recovery** (`dlq-recovery.md`)
- **Key Rotation** (`rotate-keys.md`)

---

## Appendix: Makefile Commands

Quick reference for common development tasks:

| Command         | Description                                     |
|-----------------|-------------------------------------------------|
| `make up`       | Start infrastructure (Postgres, MinIO, Redis)   |
| `make down`     | Stop infrastructure                             |
| `make nuke`     | Stop infrastructure and remove volumes          |
| `make logs`     | Tail all infrastructure logs                    |
| `make api-dev`  | Start API server with hot reload                |
| `make worker`   | Start OCR worker                                |
| `make typecheck`| Run TypeScript type checking                    |
| `make lint`     | Run ESLint                                      |
| `make lint-fix` | Run ESLint with auto-fix                        |
| `make fmt`      | Run Prettier formatter                          |
| `make test`     | Run tests (TODO: currently placeholder)         |

---

**Document Version**: 1.0  
**Last Updated**: 2025-01-05  
**Maintainer**: Vault Project Owner
