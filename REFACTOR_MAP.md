# Refactor Map (Routes → Services/Repos/Adapters/Libs)

## Routes (should stay thin)
- apps/api/src/routes/health.ts — thin: health/ready checks (DB ping). Keep as route; move to service only if logic grows.
- apps/api/src/routes/media.ts — thin: validates + calls mediaService (already split).
- apps/api/src/routes/profile.ts — now thin: validates + calls ProfileService.
- apps/api/src/routes/auth.ts — now thin: rate limits + validation + calls AuthService; sets cookies from service output.

## Services (use-cases)
- apps/api/src/services/mediaService.ts — orchestrates media uploads, listing, downloads, text re-run, thumbnail/ocr enqueue.
- apps/api/src/services/authService.ts — register, login, refresh, me; enforces user existence/credentials; depends on UserRepository, passwordHasher, jwtAdapter.
- apps/api/src/services/profileService.ts — get/update profile with normalization; depends on ProfileRepository.
- apps/api/src/services/ocrProcessingService.ts — OCR workflow (PDF-first, OCR fallback, document upsert, text state).
- apps/api/src/services/thumbnailService.ts — thumbnail workflow (source wait, PDF render, resize/webp upload, thumb state).

## Repositories (DB access)
- apps/api/src/repositories/mediaRepository.ts — media CRUD/listing, thumb/text state setters, keys lookups.
- apps/api/src/repositories/userRepository.ts — find/create users for auth.
- apps/api/src/repositories/profileRepository.ts — read/update profile fields.
- apps/api/src/repositories/documentRepository.ts — upsert document text/pages.

## Adapters (external systems)
- apps/api/src/adapters/s3ObjectProbe.ts — poll S3 object existence (HEAD with retries).
- apps/api/src/adapters/s3/getObjectBuffer.ts — download S3 objects to Buffer.
- apps/api/src/adapters/passwordHasher.ts — argon2 hash/verify.
- apps/api/src/adapters/jwtAdapter.ts — wrap app.jwt sign/verify for services.

## Libs (pure helpers)
- apps/api/src/lib/config/redis.ts — build BullMQ/ioredis connection options from URL (pure config).
- apps/api/src/lib/fileSignatures.ts — PDF/PNG magic byte checks.
- apps/api/src/lib/streams/toBuffer.ts — bufferize web/Node streams.
- apps/api/src/lib/strings/normalize.ts — normalize nullable strings.
- Existing: apps/api/src/lib/pdf/*, apps/api/src/lib/text/processTextJob.ts.

## Workers
- apps/api/src/worker/index.ts — now bootstraps queues/workers via adapters + repositories; delegates processing to services.
- apps/api/src/worker/ocrWorker.ts — thin wrapper re-exporting OCR processing service.
- apps/api/src/worker/thumbWorker.ts — thin wrapper re-exporting thumbnail service.

## Placement guidance (if further splitting is needed)
- Routes: stay thin; one service call per endpoint.
- Services: single workflow each; enforce invariants; depend on repos/adapters, not Fastify/HTTP.
- Repos: DB-only operations; return data, not HTTP responses.
- Adapters: wrap external clients (S3/Redis/BullMQ/JWT/password hashing).
- Libs: pure helpers for transforms, parsing, signatures, buffering, normalization.
