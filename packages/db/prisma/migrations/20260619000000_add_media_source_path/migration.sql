-- AlterTable
ALTER TABLE "Media" ADD COLUMN "sourcePath" TEXT;

-- CreateIndex
-- NULL sourcePath values are treated as distinct by Postgres, so existing
-- managed rows (all NULL) never collide; this enforces "index a path once per user".
CREATE UNIQUE INDEX "Media_userId_sourcePath_key" ON "Media"("userId", "sourcePath");
