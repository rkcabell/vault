-- storageKey was NOT NULL with a fake "sentinel" value written for every
-- in-place indexed row (worker/indexCore.ts: `external/{userId}/{id}/{name}`),
-- since the read seam (adapters/storage/openSource.ts) never actually used it
-- for those rows — it branches on sourcePath first. The sentinel's only job was
-- to make an unbranched read degrade to a clean 404 instead of a 500. That's a
-- landmine: the column being NOT NULL let code build a real-looking path out of
-- a value that was never meant to be read.
--
-- The real invariant is an XOR: exactly one of storageKey (managed upload) /
-- sourcePath (in-place indexed) is ever meaningful for a given row. Backfill
-- runs before the constraint below, or every already-indexed row (still
-- carrying the old sentinel) would violate it immediately.
ALTER TABLE "Media" ALTER COLUMN "storageKey" DROP NOT NULL;
UPDATE "Media" SET "storageKey" = NULL WHERE "sourcePath" IS NOT NULL;

ALTER TABLE "Media" ADD CONSTRAINT "media_source_xor"
  CHECK (("storageKey" IS NULL) <> ("sourcePath" IS NULL));
