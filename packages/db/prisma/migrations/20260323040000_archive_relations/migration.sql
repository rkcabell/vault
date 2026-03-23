-- Clean up any stale references before adding FK constraints
UPDATE "Media" SET "linkedBundleId" = NULL
  WHERE "linkedBundleId" IS NOT NULL
  AND "linkedBundleId" NOT IN (SELECT id FROM "Bundle");

UPDATE "Bundle" SET "sourceMediaId" = NULL
  WHERE "sourceMediaId" IS NOT NULL
  AND "sourceMediaId" NOT IN (SELECT id FROM "Media");

-- FK: Media.linkedBundleId -> Bundle.id
ALTER TABLE "Media" ADD CONSTRAINT "Media_linkedBundleId_fkey"
  FOREIGN KEY ("linkedBundleId") REFERENCES "Bundle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- FK: Bundle.sourceMediaId -> Media.id
ALTER TABLE "Bundle" ADD CONSTRAINT "Bundle_sourceMediaId_fkey"
  FOREIGN KEY ("sourceMediaId") REFERENCES "Media"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- New column: Media.sourceArchiveId -> Media.id (self-referential, tracks extraction origin)
ALTER TABLE "Media" ADD COLUMN "sourceArchiveId" TEXT;

ALTER TABLE "Media" ADD CONSTRAINT "Media_sourceArchiveId_fkey"
  FOREIGN KEY ("sourceArchiveId") REFERENCES "Media"("id") ON DELETE SET NULL ON UPDATE CASCADE;
