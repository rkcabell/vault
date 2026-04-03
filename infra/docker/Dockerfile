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

# Build the shared db package so @vault/db/dist/index.js exists
RUN npm run -w packages/db build

# --- api target ---
FROM deps AS api
EXPOSE 8000
CMD ["npm","run","-w","apps/api","start"]

# --- web target ---
FROM deps AS web
ENV NODE_ENV=production
RUN npm run -w apps/web build
EXPOSE 3000
CMD ["npm","run","-w","apps/web","start"]

# --- jobs target (OCR deps) ---
FROM deps AS jobs
RUN apt-get update && apt-get install -y --no-install-recommends \
    ocrmypdf tesseract-ocr ghostscript curl qpdf ca-certificates\
    && rm -rf /var/lib/apt/lists/*
