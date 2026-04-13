# syntax=docker/dockerfile:1.6
FROM node:20-bookworm-slim AS base
WORKDIR /app

# Prisma needs openssl available
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# --- deps stage: install all workspace deps once ---
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages

# Cache pnpm store between builds (BuildKit)
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile

# Build shared packages so their dist/ entries exist
RUN pnpm -F @vault/types run build
RUN pnpm -F @vault/db run build

# --- api target ---
FROM deps AS api
EXPOSE 8000
CMD ["pnpm", "-F", "api", "run", "start"]

# --- web target ---
FROM deps AS web
# API_BASE_URL must be set at build time so next.config.mjs rewrites() bakes the
# correct destination into routes-manifest.json.  Default points to the Docker
# service name so plain `docker build` still produces a usable image.
ARG API_BASE_URL=http://api:8000
ENV API_BASE_URL=${API_BASE_URL}
ENV NODE_ENV=production
RUN pnpm -F web run build
EXPOSE 3000
CMD ["pnpm", "-F", "web", "run", "start"]

# --- jobs target (OCR deps) ---
FROM deps AS jobs
RUN apt-get update && apt-get install -y --no-install-recommends \
    ocrmypdf tesseract-ocr ghostscript curl qpdf ca-certificates\
    && rm -rf /var/lib/apt/lists/*
