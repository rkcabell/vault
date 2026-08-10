-- Give hashing the per-item state column thumb/text already have (see
-- 20260728010000_media_derivative_feeder), so it can move onto the derivative
-- feeder instead of indexing pushing it directly. Same NULL-stamp meaning as
-- thumbQueuedAt/textQueuedAt: never dispatched, still waiting in the backlog.
--
-- UNSUPPORTED here means "no job needed", not "can't be hashed" — a renderable
-- row is hashed inline by the thumb worker as a side effect of rendering it, so
-- an explicit hash job would only be redundant work. Only non-renderable or
-- too-large rows (the ones the thumb worker never touches) ever need PENDING.
ALTER TABLE "Media" ADD COLUMN "hashState" "MediaWorkerState" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "Media" ADD COLUMN "hashQueuedAt" TIMESTAMP(3);

-- Backfill from what's already on each row, so an existing library doesn't
-- suddenly look like a 190k-row hash backlog on upgrade. Duplicates the
-- renderable/size rule in lib/media/processingSupport.ts (thumbnailSupported +
-- exceedsThumbnailSize) in SQL — acceptable only because a migration is frozen
-- once applied and cannot drift; the live rule stays in processingSupport.ts /
-- planDerivations for everything after this point.
UPDATE "Media" SET "hashState" = 'READY' WHERE "contentHash" IS NOT NULL;
UPDATE "Media" SET "hashState" = 'UNSUPPORTED'
 WHERE "contentHash" IS NULL
   AND ("mimeType" = '' OR "mimeType" LIKE 'image/%'
        OR "mimeType" LIKE 'video/%' OR "mimeType" LIKE '%pdf%')
   AND "sizeBytes" <= 2147483648;

-- The feeder's claim and stall detection's sweep both filter state first, stamp
-- second — same rationale as the thumb/text composite indexes.
CREATE INDEX "Media_hashState_hashQueuedAt_idx" ON "Media"("hashState", "hashQueuedAt");
