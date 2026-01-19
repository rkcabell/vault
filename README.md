<h1 align="center">Vault</h1>
<br>
<br>
Vault is a self-hosted content organizer and planning system. 

This repository contains both the backend API and the web frontend.

Vault is intentionally built as a real system (auth, storage, queues, async jobs) rather than a UI mockup.

---

## What Vault Is





## Tech Stack

### Backend

- Node.js
- Fastify - HTTP framework. Handles routing, requests, and responses
- Prisma - Data access. Maps application models to database tables
- PostgreSQL
- Redis - Volatile data layer. Used for caching, sessions, queues
- MinIO - Local object storage

### Frontend

- Next.js
- TypeScript


## Repository Structure

apps/  
    api/ — Fastify backend API  
    web/ — Next.js frontend  
