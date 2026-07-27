-- Move/rename detection for in-place indexed media.
--
-- A move is reported by the OS as an unrelated unlink + add pair, so the watcher
-- used to hard-delete the row and re-index a fresh one, destroying tags, title,
-- starred state, bundle membership, reminders and extracted text. Instead the
-- unlink now tombstones the row via "missingSince" and a later add rematches it.

-- Tombstone marker: non-NULL means the source stopped existing at sourcePath.
ALTER TABLE "Media" ADD COLUMN "missingSince" TIMESTAMP(3);

-- Last known filesystem mtime (epoch ms). Kept separate from "fileDate", which
-- starts as mtime but is upgraded to the embedded EXIF/PDF date and so cannot
-- identify a moved file. DOUBLE PRECISION because epoch ms overflows int4.
ALTER TABLE "Media" ADD COLUMN "sourceMtimeMs" DOUBLE PRECISION;

-- Lets a rematch keep a user-chosen title instead of re-deriving from filename.
ALTER TABLE "Media" ADD COLUMN "titleIsUserEdited" BOOLEAN NOT NULL DEFAULT false;

-- Serves both the rematch lookup (recent tombstones) and the sweeper scan.
CREATE INDEX "Media_userId_missingSince_idx" ON "Media"("userId", "missingSince");

-- Backfill sourceMtimeMs for rows indexed before this column existed, using
-- fileDate where it is still the untouched mtime. Best-effort: rows whose
-- fileDate was upgraded to an EXIF date get a value that will not equal the
-- real mtime of the incoming file. That can only cause a *missed* match, which
-- falls through to the contentHash tier — never a wrong match.
UPDATE "Media"
SET "sourceMtimeMs" = EXTRACT(EPOCH FROM "fileDate") * 1000
WHERE "sourcePath" IS NOT NULL AND "fileDate" IS NOT NULL;
