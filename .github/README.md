<h1 align="center">Vault</h1>
<br>
<br>
Vault is a self-hosted content organizer and planning system. 

This repository contains both the backend API and the web frontend.

Vault is intentionally built as a real system (auth, storage, queues, async jobs) rather than a UI mockup.

---

## What Vault Is (Conceptually)

Vault is built around a simple loop:

**Capture → Enrich → Review → Act → Archive**

- **Capture**: Upload files securely using presigned URLs.
- **Enrich**: Background workers perform OCR, thumbnail generation, and metadata extraction.
- **Review**: Users browse an inbox/library view driven by queries, not folders.
- **Act**: Content can generate reminders, tasks, or planning signals.
- **Archive**: Files remain searchable and linked by meaning, not location.

---

## Current State

Implemented:

- Authentication via cookies
- Media upload initialization with presigned S3/MinIO URLs
- Object storage (S3-compatible)
- Relational metadata storage
- Background job queue for async processing (OCR/thumbnails)
- Basic API routes for media creation and retrieval

---

## Tech Stack

### Backend

- Node.js
- Fastify
- Prisma
- PostgreSQL
- Redis
- MinIO local S3-compatible storage

### Frontend

- Next.js
- TypeScript


## Repository Structure

apps/  
    api/ — Fastify backend API  
    web/ — Next.js frontend  
