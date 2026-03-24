-- Persist unpack provenance on bundles even when the source archive media is deleted.
ALTER TABLE "Bundle"
  ADD COLUMN "isUnpackedArchive" BOOLEAN NOT NULL DEFAULT false;

-- Persist unpack provenance on media items even when the source archive media is deleted.
ALTER TABLE "Media"
  ADD COLUMN "isExtractedFromArchive" BOOLEAN NOT NULL DEFAULT false;

-- Backfill existing unpack-created bundles.
UPDATE "Bundle"
SET "isUnpackedArchive" = true
WHERE "sourceMediaId" IS NOT NULL;

-- Backfill extracted media while source links still exist.
UPDATE "Media"
SET "isExtractedFromArchive" = true
WHERE "sourceArchiveId" IS NOT NULL;
