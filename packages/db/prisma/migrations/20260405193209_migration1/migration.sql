/*
  Warnings:

  - A unique constraint covering the columns `[resetToken]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "document_search_vector_gin";

-- AlterTable
ALTER TABLE "Media" ADD COLUMN     "contentHash" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "resetToken" TEXT,
ADD COLUMN     "resetTokenExpiry" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Media_userId_contentHash_idx" ON "Media"("userId", "contentHash");

-- CreateIndex
CREATE INDEX "Media_userId_createdAt_idx" ON "Media"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Media_userId_title_idx" ON "Media"("userId", "title" ASC);

-- CreateIndex
CREATE INDEX "Media_userId_sizeBytes_idx" ON "Media"("userId", "sizeBytes" DESC);

-- CreateIndex
CREATE INDEX "Media_userId_mimeType_idx" ON "Media"("userId", "mimeType" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "User_resetToken_key" ON "User"("resetToken");
