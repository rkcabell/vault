# Refactor Map (Routes f+' Services/Repos/Adapters/Libs)

## Routes (should stay thin)
- apps/api/src/routes/health.ts f?" thin: health/ready checks (DB ping). Keep as route; move to service only if logic grows.
- apps/api/src/routes/media.ts f?" thin: validation + upload limits + tag parsing; delegates to mediaServices (upload/query/read/actions).
- apps/api/src/routes/profile.ts f?" thin: validates + calls ProfileService.
- apps/api/src/routes/auth.ts f?" thin: rate limits + validation + calls AuthService; sets cookies from service output.
- apps/api/src/routes/tags.ts f?" thin: list/create/delete tags; uses MediaRepository directly (service if it grows).

## Services (use-cases/workflows)
- apps/api/src/services/authService.ts f?" register/login/refresh/me; depends on UserRepository, passwordHasher, jwtAdapter.
- apps/api/src/services/profileService.ts f?" get/update profile with normalization; depends on ProfileRepository.
- apps/api/src/services/media/mediaUploadService.ts f?" init uploads + batch init/finalize; ensures tags; enqueues OCR/thumbs; presigns PUT.
- apps/api/src/services/media/mediaQueryService.ts f?" list media w/ filters + cursor/page; listTopTags.
- apps/api/src/services/media/mediaReadService.ts f?" media detail + text chunks + thumbnail fetch; pulls OCR job meta when pending/failed.
- apps/api/src/services/media/mediaActionsService.ts f?" delete media + update metadata + enqueue text extraction + presigned GET.
- apps/api/src/services/ocrProcessingService.ts f?" OCR workflow (wait for S3, PDF extract, OCR fallback, document upsert, text state).
- apps/api/src/services/ocr/ocrWithOcrmypdf.ts f?" run OCRmyPDF on images/PDFs; returns OCR'd PDF buffer.
- apps/api/src/services/pdf/extractPdfText.ts f?" PDF.js extraction + heuristics for OCR fallback.
- apps/api/src/services/pdf/loadPdfJs.ts f?" lazy-load pdfjs + workerSrc wiring.
- apps/api/src/services/pdf/shouldFallbackToOcr.ts f?" heuristics for when to OCR.
- apps/api/src/services/thumb/thumbnailService.ts f?" thumbnail workflow (source wait, PDF/video render, resize/webp upload, thumb state).
- apps/api/src/services/thumb/renderPdfThumbnail.ts f?" render first PDF page to PNG.
- apps/api/src/services/thumb/renderVideoThumbnail.ts f?" render video frame to PNG.

## Repositories (DB access)
- apps/api/src/repositories/mediaRepository.ts f?" media CRUD/listing, tag upserts, thumb/text state setters, key lookups.
- apps/api/src/repositories/userRepository.ts f?" find/create users for auth.
- apps/api/src/repositories/profileRepository.ts f?" read/update profile fields.
- apps/api/src/repositories/documentRepository.ts f?" upsert document text/pages.

## Adapters (external systems)
- apps/api/src/adapters/s3Adapter.ts f?" presign PUT/GET, get object stream, delete-if-present.
- apps/api/src/adapters/s3ObjectProbe.ts f?" poll S3 object existence (HEAD with retries).
- apps/api/src/adapters/s3/getObjectBuffer.ts f?" download S3 objects to Buffer.
- apps/api/src/adapters/passwordHasher.ts f?" argon2 hash/verify.
- apps/api/src/adapters/jwtAdapter.ts f?" wrap app.jwt sign/verify for services.

## Plugins (Fastify wiring/infrastructure)
- apps/api/src/plugins/config.ts f?" env validation + app.config.
- apps/api/src/plugins/prisma.ts f?" Prisma client wiring.
- apps/api/src/plugins/jwt.ts f?" JWT sign/verify wiring.
- apps/api/src/plugins/redis.ts f?" Redis client wiring.
- apps/api/src/plugins/rateLimit.ts f?" rate limiter decorator.
- apps/api/src/plugins/s3.ts f?" S3 + presign clients for API.
- apps/api/src/plugins/mediaServices.ts f?" media service graph + queue wiring.
- apps/api/src/plugins/s3Client.ts f?" S3 client singletons for worker/presign use.

## Queues
- apps/api/src/queues/enqueueThumbnail.ts f?" thumb job enqueue helpers + computeThumbKey.
- apps/api/src/queues/enqueueOcr.ts f?" bulk OCR enqueue helper.

## Libs (pure helpers)
- apps/api/src/lib/config/redis.ts f?" build BullMQ/ioredis connection options from URL (pure config).
- apps/api/src/lib/logger.ts f?" pino logger factory (env-aware).
- apps/api/src/lib/fileSignatures.ts f?" PDF/PNG/MP4 magic byte checks.
- apps/api/src/lib/streams/toBuffer.ts f?" bufferize Node streams.
- apps/api/src/lib/strings/normalize.ts f?" normalize nullable strings.
- apps/api/src/lib/tags/normalizeTags.ts f?" parse/validate tag input.
- apps/api/src/lib/media/deriveTitle.ts f?" filename -> title fallback.
- apps/api/src/lib/media/keys.ts f?" build storage key paths.
- apps/api/src/lib/media/textSource.ts f?" infer NATIVE/OCR/UNKNOWN text source.
- apps/api/src/lib/media/uploadLimits.ts f?" classify uploads + size limit errors.
- apps/api/src/lib/text/processTextJob.ts f?" orchestrate PDF extract vs OCR path (uses services/pdf + ocr).

## Utils
- apps/api/src/utils/authGuard.ts f?" read bearer/cookie token, attach userId, enforce auth.

## Workers
- apps/api/src/worker/index.ts f?" bootstraps BullMQ workers + repos + S3; handles failure state updates.
- apps/api/src/worker/ocrWorker.ts f?" wrapper for OCR processing service (worker + tests).
- apps/api/src/worker/thumbWorker.ts f?" wrapper for thumbnail service (worker + tests).

## Placement guidance (if further splitting is needed)
- Routes: stay thin; one service call per endpoint.
- Services: single workflow each; enforce invariants; depend on repos/adapters, not Fastify/HTTP.
- Repos: DB-only operations; return data, not HTTP responses.
- Adapters: wrap external clients (S3/Redis/BullMQ/JWT/password hashing).
- Plugins: Fastify wiring + DI; avoid business logic here.
- Queues: job definitions + enqueue helpers only; worker logic stays in services.
- Libs: pure helpers for transforms, parsing, signatures, buffering, normalization.




