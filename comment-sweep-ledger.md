# Comment clarity sweep — coverage ledger

Scope so far: `apps/api/src`, excluding `src/tests`.

A file counts as **swept** only when its comments were read and
updated with commenting rules. Being modified on the branch is not evidence of
that. Skip tests and simple/stub files.

|                  | count |
| ---------------- | ----- |
| Swept            | 164   |
| Remaining        | 0     |
| Total (non-test) | 164   |

## Swept

- [x] apps/api/src/adapters/jwtAdapter.ts
- [x] apps/api/src/adapters/passwordHasher.ts
- [x] apps/api/src/adapters/storage/openSource.ts
- [x] apps/api/src/index.ts
- [x] apps/api/src/lib/config/dedup.ts
- [x] apps/api/src/lib/config/redis.ts
- [x] apps/api/src/lib/fileSignatures.ts
- [x] apps/api/src/lib/http/originCheck.ts
- [x] apps/api/src/lib/http/range.ts
- [x] apps/api/src/lib/http/rateLimits.ts
- [x] apps/api/src/lib/logFileManager.ts
- [x] apps/api/src/lib/logSerializers.ts
- [x] apps/api/src/lib/logger.ts
- [x] apps/api/src/lib/media/archiveTypes.ts
- [x] apps/api/src/lib/media/categoryBreakdown.ts
- [x] apps/api/src/lib/media/contentFilters.ts
- [x] apps/api/src/lib/media/deleteAbort.ts
- [x] apps/api/src/lib/media/derivativePause.ts
- [x] apps/api/src/lib/media/deriveTitle.ts
- [x] apps/api/src/lib/media/extensions.ts
- [x] apps/api/src/lib/media/hashFile.ts
- [x] apps/api/src/lib/media/indexAbort.ts
- [x] apps/api/src/lib/media/indexRoots.ts
- [x] apps/api/src/lib/media/ingestLimits.ts
- [x] apps/api/src/lib/media/ingestWrite.ts
- [x] apps/api/src/lib/media/keys.ts
- [x] apps/api/src/lib/media/matchIdentity.ts
- [x] apps/api/src/lib/media/mimeFromExtension.ts
- [x] apps/api/src/lib/media/processingSupport.ts
- [x] apps/api/src/lib/media/reconcileAbort.ts
- [x] apps/api/src/lib/media/sourceMtime.ts
- [x] apps/api/src/lib/media/storageTreemap.ts
- [x] apps/api/src/lib/media/textSource.ts
- [x] apps/api/src/lib/reminders/constants.ts
- [x] apps/api/src/lib/reminders/overview.ts
- [x] apps/api/src/lib/reminders/recurrence.ts
- [x] apps/api/src/lib/reminders/time.ts
- [x] apps/api/src/lib/resetPassword.ts
- [x] apps/api/src/lib/sidecar/restoreState.ts
- [x] apps/api/src/lib/sidecar/snapshotFormat.ts
- [x] apps/api/src/lib/streams/toBuffer.ts
- [x] apps/api/src/lib/strings/normalize.ts
- [x] apps/api/src/lib/tags/mimeTypeTag.ts
- [x] apps/api/src/lib/tags/normalizeTags.ts
- [x] apps/api/src/lib/tags/rules/defaults.ts
- [x] apps/api/src/lib/tags/rules/evaluateRules.ts
- [x] apps/api/src/lib/tags/rules/fileDate.ts
- [x] apps/api/src/lib/text/detectLanguage.ts
- [x] apps/api/src/lib/text/processTextJob.ts
- [x] apps/api/src/lib/text/segmentText.ts
- [x] apps/api/src/lib/workerStateMachine.ts
- [x] apps/api/src/plugins/config.ts
- [x] apps/api/src/plugins/csrf.ts
- [x] apps/api/src/plugins/derivativeFeeder.ts
- [x] apps/api/src/plugins/derivativeProgress.ts
- [x] apps/api/src/plugins/jwt.ts
- [x] apps/api/src/plugins/mediaServices.ts
- [x] apps/api/src/plugins/preferences.ts
- [x] apps/api/src/plugins/prisma.ts
- [x] apps/api/src/plugins/queueEvents.ts
- [x] apps/api/src/plugins/rateLimit.ts
- [x] apps/api/src/plugins/redis.ts
- [x] apps/api/src/plugins/sidecar.ts
- [x] apps/api/src/plugins/storage.ts
- [x] apps/api/src/queues/enqueueDelete.ts
- [x] apps/api/src/queues/enqueueHash.ts
- [x] apps/api/src/queues/enqueueIndex.ts
- [x] apps/api/src/queues/enqueueOcr.ts
- [x] apps/api/src/queues/enqueueOrganize.ts
- [x] apps/api/src/queues/enqueueReconcile.ts
- [x] apps/api/src/queues/enqueueText.ts
- [x] apps/api/src/queues/enqueueThumbnail.ts
- [x] apps/api/src/queues/enqueueUnpack.ts
- [x] apps/api/src/repositories/bundleRepository.ts
- [x] apps/api/src/repositories/documentRepository.ts
- [x] apps/api/src/repositories/mediaMetadataRepository.ts
- [x] apps/api/src/repositories/mediaRepository.ts
- [x] apps/api/src/repositories/preferencesRepository.ts
- [x] apps/api/src/repositories/profileRepository.ts
- [x] apps/api/src/repositories/sidecarRepository.ts
- [x] apps/api/src/repositories/tagRuleRepository.ts
- [x] apps/api/src/repositories/userRepository.ts
- [x] apps/api/src/routes/auth.ts
- [x] apps/api/src/routes/bundles.ts
- [x] apps/api/src/routes/health.ts
- [x] apps/api/src/routes/ingest.ts
- [x] apps/api/src/routes/init.ts
- [x] apps/api/src/routes/jobs.ts
- [x] apps/api/src/routes/media/archives.ts
- [x] apps/api/src/routes/media/content.ts
- [x] apps/api/src/routes/media/deleteJobs.ts
- [x] apps/api/src/routes/media/derivatives.ts
- [x] apps/api/src/routes/media/duplicates.ts
- [x] apps/api/src/routes/media/events.ts
- [x] apps/api/src/routes/media/indexing.ts
- [x] apps/api/src/routes/media/items.ts
- [x] apps/api/src/routes/media/library.ts
- [x] apps/api/src/routes/media/shared.ts
- [x] apps/api/src/routes/preferences.ts
- [x] apps/api/src/routes/profile.ts
- [x] apps/api/src/routes/reminders.ts
- [x] apps/api/src/routes/server.ts
- [x] apps/api/src/routes/sidecars.ts
- [x] apps/api/src/routes/storage.ts
- [x] apps/api/src/routes/tagRules.ts
- [x] apps/api/src/routes/tags.ts
- [x] apps/api/src/services/archive/extractArchive.ts
- [x] apps/api/src/services/authService.ts
- [x] apps/api/src/services/media/archiveService.ts
- [x] apps/api/src/services/media/dedupService.ts
- [x] apps/api/src/services/media/deleteJobService.ts
- [x] apps/api/src/services/media/derivativeFeeder.ts
- [x] apps/api/src/services/media/derivativeProgress.ts
- [x] apps/api/src/services/media/duplicateTag.ts
- [x] apps/api/src/services/media/indexService.ts
- [x] apps/api/src/services/media/ingestService.ts
- [x] apps/api/src/services/media/jobControlService.ts
- [x] apps/api/src/services/media/mediaActionsService.ts
- [x] apps/api/src/services/media/mediaMetadata.ts
- [x] apps/api/src/services/media/mediaQueryService.ts
- [x] apps/api/src/services/media/mediaReadService.ts
- [x] apps/api/src/services/media/metadata/extractMediaMetadata.ts
- [x] apps/api/src/services/media/metadata/image/exif.ts
- [x] apps/api/src/services/media/metadata/image/extractImageMetadata.ts
- [x] apps/api/src/services/media/metadata/office/extractOfficeMetadata.ts
- [x] apps/api/src/services/media/metadata/pdf/extractPdfMetadata.ts
- [x] apps/api/src/services/media/metadata/sourceBuffer.ts
- [x] apps/api/src/services/media/metadata/textStats.ts
- [x] apps/api/src/services/media/metadata/types.ts
- [x] apps/api/src/services/media/organizeJobService.ts
- [x] apps/api/src/services/media/reconcileService.ts
- [x] apps/api/src/services/ocr/ocrWithOcrmypdf.ts
- [x] apps/api/src/services/ocrProcessingService.ts
- [x] apps/api/src/services/pdf/extractPdfText.ts
- [x] apps/api/src/services/pdf/loadPdfJs.ts
- [x] apps/api/src/services/pdf/shouldFallbackToOcr.ts
- [x] apps/api/src/services/preferencesService.ts
- [x] apps/api/src/services/profileService.ts
- [x] apps/api/src/services/sidecar/sidecarService.ts
- [x] apps/api/src/services/stallDetectionService.ts
- [x] apps/api/src/services/thumb/renderHeicThumbnail.ts
- [x] apps/api/src/services/thumb/renderPdfThumbnail.ts
- [x] apps/api/src/services/thumb/renderVideoThumbnail.ts
- [x] apps/api/src/services/thumb/thumbnailService.ts
- [x] apps/api/src/types/heic-convert.d.ts
- [x] apps/api/src/utils/authGuard.ts
- [x] apps/api/src/worker/configureSharp.ts
- [x] apps/api/src/worker/deleteWorker.ts
- [x] apps/api/src/worker/hashWorker.ts
- [x] apps/api/src/worker/index.ts
- [x] apps/api/src/worker/indexCore.ts
- [x] apps/api/src/worker/indexWalk.ts
- [x] apps/api/src/worker/indexWatcher.ts
- [x] apps/api/src/worker/indexWorker.ts
- [x] apps/api/src/worker/ocr.ts
- [x] apps/api/src/worker/ocrWorker.ts
- [x] apps/api/src/worker/organizeWorker.ts
- [x] apps/api/src/worker/reconcileWorker.ts
- [x] apps/api/src/worker/storageFromEnv.ts
- [x] apps/api/src/worker/text.ts
- [x] apps/api/src/worker/thumb.ts
- [x] apps/api/src/worker/thumbWorker.ts
- [x] apps/api/src/worker/unpackWorker.ts
- [x] apps/api/src/worker/workerPrefs.ts

## Remaining, by directory

None. Every non-test file under `apps/api/src` has been swept.
