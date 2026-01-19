# syntax=docker/dockerfile:1.6
FROM node:20-bookworm-slim AS base
WORKDIR /app

# Prisma needs openssl available
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# --- deps stage: install all workspace deps once ---
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages

# Cache npm downloads between builds (BuildKit)
RUN --mount=type=cache,target=/root/.npm npm ci

# --- api target ---
FROM deps AS api
EXPOSE 8000
CMD ["npm","run","-w","apps/api","dev"]

# --- web target ---
FROM deps AS web
EXPOSE 3000
CMD ["npm","run","-w","apps/web","dev"]

# --- jobs target (OCR deps) ---
FROM deps AS jobs
RUN apt-get update && apt-get install -y --no-install-recommends \
    ocrmypdf tesseract-ocr ghostscript curl qpdf ca-certificates\
    && rm -rf /var/lib/apt/lists/*
CMD ["npm","run","-w","apps/api","worker:dev"]
