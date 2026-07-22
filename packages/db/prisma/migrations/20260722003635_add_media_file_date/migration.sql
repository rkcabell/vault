-- AlterTable
ALTER TABLE "Media" ADD COLUMN     "fileDate" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Media_userId_fileDate_idx" ON "Media"("userId", "fileDate" DESC);
